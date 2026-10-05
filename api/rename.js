// api/rename.js — renames a card on a creator's board.
//
// Takes { id, title }. The page is read first so its title column can be found
// by type (names differ per board) and so only cards that live on a board in
// the roster can be renamed, never an arbitrary Notion page.

import { NOTION, headers, rosterFor, resolveDs } from './_boards.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.NOTION_TOKEN) return res.status(500).json({ error: 'NOTION_TOKEN is not set in Vercel' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = {} } }
  body = body || {};

  const title = String(body.title || '').trim().slice(0, 200);
  const hex = String(body.id || '').replace(/-/g, '').toLowerCase();
  if (!title) return res.status(400).json({ error: 'A title is required' });
  if (!/^[0-9a-f]{32}$/.test(hex)) return res.status(400).json({ error: 'Bad card id' });

  try {
    const pr = await fetch(`${NOTION}/pages/${hex}`, { headers: headers() });
    const page = await pr.json();
    if (!pr.ok) return res.status(pr.status).json({ error: (page && page.message) || `Notion returned ${pr.status}` });

    const parent = page.parent || {};
    const parentDs = String(parent.data_source_id || '').replace(/-/g, '');
    const parentDb = String(parent.database_id || '').replace(/-/g, '');
    const roster = rosterFor(req.query || {});
    const allowed = new Set();
    await Promise.all(roster.map(async b => {
      try { allowed.add(String(await resolveDs(b.ds, b.creator)).replace(/-/g, '')); } catch {}
    }));
    if (!allowed.has(parentDs) && !allowed.has(parentDb)) {
      return res.status(403).json({ error: 'That card is not on one of the creator boards' });
    }

    const props = page.properties || {};
    const titleKey = Object.keys(props).find(k => props[k] && props[k].type === 'title');
    if (!titleKey) return res.status(422).json({ error: 'That card has no title column' });

    const r = await fetch(`${NOTION}/pages/${hex}`, {
      method: 'PATCH', headers: headers(),
      body: JSON.stringify({ properties: { [titleKey]: { title: [{ text: { content: title } }] } } })
    });
    const j = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: (j && j.message) || `Notion returned ${r.status}` });
    return res.status(200).json({ id: j.id, title });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
