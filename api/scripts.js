// api/scripts.js — feeds scripts.html
//
// Reads every creator REELS board straight from its source data source,
// returns one flat list of videos plus a measured post rate per creator.
// Property names differ per board, so nothing is hardcoded: the title comes
// from whichever property is type 'title', status from type 'status' OR
// 'select', and the post date from the first date property whose name
// mentions "post" (falling back to any date property).

import { NOTION, BOARDS, headers, rosterFor, resolveDs } from './_boards.js';

// Leave a creator out to measure their rate from the last 4 weeks of posts.
// Put a number here to pin it instead (contracted output, new creator, etc).
const PINNED_RATE = {};

// Script deadlines come from the weekly cycle, worked out in the page.
let cache = new Map();

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

function findPostDate(props) {
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

async function queryBoard(board) {
  const out = [];
  const ds = await resolveDs(board.ds, board.creator);
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const r = await fetch(`${NOTION}/data_sources/${ds}/query`, {
      method: 'POST', headers: headers(), body: JSON.stringify(body)
    });
    if (!r.ok) {
      let msg = `${r.status}`;
      try { const e = await r.json(); if (e && e.message) msg = e.message.split('.')[0]; } catch {}
      throw new Error(msg);
    }
    const j = await r.json();
    for (const page of j.results || []) {
      if (page.archived || page.in_trash) continue;
      const props = page.properties || {};
      const label = (() => {
        const s = findStatus(props);
        if (!s) return null;
        return s.status ? s.status.name : (s.select ? s.select.name : null);
      })();
      const stage = stageOf(label);
      if (stage === null || stage === 'archive') continue;
      const title = titleOf(props);
      if (!title) continue;
      const tags = tagsOf(props);
      out.push({
        id: page.id,
        creator: board.creator,
        title,
        stage,
        stageLabel: label,
        kind: findKind(tags),
        format: findFormat(tags) || board.format || 'Short',
        tags,
        postDate: findPostDate(props)
      });
    }
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);
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

export default async function handler(req, res) {
  const query = req.query || {};
  const fresh = query.fresh === '1';
  const roster = rosterFor(query);
  const ckey = roster.map(b => b.ds).join('|');

  const hit = cache.get(ckey);
  if (!fresh && hit && Date.now() - hit.at < 20000) {
    res.setHeader('x-cache', 'hit');
    return res.status(200).json(hit.payload);
  }

  if (!process.env.NOTION_TOKEN) {
    return res.status(500).json({ error: 'NOTION_TOKEN is not set in Vercel' });
  }

  try {
    const chunks = await Promise.all(roster.map(b =>
      queryBoard(b).catch(e => ({ __err: b.creator + ' — ' + e.message }))
    ));
    const videos = [];
    const problems = [];
    for (const c of chunks) {
      if (c && c.__err) problems.push(c.__err); else videos.push(...c);
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
      syncedAt: new Date().toISOString()
    };
    if (cache.size > 12) cache.clear();
    cache.set(ckey, { at: Date.now(), payload });
    res.setHeader('x-cache', 'miss');
    return res.status(200).json(payload);
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message || e) });
  }
}
