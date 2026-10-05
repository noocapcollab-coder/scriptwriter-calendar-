// api/card.js — read and edit one card's status and script body.
//
// GET  ?id=…  → { status, statusOptions, body, readOnly, reason, flattens }
// POST { id, status?, body? } → writes whichever of the two was sent.
//
// The body is shown as plain text with light markdown (#, -, 1., [ ], >, ---)
// so it round-trips through a textarea. Pages holding anything a textarea
// can't carry (images, toggles, embeds, nested blocks, child databases) come
// back readOnly, so saving can never wipe them. New blocks are appended before
// the old ones are removed, so a failure part-way leaves a duplicate, never a
// blank page.

import { NOTION, headers, loadRosterCard } from './_boards.js';

const TEXT_TYPES = {
  paragraph: '', heading_1: '# ', heading_2: '## ', heading_3: '### ',
  bulleted_list_item: '- ', numbered_list_item: '1. ', to_do: '', quote: '> '
};

function statusPropOf(props) {
  const keys = Object.keys(props).filter(k => props[k] && (props[k].type === 'status' || props[k].type === 'select'));
  return keys.find(k => /status/i.test(k)) || keys.find(k => props[k].type === 'status') || null;
}

async function childrenOf(id) {
  const out = [];
  let cursor;
  do {
    const u = `${NOTION}/blocks/${id}/children?page_size=100` + (cursor ? `&start_cursor=${cursor}` : '');
    const r = await fetch(u, { headers: headers() });
    const j = await r.json();
    if (!r.ok) throw Object.assign(new Error(j.message || `Notion returned ${r.status}`), { status: r.status });
    out.push(...(j.results || []));
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);
  return out;
}

function toText(blocks) {
  const lines = [];
  const unsupported = new Set();
  let flattens = false;
  for (const b of blocks) {
    if (b.type === 'divider') { lines.push('---'); continue; }
    if (!(b.type in TEXT_TYPES) || b.has_children) { unsupported.add(b.has_children ? b.type + ' with nested content' : b.type.replace(/_/g, ' ')); continue; }
    const data = b[b.type] || {};
    const rt = data.rich_text || [];
    for (const t of rt) {
      const a = t.annotations || {};
      if (a.bold || a.italic || a.strikethrough || a.underline || a.code || (t.text && t.text.link) || t.type !== 'text') flattens = true;
    }
    const txt = rt.map(t => t.plain_text || '').join('');
    const prefix = b.type === 'to_do' ? (data.checked ? '[x] ' : '[ ] ') : TEXT_TYPES[b.type];
    lines.push(prefix + txt);
  }
  return { text: lines.join('\n'), unsupported: [...unsupported], flattens };
}

function rich(s) {
  const out = [];
  for (let i = 0; i < s.length; i += 1900) out.push({ type: 'text', text: { content: s.slice(i, i + 1900) } });
  return out;
}

function toBlocks(text) {
  return String(text).replace(/\r\n/g, '\n').split('\n').map(line => {
    let m;
    if (/^---\s*$/.test(line)) return { object: 'block', type: 'divider', divider: {} };
    if ((m = line.match(/^(#{1,3}) (.*)$/))) { const t = 'heading_' + m[1].length; return { object: 'block', type: t, [t]: { rich_text: rich(m[2]) } }; }
    if ((m = line.match(/^[-*] (.*)$/))) return { object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: rich(m[1]) } };
    if ((m = line.match(/^\d+\. (.*)$/))) return { object: 'block', type: 'numbered_list_item', numbered_list_item: { rich_text: rich(m[1]) } };
    if ((m = line.match(/^\[( |x|X)\] (.*)$/))) return { object: 'block', type: 'to_do', to_do: { rich_text: rich(m[2]), checked: m[1] !== ' ' } };
    if ((m = line.match(/^> (.*)$/))) return { object: 'block', type: 'quote', quote: { rich_text: rich(m[1]) } };
    return { object: 'block', type: 'paragraph', paragraph: { rich_text: rich(line) } };
  });
}

async function readCard(id, query) {
  const { page, ds, hex } = await loadRosterCard(id, query);
  const props = page.properties || {};
  const sKey = statusPropOf(props);
  let status = null, statusOptions = [];
  if (sKey) {
    const p = props[sKey];
    status = p.type === 'status' ? (p.status && p.status.name) : (p.select && p.select.name);
    const sr = await fetch(`${NOTION}/data_sources/${ds}`, { headers: headers() });
    const sj = await sr.json().catch(() => ({}));
    const def = ((sj.properties || {})[sKey]) || {};
    statusOptions = ((def.status && def.status.options) || (def.select && def.select.options) || []).map(o => o.name);
  }
  const blocks = await childrenOf(hex);
  const { text, unsupported, flattens } = toText(blocks);
  return { page, hex, sKey, status, statusOptions, blocks, text, unsupported, flattens };
}

export default async function handler(req, res) {
  if (!process.env.NOTION_TOKEN) return res.status(500).json({ error: 'NOTION_TOKEN is not set in Vercel' });
  try {
    if (req.method === 'GET') {
      const c = await readCard((req.query || {}).id, req.query);
      return res.status(200).json({
        status: c.status, statusOptions: c.statusOptions, body: c.text,
        readOnly: c.unsupported.length > 0,
        reason: c.unsupported.length ? 'This page has ' + c.unsupported.join(', ') + ', so edit the script in Notion.' : '',
        flattens: c.flattens
      });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only' });

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = {} } }
    body = body || {};
    const c = await readCard(body.id, req.query);
    const done = {};

    if (typeof body.status === 'string' && body.status !== c.status) {
      if (!c.sKey) return res.status(422).json({ error: 'That card has no status column' });
      if (!c.statusOptions.includes(body.status)) return res.status(400).json({ error: `"${body.status}" is not a status on that board` });
      const type = c.page.properties[c.sKey].type;
      const r = await fetch(`${NOTION}/pages/${c.hex}`, {
        method: 'PATCH', headers: headers(),
        body: JSON.stringify({ properties: { [c.sKey]: type === 'status' ? { status: { name: body.status } } : { select: { name: body.status } } } })
      });
      const j = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: (j && j.message) || `Notion returned ${r.status}` });
      done.status = body.status;
    }

    if (typeof body.body === 'string' && body.body !== c.text) {
      if (c.unsupported.length) return res.status(409).json({ error: 'This page has content the editor can\'t hold, so edit it in Notion' });
      const fresh = body.body.length > 50000 ? null : toBlocks(body.body.replace(/\n+$/, ''));
      if (!fresh) return res.status(400).json({ error: 'That script is too long to save from here' });
      for (let i = 0; i < fresh.length; i += 100) {
        const r = await fetch(`${NOTION}/blocks/${c.hex}/children`, {
          method: 'PATCH', headers: headers(), body: JSON.stringify({ children: fresh.slice(i, i + 100) })
        });
        const j = await r.json();
        if (!r.ok) return res.status(r.status).json({ error: (j && j.message) || `Notion returned ${r.status}` });
      }
      for (const b of c.blocks) {
        await fetch(`${NOTION}/blocks/${b.id}`, { method: 'DELETE', headers: headers() });
      }
      done.body = true;
    }
    return res.status(200).json({ ok: true, ...done });
  } catch (e) {
    return res.status(e.status || 500).json({ error: String((e && e.message) || e) });
  }
}
