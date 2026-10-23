// api/scripts.js — feeds scripts.html
//
// Reads every creator REELS board straight from its source data source,
// returns one flat list of videos plus a measured post rate per creator.
// Property names differ per board, so nothing is hardcoded: the title comes
// from whichever property is type 'title', status from type 'status' OR
// 'select', and the post date from the first date property whose name
// mentions "post" (falling back to any date property).

import { NOTION, BOARDS, headers, rosterFor, resolveDs, notionFetch } from './_boards.js';
import { snapshotRows } from './_snapshot.js';

// Leave a creator out to measure their rate from the last 4 weeks of posts.
// Put a number here to pin it instead (contracted output, new creator, etc).
const PINNED_RATE = {};

// Script deadlines come from the weekly cycle, worked out in the page.
const cache = new Map();

function findByType(props, type) {
  for (const k in props) if (props[k] && props[k].type === type) return props[k];
  return null;
}

function findStatus(props) {
  for (const k in props) {
    const p = props[k];
    if (!p) continue;
    if ((p.type === 'status' || p.type === 'select') && /status/i.test(k)) return p;
  }
  return findByType(props, 'status') || findByType(props, 'select');
}

function findPostDate(props, prefer) {
  // A board that names its date column uses only that column, so a stale
  // value in some other date field can't leak onto the calendar.
  if (prefer && props[prefer] && props[prefer].type === 'date') {
    const d = props[prefer].date;
    return d && d.start ? d.start : null;
  }
  let fallback = null;
  for (const k in props) {
    const p = props[k];
    if (!p || p.type !== 'date' || !p.date || !p.date.start) continue;
    if (/post/i.test(k)) return p.date.start;
    if (!fallback) fallback = p.date.start;
  }
  return fallback;
}

// Every select / multi-select value on the card. Property names differ per
// board, so tags get matched by value rather than by column name.
function tagsOf(props) {
  const out = [];
  for (const k in props) {
    const p = props[k];
    if (!p) continue;
    if (p.type === 'select' && p.select && p.select.name) out.push(p.select.name);
    else if (p.type === 'multi_select' && Array.isArray(p.multi_select))
      for (const x of p.multi_select) if (x && x.name) out.push(x.name);
  }
  return out;
}

function findKind(tags) {
  for (const v of tags) {
    if (/sponsor/i.test(v)) return 'Sponsor';
    if (/personal/i.test(v)) return 'Personal';
  }
  return null;
}

// Short vs long form. Widen these patterns if a board uses different wording —
// hit /api/scripts and look at the tagVocab list to see what is actually there.
function findFormat(tags) {
  for (const v of tags) {
    if (/\b(long[\s-]?form|long|youtube|yt|podcast)\b/i.test(v)) return 'Long';
    if (/\b(short[\s-]?form|shorts?|reels?|tiktok)\b/i.test(v)) return 'Short';
  }
  return null;
}

function titleOf(props) {
  const t = findByType(props, 'title');
  if (!t || !t.title || !t.title.length) return '';
  return t.title.map(x => x.plain_text).join('').trim();
}

function stageOf(label) {
  if (!label) return null;
  if (/archive/i.test(label)) return 'archive';
  const m = String(label).match(/^\s*(\d{1,2})/);
  return m ? parseInt(m[1], 10) : null;
}

// Only cards edited in the last 120 days are fetched. Old posted videos make
// up most of each board and nothing on the page needs them, so this cuts the
// number of Notion pages per board (and so the calls) by a lot.
const WINDOW_DAYS = 120;

// Built-in ids are already data source ids, so query them straight away and
// only fall back to the slower resolveDs lookup if Notion says no.
const goodDs = new Map();

async function queryPage(ds, cursor) {
  const since = new Date(Date.now() - WINDOW_DAYS * 864e5).toISOString();
  const body = {
    page_size: 100,
    filter: { timestamp: 'last_edited_time', last_edited_time: { on_or_after: since } }
  };
  if (cursor) body.start_cursor = cursor;
  return notionFetch(`${NOTION}/data_sources/${ds}/query`, {
    method: 'POST', headers: headers(), body: JSON.stringify(body)
  });
}

async function errorOf(r) {
  let msg = `${r.status}`;
  try { const e = await r.json(); if (e && e.message) msg = e.message.split('.')[0]; } catch {}
  return new Error(msg);
}

function toVideo(page, board) {
  if (page.archived || page.in_trash) return null;
      const props = page.properties || {};
      const label = (() => {
        const s = findStatus(props);
        if (!s) return null;
        return s.status ? s.status.name : (s.select ? s.select.name : null);
      })();
      const stage = stageOf(label);
      if (stage === null || stage === 'archive') return null;
      const title = titleOf(props);
      if (!title) return null;
      const tags = tagsOf(props);
      return {
        id: page.id,
        creator: board.creator,
        title,
        stage,
        stageLabel: label,
        kind: findKind(tags),
        format: findFormat(tags) || board.format || 'Short',
        tags,
        postDate: findPostDate(props, board.dateProp)
      };
}

