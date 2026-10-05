// api/rename.js — renames a card on a creator's board. Takes { id, title }.
// The title column is found by type, since names differ per board.

import { NOTION, headers, loadRosterCard } from './_boards.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.NOTION_TOKEN) return res.status(500).json({ error: 'NOTION_TOKEN is not set in Vercel' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = {} } }
  body = body || {};
  const title = String(body.title || '').trim().slice(0, 200);
  if (!title) return res.status(400).json({ error: 'A title is required' });

  try {
    const { page, hex } = await loadRosterCard(body.id, req.query);
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
    return res.status(e.status || 500).json({ error: String((e && e.message) || e) });
  }
}
