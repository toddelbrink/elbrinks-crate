// Genre filter — v1.2 piece 2.
//
// One Genre button on the Crate view, beside Mood, on both /vinyl and the share
// page. Genres come from the stored Discogs genres. A record with several
// genres shows under each. Records with no genre show under All only. Genre and
// mood combine. Styles are searchable, not browsable. Shuffle honors the filter.
//
// Runs the shipped applyFilters / genreCounts / doShuffle against fixtures.

import { read, sliceTo, mustContain, runIn, check, report } from './lib/slice.mjs';

const APP = read('index.html');
const SHARE = read('share/index.html');

const PAGES = {
  '/vinyl': {
    counts: sliceTo(APP, /^function genreCounts\(records\)\{/, '}'),
    note: sliceTo(APP, /^function recordNoteText\(r\)\{/, '}'),
    filter: sliceTo(APP, /^function applyFilters\(\)\{/, '}'),
    shuffle: sliceTo(APP, /^function doShuffle\(\)\{/, '}'),
  },
  share: {
    counts: sliceTo(SHARE, /^function genreCounts\(records\)\{/, '}'),
    note: sliceTo(SHARE, /^function recordNoteText\(r\)\{/, '}'),
    filter: sliceTo(SHARE, /^function applyFilters\(\)\{/, '}'),
    shuffle: sliceTo(SHARE, /^function doShuffle\(\)\{/, '}'),
  },
};
for (const [p, s] of Object.entries(PAGES)) {
  mustContain(s.filter, /activeGenreFilter!=='all'/, `the genre condition in ${p} applyFilters`);
  mustContain(s.filter, /styles\.includes\(q\)/, `style search in ${p}`);
  mustContain(s.shuffle, /activeGenreFilter/, `the genre narrowing in ${p} shuffle`);
}

// ── fixtures ──────────────────────────────────────────────────
const rec = (id, artist, title) => ({ releaseId: id, artist, title, label: 'Label', discogsNotes: '' });
const COLLECTION = [
  rec('1', 'Old Crow Medicine Show', 'Big Iron World'), // Folk + Rock, style Bluegrass
  rec('2', 'Pink Floyd', 'Animals'),                    // Rock
  rec('3', 'Bonobo', 'Migration'),                      // Electronic
  rec('4', 'Unknown', 'White Label'),                   // no genre data
  rec('5', 'Khruangbin', 'Mordechai'),                  // Rock + Funk / Soul, genre listed twice
];
const GENRES = {
  '1': ['Folk, World, & Country', 'Rock'],
  '2': ['Rock'],
  '3': ['Electronic'],
  '5': ['Rock', 'Funk / Soul', 'Rock'],
};
const STYLES = { '1': ['Bluegrass', 'Americana'], '2': ['Prog Rock'] };
const MOOD_TAGS = { '1': ['latenight'], '2': ['core'], '5': ['latenight'] };
const MOODS = [{ id: 'latenight', label: 'Late' }, { id: 'core', label: 'Core' }];

function sandbox({ q = '', genre = 'all', mood = 'all' } = {}) {
  const els = { searchBarTop: { value: q }, countBadge: { textContent: '' } };
  return {
    $: (id) => els[id], collection: COLLECTION, filtered: [],
    activeMoodFilter: mood, activeGenreFilter: genre, activeView: 'crate',
    moodCache: MOOD_TAGS, genreCache: GENRES, stylesCache: STYLES, notesCache: {}, MOODS,
    shuffleMode: 'all', cycleLog: {},
    sortFiltered() {}, applySort() {}, renderGrid() {}, updateAlphaScrubber() {}, updateScrubber() {},
    console,
  };
}
const ids = (rows) => rows.map((r) => r.releaseId).sort().join(',');

function run(page, opts) {
  const sb = sandbox(opts);
  const s = PAGES[page];
  runIn([s.note, s.filter, 'applyFilters();'].join('\n'), sb);
  return ids(sb.filtered);
}
function counts(page) {
  const sb = { genreCache: GENRES };
  runIn(PAGES[page].counts, sb);
  return { all: sb.genreCounts(COLLECTION), empty: sb.genreCounts([]) };
}
function shufflePicks(page, opts, n = 60) {
  const picks = new Set();
  const sb = { ...sandbox(opts), Math, showToast() {}, openSheet: (r) => picks.add(r.releaseId) };
  runIn(PAGES[page].shuffle, sb);
  for (let i = 0; i < n; i++) sb.doShuffle();
  return [...picks].sort().join(',');
}

for (const page of Object.keys(PAGES)) {
  check(`${page}: no filter shows every record`, run(page) === '1,2,3,4,5', run(page));
  check(`${page}: Rock shows every Rock record, multi-genre included (A2)`, run(page, { genre: 'Rock' }) === '1,2,5', run(page, { genre: 'Rock' }));
  check(`${page}: the Folk + Rock record also shows under Folk (A2)`, run(page, { genre: 'Folk, World, & Country' }) === '1', run(page, { genre: 'Folk, World, & Country' }));
  check(`${page}: the no-genre record shows under All and nowhere else (A3)`,
    run(page).includes('4') && !['Rock', 'Electronic', 'Funk / Soul'].some((g) => run(page, { genre: g }).includes('4')));
  check(`${page}: genre and mood combine (Rock + Late)`, run(page, { genre: 'Rock', mood: 'latenight' }) === '1,5', run(page, { genre: 'Rock', mood: 'latenight' }));
  check(`${page}: a style name finds its record (A4)`, run(page, { q: 'bluegrass' }) === '1', run(page, { q: 'bluegrass' }) || '(none)');
  check(`${page}: search and genre combine`, run(page, { q: 'prog', genre: 'Rock' }) === '2', run(page, { q: 'prog', genre: 'Rock' }) || '(none)');
  // Negative: a genre nobody owns returns nothing, so the filter isn't a pass-through.
  check(`${page}: NEGATIVE, an unowned genre returns nothing`, run(page, { genre: 'Classical' }) === '', run(page, { genre: 'Classical' }) || '(none)');

  const c = counts(page);
  const asObj = Object.fromEntries(c.all);
  check(`${page}: counts list only owned genres (A1)`, Object.keys(asObj).sort().join('|') === ['Electronic', 'Folk, World, & Country', 'Funk / Soul', 'Rock'].join('|'), Object.keys(asObj).join('|'));
  check(`${page}: Rock counted once per record even if listed twice`, asObj['Rock'] === 3, `Rock=${asObj['Rock']}`);
  check(`${page}: counts sort by size, then name`, c.all[0][0] === 'Rock' && c.all[1][0] === 'Electronic', c.all.map((x) => x.join(':')).join(' '));
  check(`${page}: empty collection gives no genres`, c.empty.length === 0);

  check(`${page}: shuffle only picks from the active genre`, /^[125](,[125])*$/.test(shufflePicks(page, { genre: 'Rock' })), shufflePicks(page, { genre: 'Rock' }));
}

check('genreCounts is identical on both pages', PAGES['/vinyl'].counts === PAGES.share.counts);
const icon = (src) => (src.match(/^const SORT_ICON=.*$/m) || [''])[0];
check('compact sort icon is identical on both pages', icon(APP) && icon(APP) === icon(SHARE));

// Naming rule (A6): nothing this piece shows says "Discogs".
for (const [p, src] of [['/vinyl', APP], ['share', SHARE]]) {
  const picker = sliceTo(src, /<div id="genrePicker"/, '</div>');
  const btn = (src.match(/<button class="ctrl-btn" id="genreFilterBtn">[^<]*<\/button>/) || [''])[0];
  const render = sliceTo(src, /^function renderGenreBtn\(\)\{/, '}');
  const visible = [picker, btn, render.replace(/\/\/.*$/gm, '')].join('\n');
  check(`${p}: Genre button and picker never say Discogs (A6)`, btn && !/discogs/i.test(visible), btn);
}

process.exit(report() ? 1 : 0);