async function queryBoard(board, fresh) {
  // The shared snapshot already has this board: use it and leave Notion alone (an edit's fresh pull skips it)
  const snap = fresh ? null : await snapshotRows(board.ds);
  if (snap) {
    const since = Date.now() - WINDOW_DAYS * 864e5;
    return snap.filter((p) => Date.parse(p.last_edited_time) >= since).map((p) => toVideo(p, board)).filter(Boolean);
  }
  const out = [];
  let ds = goodDs.get(board.ds) || board.ds;
  let r = await queryPage(ds);
  if (!r.ok && (r.status === 404 || r.status === 400) && !goodDs.has(board.ds)) {
    ds = await resolveDs(board.ds, board.creator);
    r = await queryPage(ds);
  }
  for (;;) {
    if (!r.ok) throw await errorOf(r);
    goodDs.set(board.ds, ds);
    const j = await r.json();
    for (const page of j.results || []) { const v = toVideo(page, board); if (v) out.push(v); }
    if (!j.has_more) break;
    r = await queryPage(ds, j.next_cursor);
  }
  return out;
}

function measureRates(videos, roster) {
  const now = Date.now();
  const windowMs = 28 * 864e5;
  const counts = {};
  for (const v of videos) {
    // Sponsor dates move around, so they don't set the cadence.
    if (v.kind === 'Sponsor') continue;
    if (v.stage !== 12 || !v.postDate) continue;
    const t = new Date(v.postDate).getTime();
    if (isNaN(t) || t > now || now - t > windowMs) continue;
    counts[v.creator] = (counts[v.creator] || 0) + 1;
  }
  const rates = {};
  for (const b of roster) {
    if (PINNED_RATE[b.creator] !== undefined) { rates[b.creator] = PINNED_RATE[b.creator]; continue; }
    const n = counts[b.creator] || 0;
    rates[b.creator] = n ? Math.round((n / 4) * 2) / 2 : 1;
  }
  return rates;
}

// The last good result for each board. If Notion rate limits one board, the
// page shows that board's last copy instead of dropping it.
const lastGood = new Map();
// Requests that arrive while a sync is running wait for it instead of
// starting their own.
const inflight = new Map();
// A forced refresh (after an edit, or the Reload button) still reuses a sync
// that is only a few seconds old.
const FRESH_FLOOR_MS = 8000;
const CACHE_MS = 30000;

async function sync(roster, ckey, fresh) {
  const chunks = [];
  // One board at a time: notionFetch spaces the calls, and running boards in
  // parallel only creates bursts that trip the limit.
  for (const b of roster) {
    try {
      const videos = await queryBoard(b, fresh);
      lastGood.set(b.ds, { at: Date.now(), videos });
      chunks.push({ videos });
    } catch (e) {
      const old = lastGood.get(b.ds);
      chunks.push(old
        ? { videos: old.videos, stale: b.creator }
        : { err: b.creator + ' — ' + e.message });
    }
  }
  const videos = [], problems = [], stale = [];
  for (const c of chunks) {
    if (c.err) problems.push(c.err);
    else { videos.push(...c.videos); if (c.stale) stale.push(c.stale); }
  }
  const vocab = {};
  for (const v of videos) for (const t of (v.tags || [])) vocab[t] = (vocab[t] || 0) + 1;
  const payload = {
    videos,
    tagVocab: Object.entries(vocab).sort((a, b) => b[1] - a[1]).slice(0, 60),
    rates: measureRates(videos, roster),
    creators: roster.map(b => b.creator),
    formats: Object.fromEntries(roster.map(b => [b.creator, b.format || 'Short'])),
    builtIn: BOARDS.map(b => b.creator),
    problems,
    stale,
    syncedAt: new Date().toISOString()
  };
  if (cache.size > 12) cache.clear();
  cache.set(ckey, { at: Date.now(), payload });
  return payload;
}

export default async function handler(req, res) {
  const query = req.query || {};
  const fresh = query.fresh === '1';
  const roster = rosterFor(query);
  const ckey = roster.map(b => b.ds).join('|');

  // Normal polls can be served by Vercel's edge cache, so many open tabs
  // share one sync instead of each hitting Notion.
  res.setHeader('Cache-Control', fresh
    ? 'no-store'
    : 's-maxage=30, stale-while-revalidate=300');

  const hit = cache.get(ckey);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit && (fresh ? age < FRESH_FLOOR_MS : age < CACHE_MS)) {
    res.setHeader('x-cache', 'hit');
    return res.status(200).json(hit.payload);
  }

  if (!process.env.NOTION_TOKEN) {
    return res.status(500).json({ error: 'NOTION_TOKEN is not set in Vercel' });
  }

  try {
    let p = inflight.get(ckey);
    if (!p) {
      p = sync(roster, ckey, fresh).finally(() => inflight.delete(ckey));
      inflight.set(ckey, p);
    }
    const payload = await p;
    res.setHeader('x-cache', 'miss');
    return res.status(200).json(payload);
  } catch (e) {
    if (hit) return res.status(200).json(hit.payload);
    return res.status(500).json({ error: String(e && e.message || e) });
  }
}
