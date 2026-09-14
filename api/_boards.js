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
  { creator: 'Valeri',  ds: 'f0dbec00-505d-4e16-8e51-b2fcfea21445', format: 'Short' }
  // David Iya and Nicole McCain post on the calendar but I only have the
  // ID prefixes (898508e9… and 25b449d2…). Paste the full source data
  // source IDs here and they appear everywhere automatically.
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
  const seen = new Set();
  return BOARDS.concat(extra)
    .filter(b => !hidden.includes(b.creator))
    .filter(b => { if (seen.has(b.ds)) return false; seen.add(b.ds); return true; });
}
