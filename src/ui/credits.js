// The attribution panel.
//
// This is not decoration and it is not optional. Most of the downloaded art in
// this game is CC-BY, which grants commercial use and modification -- including
// selling the game and selling texture packs for it -- in exchange for exactly
// one thing: credit, naming the title, the author, the source and the licence,
// and saying so when the asset has been changed.
//
// "Reasonably findable" is the standard, so a menu entry is the right home for
// it: a credits list buried in a repo file that no player can reach is not
// attribution, and a licence violation is not the kind of bug that shows up in
// a test run. The data is assets/CREDITS.json, written by tools/fetch-assets.mjs
// at download time, which means the list cannot drift from what actually shipped
// -- nobody has to remember to add a row.
//
// No art installed, no rows, no button: the procedural game owes nobody credit.

const ROOT = new URL('../../assets/', import.meta.url).href;

let rowsPromise = null;

/** The credit rows for whatever art is installed, or [] when there is none. */
export function creditRows() {
  if (!rowsPromise) {
    // See the note in photosets.js: the attribution record is never served from
    // a stale cache.
    rowsPromise = fetch(`${ROOT}CREDITS.json`, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => (Array.isArray(rows) ? rows : []))
      .catch(() => []);
  }
  return rowsPromise;
}

const LICENCE_URL = {
  'CC-BY': 'https://creativecommons.org/licenses/by/4.0/',
  CC0: 'https://creativecommons.org/publicdomain/zero/1.0/',
};

const SECTION_LABEL = {
  terrain: 'Ground', surfaces: 'Surfaces', env: 'Sky', props: 'Props',
  weapons: 'Weapons', hands: 'Hands', attachments: 'Attachments',
  characters: 'Characters', kit: 'Military kit', vehicles: 'Vehicles',
  spacecraft: 'Spacecraft',
};

function escape(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * Render the panel's body.
 *
 * Grouped by what the art is for rather than by licence, because a player
 * reading credits is looking for the thing they just saw. The licence still
 * appears on every row -- that is the part that is legally load-bearing.
 */
function render(rows) {
  const bySection = new Map();
  for (const r of rows) {
    if (!bySection.has(r.section)) bySection.set(r.section, []);
    bySection.get(r.section).push(r);
  }

  const attributed = rows.filter((r) => r.license === 'CC-BY').length;
  const out = [`<p class="credits-intro">
    ${rows.length} third-party assets. ${attributed} require attribution and are credited below;
    the rest are public domain and are credited anyway.
  </p>`];

  for (const [section, list] of bySection) {
    out.push(`<h3>${escape(SECTION_LABEL[section] || section)}</h3><ul class="credits-list">`);
    for (const r of list.sort((a, b) => a.title.localeCompare(b.title))) {
      const url = LICENCE_URL[r.license] || '';
      out.push(`<li>
        <span class="credits-title">${escape(r.title)}</span>
        <span class="credits-by">by ${escape(r.author)}</span>
        <a class="credits-src" href="${escape(r.page)}" target="_blank" rel="noopener noreferrer">source</a>
        <a class="credits-lic" href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(r.license)}</a>
        ${r.modified ? `<span class="credits-mod">${escape(r.modified)}</span>` : ''}
      </li>`);
    }
    out.push('</ul>');
  }
  return out.join('');
}

/**
 * Wire up the credits panel.
 *
 * @param button  the element that opens it; hidden when there is nothing to show
 * @param panel   the container to fill
 * @returns {Promise<number>} how many rows were listed
 */
export async function initCredits(button, panel) {
  const rows = await creditRows();
  if (!button || !panel) return rows.length;

  if (!rows.length) {
    button.hidden = true;
    return 0;
  }
  button.hidden = false;
  panel.innerHTML = render(rows);
  return rows.length;
}
