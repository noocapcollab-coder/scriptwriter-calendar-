// api/add-topic.js — creates a card at stage 1 on a creator's REELS board.
//
// Property names differ board to board, so nothing is hardcoded: the schema is
// read first and the title, status, date and type columns are resolved from it.
// If a column can't be found the request fails with a message naming what was
// missing rather than writing a half-filled card.

import { NOTION, headers, rosterFor, resolveDs } from './_boards.js';

const schemaCache = new Map();

async function schemaOf(ds) {
  const hit = schemaCache.get(ds);
  if (hit && Date.now() - hit.at < 300000) return hit.props;
  const r = await fetch(`${NOTION}/data_sources/${ds}`, { headers: headers() });
  if (!r.ok) throw new Error(`could not read board schema (${r.status})`);
  const j = await r.json();
  const props = j.properties || {};
  schemaCache.set(ds, { at: Date.now(), props });
  return props;
}

function pickTitle(props) {
  for (const k in props) if (props[k].type === 'title') return k;
  return null;
}

function pickDate(props) {
  let fallback = null;
  for (const k in props) {
    if (props[k].type !== 'date') continue;
    if (/post/i.test(k)) return k;
    if (!fallback) fallback = k;
  }
  return fallback;
}

// The status column, plus whichever option is stage 1.
function pickStatus(props) {
  const cands = [];
  for (const k in props) {
    const p = props[k];
    if (p.type !== 'status' && p.type !== 'select') continue;
    const opts = (p.status && p.status.options) || (p.select && p.select.options) || [];
    if (opts.some(o => /^\s*\d{1,2}\s*[-–.]/.test(o.name))) cands.push({ k, type: p.type, opts });
  }
  const c = cands.find(x => /status/i.test(x.k)) || cands[0];
  if (!c) return null;
  const first = c.opts.find(o => /^\s*1\s*[-–.]/.test(o.name));
  return first ? { key: c.k, type: c.type, option: first.name } : null;
}

// The Sponsor / Personal column, matched on its option values.
function pickType(props, want) {
  for (const k in props) {
    const p = props[k];
    if (p.type !== 'select' && p.type !== 'multi_select') continue;
    const opts = (p.select && p.select.options) || (p.multi_select && p.multi_select.options) || [];
    const hit = opts.find(o => new RegExp(want, 'i').test(o.name));
    if (hit) return { key: k, type: p.type, option: hit.name };
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.NOTION_TOKEN) return res.status(500).json({ error: 'NOTION_TOKEN is not set in Vercel' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = {} } }
  body = body || {};

  const title = String(body.title || '').trim().slice(0, 200);
  const creator = String(body.creator || '').trim();
  const date = String(body.date || '').trim();
  const type = body.type === 'Sponsor' ? 'Sponsor' : 'Personal';

  if (!title) return res.status(400).json({ error: 'A title is required' });
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });

  const board = rosterFor(req.query || {}).find(b => b.creator === creator);
  if (!board) return res.status(400).json({ error: `No board found for "${creator}"` });

  try {
    const ds = await resolveDs(board.ds);
    const props = await schemaOf(ds);
    const titleKey = pickTitle(props);
    const status = pickStatus(props);
    if (!titleKey) return res.status(422).json({ error: 'That board has no title column' });
    if (!status) return res.status(422).json({ error: 'Could not find a numbered status option on that board' });

    const properties = {};
    properties[titleKey] = { title: [{ text: { content: title } }] };
    properties[status.key] = status.type === 'status'
      ? { status: { name: status.option } }
      : { select: { name: status.option } };

    const dateKey = date ? pickDate(props) : null;
    if (dateKey) properties[dateKey] = { date: { start: date } };

    const t = pickType(props, type);
    if (t) properties[t.key] = t.type === 'select'
      ? { select: { name: t.option } }
      : { multi_select: [{ name: t.option }] };

    const r = await fetch(`${NOTION}/pages`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        parent: { type: 'data_source_id', data_source_id: ds },
        properties
      })
    });
    const j = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: (j && j.message) || `Notion returned ${r.status}` });

    return res.status(200).json({
      id: j.id,
      creator: board.creator,
      title,
      stage: 1,
      dated: !!dateKey,
      typed: !!t
    });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
