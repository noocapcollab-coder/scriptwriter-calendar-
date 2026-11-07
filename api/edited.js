// api/edited.js — "videos edited this week" for the This week card.
//
// A video counts once, on the day its first cut went for review (the earlier of
// Sent For Review At and Draft Submitted At in EDIT TRACKER). Sponsor edits that
// never got logged in EDIT TRACKER are picked up from the creator boards: a
// sponsor card with an editor, sitting at 9 (Approval), that was
// touched this week and has no matching EDIT TRACKER row. Cards sitting at
// 8 (Changes) are revision rounds on an earlier cut, so they don't count. Those are flagged as
// "not logged" so the team can see what skipped the tracker.

import { NOTION, BOARDS, headers, notionFetch } from './_boards.js';
import { snapshotRows } from './_snapshot.js';

const TRACKER_DS = '8fceee86-cd0d-4045-9b4f-33363fcd25c1';
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map();

function plain(p) {
  if (!p) return '';
  switch (p.type) {
    case 'title': return (p.title || []).map(x => x.plain_text).join('').trim();
    case 'rich_text': return (p.rich_text || []).map(x => x.plain_text).join('').trim();
    case 'select': return p.select ? p.select.name : '';
    case 'status': return p.status ? p.status.name : '';
    case 'multi_select': return (p.multi_select || []).map(x => x.name).join(', ');
    case 'people': return (p.people || []).map(x => x.name || '').filter(Boolean).join(', ');
    case 'date': return p.date && p.date.start ? p.date.start : '';
    default: return '';
  }
}
function titleOf(props) {
  for (const k in props) if (props[k] && props[k].type === 'title') return plain(props[k]);
  return '';
}
function byName(props, re, types) {
  for (const k in props) {
    const p = props[k];
    if (p && re.test(k) && (!types || types.includes(p.type))) return p;
  }
  return null;
}
// Titles in EDIT TRACKER and on the boards differ slightly ("× Lindsay", HTML
// leftovers, punctuation), so compare a normalised stem.
function stem(t) {
  return String(t || '').replace(/<[^>]+>/g, ' ').toLowerCase()
    .replace(/[×x]\s*(brad|chris|lindsay|duncan|valeri\w*|david\w*|nicole|emtech)\b.*/i, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
function sameVideo(a, b) {
  const x = stem(a), y = stem(b);
  if (!x || !y) return false;
  return x === y || (x.length >= 5 && y.startsWith(x)) || (y.length >= 5 && x.startsWith(y));
}
function stageOf(label) {
  const m = String(label || '').match(/^\s*(\d{1,2})/);
  return m ? parseInt(m[1], 10) : null;
}
function isSponsor(props) {
  for (const k in props) {
    const p = props[k];
    if (!p) continue;
    const v = p.type === 'select' ? plain(p) : p.type === 'multi_select' ? plain(p) : '';
    if (/sponsor/i.test(v)) return true;
  }
  return false;
}

async function queryAll(ds, filter) {
  const out = [];
  let cursor;
  for (let i = 0; i < 10; i++) {
    const body = { page_size: 100, filter };
    if (cursor) body.start_cursor = cursor;
    const r = await notionFetch(`${NOTION}/data_sources/${ds}/query`, {
      method: 'POST', headers: headers(), body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`Notion ${r.status}`);
    const j = await r.json();
    out.push(...(j.results || []));
    if (!j.has_more) break;
    cursor = j.next_cursor;
  }
  return out;
}

const NO_TRACKER = new Set(['AI Learns']);

async function boardRows(board, sinceISO) {
  const snap = await snapshotRows(board.ds);
  if (snap) return snap.filter(p => p.last_edited_time >= sinceISO);
  return queryAll(board.ds, { timestamp: 'last_edited_time', last_edited_time: { on_or_after: sinceISO } });
}

async function build(fromDay) {
  const fromISO = new Date(fromDay + 'T00:00:00+05:30').toISOString();
  const toISO = new Date(Date.parse(fromISO) + 7 * 864e5).toISOString();

  // 1. EDIT TRACKER
  const rows = await queryAll(TRACKER_DS, { or: [
    { property: 'Sent For Review At', date: { on_or_after: fromISO } },
    { property: 'Draft Submitted At', date: { on_or_after: fromISO } }
  ] });
  const tracker = [];
  for (const p of rows) {
    if (p.archived || p.in_trash) continue;
    const pr = p.properties || {};
    const times = [plain(pr['Sent For Review At']), plain(pr['Draft Submitted At'])].filter(Boolean).map(Date.parse);
    if (!times.length) continue;
    const first = Math.min(...times);
    if (first < Date.parse(fromISO) || first >= Date.parse(toISO)) continue;
    if (/nicole/i.test(plain(pr['Creator']))) continue; // no longer a client (7 Nov 2026)
    tracker.push({
      title: titleOf(pr),
      creator: plain(pr['Creator']),
      editor: plain(pr['Editor']),
      sponsor: /sponsor/i.test(plain(pr['TYPE'])),
      long: /long/i.test(plain(pr['CONTENT TYPE'])),
      at: new Date(first).toISOString(),
      id: p.id
    });
  }

  // 2. Creator boards: sponsor cards (to fix mislabelled tracker rows) and
  //    sponsor edits that never reached EDIT TRACKER.
  const sinceBoards = new Date(Date.parse(fromISO) - 30 * 864e5).toISOString();
  const sponsorTitles = [];
  const untracked = [];
  const problems = [];
  const boardEdited = [];
  for (const b of BOARDS) {
    let list;
    try { list = await boardRows(b, sinceBoards); }
    catch (e) { problems.push(b.creator + ': ' + e.message); continue; }
    for (const p of list) {
      if (p.archived || p.in_trash) continue;
      const pr = p.properties || {};
      // Boards whose editors never log in EDIT TRACKER (AI Learns): a card counts as edited this week when it
      // reached 9 or later and its post date falls in the week (Harsh, Nov 7: "add AI Learns in this")
      if (NO_TRACKER.has(b.creator)) {
        const stP = byName(pr, /status/i, ['status', 'select']) || Object.values(pr).find(x => x && x.type === 'status');
        const st = stageOf(plain(stP));
        const dateP = Object.entries(pr).find(([k, x]) => x && x.type === 'date' && /post/i.test(k) && x.date && x.date.start);
        const pd = dateP ? Date.parse(dateP[1].date.start.length === 10 ? dateP[1].date.start + 'T12:00:00+05:30' : dateP[1].date.start) : NaN;
        const t = titleOf(pr);
        if (t && st >= 9 && st <= 12 && pd >= Date.parse(fromISO) && pd < Date.parse(toISO)) {
          boardEdited.push({ title: t, creator: b.creator, editor: plain(byName(pr, /editor/i)), sponsor: isSponsor(pr), long: false, at: null, id: p.id, fromBoard: true });
        }
        continue;
      }
      if (!isSponsor(pr)) continue;
      const title = titleOf(pr);
      if (!title) continue;
      sponsorTitles.push(title);
      const statusP = byName(pr, /status/i, ['status', 'select']) ||
        Object.values(pr).find(x => x && x.type === 'status');
      const stage = stageOf(plain(statusP));
      const editor = plain(byName(pr, /editor/i));
      if (stage === 9 && editor && p.last_edited_time >= fromISO &&
          !tracker.some(t => sameVideo(t.title, title))) {
        untracked.push({ creator: b.creator, title, editor, stage, id: p.id });
      }
    }
  }
  for (const t of tracker) if (!t.sponsor && sponsorTitles.some(s => sameVideo(s, t.title))) t.sponsor = true;
  tracker.push(...boardEdited);

  const tidy = s => { s = String(s || '').trim(); return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : ''; };
  const byEditor = {};
  for (const t of tracker) { const e = tidy(t.editor) || 'Unassigned'; byEditor[e] = (byEditor[e] || 0) + 1; }
  for (const u of untracked) { const e = tidy(u.editor); byEditor[e] = (byEditor[e] || 0) + 1; }

  const long = tracker.filter(t => t.long).length;
  const sponsor = tracker.filter(t => t.sponsor && !t.long).length + untracked.length;
  const total = tracker.length + untracked.length;
  return {
    from: fromDay,
    total,
    personal: total - sponsor - long,
    sponsor,
    long,
    inTracker: tracker.length,
    untracked,
    // every edited video, so the page can list them when the number is clicked
    videos: tracker.map(t => ({ id: t.id, title: t.title, creator: t.creator, editor: tidy(t.editor), kind: t.long ? 'Long' : t.sponsor ? 'Sponsor' : 'Personal', at: t.at }))
      .concat(untracked.map(u => ({ id: u.id, title: u.title, creator: u.creator, editor: tidy(u.editor), kind: 'Sponsor', at: null, untracked: true }))),
    byEditor,
    problems,
    syncedAt: new Date().toISOString()
  };
}

export default async function handler(req, res) {
  const q = req.query || {};
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : null;
  if (!from) return res.status(400).json({ error: 'from=YYYY-MM-DD (Monday) is required' });
  if (!process.env.NOTION_TOKEN) return res.status(500).json({ error: 'NOTION_TOKEN is not set in Vercel' });
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
  const hit = cache.get(from);
  if (hit && Date.now() - hit.at < CACHE_MS && q.fresh !== '1') return res.status(200).json(hit.payload);
  try {
    const payload = await build(from);
    cache.set(from, { at: Date.now(), payload });
    return res.status(200).json(payload);
  } catch (e) {
    if (hit) return res.status(200).json(hit.payload);
    return res.status(500).json({ error: String(e && e.message || e) });
  }
}
