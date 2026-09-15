// Shared by api/scripts.js and api/add-topic.js so the roster can never drift
// between reading and writing. Files prefixed with _ are not routed by Vercel.

export const NOTION = 'https://api.notion.com/v1';
export const VERSION = '2025-09-03';

// format is a property of the board: REELS boards are short form throughout.
// Add a long-form YouTube board through the page's Creators panel.
export const BOARDS = [
  { creator: 'Brad',    ds: '28b508e9-9dda-81ba-8d7f-000b84b83fbd', format: 'Short' },
  { creator: 'Chris',   ds: '2a1508e9-9dda-8125-bd63-000bb75578dd', format: 'Short' },
  { creator: 'Lindsay', ds: '301508e9-9dda-811b-83c7-000b46be09b1', format: 'Short' },
  { creator: 'Emtech',  ds: '328508e9-9dda-8000-b3c9-000b0d791507', format: 'Short' },
  { creator: 'Duncan',  ds: '328508e9-9dda-8186-b4ca-000bd212e84b', format: 'Short' },
  { creator: 'Valeri',  ds: 'f0dbec00-505d-4e16-8e51-b2fcfea21445', format: 'Short' },
  // These two are dashboard page ids, not board ids — resolveDs looks inside
  // the page and picks the REELS board out of it.
  { creator: 'Nicole',    ds: '62d508e9-9dda-8376-be56-815c11dcacdc', format: 'Short' },
  { creator: 'David Iya', ds: 'a7d508e9-9dda-82d2-bb80-0166574f4246', format: 'Short' }
];

export function headers() {
  return {
    'Authorization': 'Bearer ' + process.env.NOTION_TOKEN,
    'Notion-Version': VERSION,
    'Content-Type': 'application/json'
  };
}

// "Name:id:Long" from the page's own roster editor. Ids are normalised and
// format-checked; anything malformed is dropped rather than queried.
export function parseExtra(raw) {
  if (!raw) return [];
  return String(raw).split(',').slice(0, 12).map(pair => {
    const i = pair.indexOf(':');
    if (i < 1) return null;
    const creator = pair.slice(0, i).trim().slice(0, 40);
    const rest = pair.slice(i + 1).trim().split(':');
    const hex = rest[0].replace(/-/g, '').toLowerCase();
    const format = /^long$/i.test(rest[1] || '') ? 'Long' : 'Short';
    if (!creator || !/^[0-9a-f]{32}$/.test(hex)) return null;
    const ds = [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
    return { creator, ds, format };
  }).filter(Boolean);
}

export function rosterFor(query) {
  const hidden = String(query.hide || '').split(',').map(x => x.trim()).filter(Boolean);
  const extra = parseExtra(query.extra);
  const seenDs = new Set();
  const seenName = new Set();
  // Built-in entries come first, so a hand-added duplicate of the same creator
  // loses rather than appearing twice.
  return BOARDS.concat(extra)
    .filter(b => !hidden.includes(b.creator))
    .filter(b => {
      const name = b.creator.trim().toLowerCase();
      if (seenDs.has(b.ds) || seenName.has(name)) return false;
      seenDs.add(b.ds); seenName.add(name); return true;
    });
}


// Notion has two ids per database: the database id you get from a page link,
// and the data source id the query endpoint actually wants. Pasting the wrong
// one is the usual cause of a 404, so resolve it rather than making the user
// hunt for it: try the id as given, and if it isn't a data source, ask the
// databases endpoint which data source belongs to it.
const dsCache = new Map();

export async function resolveDs(id, creator) {
  const hit = dsCache.get(id);
  if (hit) return hit;

  const direct = await fetch(`${NOTION}/data_sources/${id}`, { headers: headers() });
  if (direct.ok) { dsCache.set(id, id); return id; }

  // Might be a database id. Only take it if it actually names a data source —
  // a page id can come back 200 here with nothing useful on it, so a miss
  // falls through to the page walk rather than giving up.
  const asDb = await fetch(`${NOTION}/databases/${id}`, { headers: headers() });
  if (asDb.ok) {
    const j = await asDb.json().catch(() => ({}));
    const first = (j.data_sources || [])[0];
    if (first && first.id) { dsCache.set(id, first.id); return first.id; }
  }

  // Otherwise treat it as a dashboard page and look inside for a board,
  // preferring one whose title mentions REELS.
  const probe = await fetch(`${NOTION}/blocks/${id}/children?page_size=1`, { headers: headers() });
  if (!probe.ok) {
    throw new Error(probe.status === 404
      ? 'the integration cannot see that page or board — open it in Notion, ' +
        'then ••• → Connections → add the NOOCAP Ops Dashboard integration'
      : `could not read that page (${probe.status})`);
  }

  const inside = await databaseInsidePage(id);
  if (inside) {
    const resolved = await resolveDs(inside, creator);
    dsCache.set(id, resolved);
    return resolved;
  }

  const searched = await findBoardByName(creator);
  if (searched && searched !== id) {
    const resolved = await resolveDs(searched, null);
    dsCache.set(id, resolved);
    return resolved;
  }

  throw new Error('that page opened fine but the board on it is a linked "View of…" copy, ' +
    'which Notion does not expose — share the original REELS board with the integration ' +
    'and use its id');
}

// Walk a page's blocks a couple of levels deep (boards often sit inside
// columns or toggles) and return the best child database id.
async function databaseInsidePage(pageId, depth = 0, seen = new Set()) {
  if (depth > 3 || seen.has(pageId)) return null;
  seen.add(pageId);
  const r = await fetch(`${NOTION}/blocks/${pageId}/children?page_size=100`, { headers: headers() });
  if (!r.ok) return null;
  const j = await r.json();
  const blocks = j.results || [];

  const dbs = blocks.filter(b => b.type === 'child_database');
  if (dbs.length) {
    const named = dbs.find(b => /reel/i.test((b.child_database && b.child_database.title) || ''));
    return (named || dbs[0]).id;
  }

  // A dashboard often points at the real board rather than holding it.
  for (const b of blocks) {
    if (b.type !== 'link_to_page') continue;
    const l = b.link_to_page || {};
    if (l.database_id) return l.database_id;
    if (l.data_source_id) return l.data_source_id;
    if (l.page_id) {
      const found = await databaseInsidePage(l.page_id, depth + 1, seen);
      if (found) return found;
    }
  }

  const containers = ['column_list', 'column', 'toggle', 'synced_block', 'callout', 'child_page'];
  for (const b of blocks) {
    if (b.type !== 'child_page' && !b.has_children) continue;
    if (!containers.includes(b.type)) continue;
    const found = await databaseInsidePage(b.id, depth + 1, seen);
    if (found) return found;
  }
  return null;
}

// Last resort: ask Notion for a board by name. Anything shared with the
// integration is searchable, so this finds boards a dashboard only links to.
async function findBoardByName(creator) {
  if (!creator) return null;
  const r = await fetch(`${NOTION}/search`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ query: `${creator} REELS`, page_size: 20 })
  });
  if (!r.ok) return null;
  const j = await r.json();
  const first = String(creator).trim().split(/\s+/)[0].toLowerCase();

  const titleOf = o => {
    const t = o.title || (o.name ? [{ plain_text: o.name }] : []);
    return (Array.isArray(t) ? t.map(x => x.plain_text || '').join('') : String(t || '')).toLowerCase();
  };

  const hits = (j.results || []).filter(o => o.object === 'database' || o.object === 'data_source');
  const exact = hits.find(o => titleOf(o).includes(first) && /reel/.test(titleOf(o)));
  const loose = hits.find(o => titleOf(o).includes(first));
  const pick = exact || loose;
  return pick ? pick.id : null;
}
