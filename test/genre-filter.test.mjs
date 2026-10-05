// Filter and sort sheets — v1.2 piece 2 and follow-ups.
//
// Every Crate, Wantlist, drill-down and Recent sort/filter button opens one
// shared picker sheet instead of cycling on tap.
//
// Crate view, both /vinyl and the share page: a compact sort button, then Mood
// and Genre. Both open one shared picker sheet (rows with counts, mood rows with
// a color dot). Genres come from stored Discogs genres, plus Stage & Screen when
// a title reads like a soundtrack and Discogs left it off (F1 The Album).
// Multi-genre records show under each genre, no-genre records under All only.
// Filters combine with each other and with search. Styles are searchable, not
// browsable. Shuffle honors the genre filter but its label never names it.
//
// Runs the shipped functions out of both pages against fixtures.

import { read, sliceTo, sliceBetween, mustContain, runIn, check, report } from './lib/slice.mjs';

const APP = read('index.html');
const SHARE = read('share/index.html');

function parts(src) {
  return {
    genres: sliceBetween(src, /^const SOUNDTRACK_RE=/, /^\/\/ Searchable note text for a record/),
    counts: sliceTo(src, /^function genreCounts\(records\)\{/, '}'),
    note: sliceTo(src, /^function recordNoteText\(r\)\{/, '}'),
    filter: sliceTo(src, /^function applyFilters\(\)\{/, '}'),
    shuffle: sliceTo(src, /^function doShuffle\(\)\{/, '}'),
    label: sliceTo(src, /^function updateShuffleLabel\(\)\{/, '}'),
    picker: sliceBetween(src, /^let _filterPickHandler=null;$/, /^\$\('genreFilterBtn'\)\.onclick=openGenrePicker;$/),
    pickerMarkup: sliceTo(src, /^<div id="filterPicker"/, '</div>'),
  };
}
const PAGES = { '/vinyl': parts(APP), share: parts(SHARE) };
for (const [p, s] of Object.entries(PAGES)) {
  mustContain(s.filter, /activeGenreFilter!=='all'&&!?\(?recordGenres\(r\)|recordGenres\(r\)\.(indexOf|includes)\(activeGenreFilter\)/, `the genre condition in ${p} applyFilters`);
  mustContain(s.filter, /styles\.includes\(q\)/, `style search in ${p}`);
  mustContain(s.shuffle, /activeGenreFilter/, `the genre narrowing in ${p} shuffle`);
  mustContain(s.picker, /function openMoodPicker\(\)\{/, `the mood picker in ${p}`);
  mustContain(s.counts, /recordGenres\(r\)/, `soundtrack-aware counts in ${p}`);
}
for (const src of [APP, SHARE]) {
  mustContain(src, /^\$\('moodFilterBtn'\)\.onclick=openMoodPicker;$/m, 'the Mood button opening the sheet');
}
mustContain(APP, /\$\('navMoods'\)\.onclick=\(\)=>\{\n[^\n]*\n\s*closeAllOverlays\(\);setActiveNav\('navMoods'\);switchView\('crate'\);openMoodPicker\(\);/, 'the Moods tab opening the sheet');

// ── fixtures ──────────────────────────────────────────────────
const rec = (id, artist, title) => ({ releaseId: id, artist, title, label: 'Label', discogsNotes: '' });
const COLLECTION = [
  rec('1', 'Old Crow Medicine Show', 'Big Iron World'),                  // Folk + Rock, style Bluegrass
  rec('2', 'Pink Floyd', 'Animals'),                                     // Rock
  rec('3', 'Bonobo', 'Migration'),                                       // Electronic
  rec('4', 'Unknown', 'White Label'),                                    // no genre data
  rec('5', 'Khruangbin', 'Mordechai'),                                   // Rock + Funk / Soul, Rock listed twice
  rec('6', 'Various', 'F1 The Album (Music From F1 The Movie)'),         // Hip Hop + Pop at the source
  rec('7', 'The Band', 'Music From Big Pink'),                           // Rock, NOT a soundtrack
  rec('8', 'Various', 'Pump Up The Volume (Original Motion Picture Soundtrack)'), // already Stage & Screen
];
const GENRES = {
  '1': ['Folk, World, & Country', 'Rock'],
  '2': ['Rock'],
  '3': ['Electronic'],
  '5': ['Rock', 'Funk / Soul', 'Rock'],
  '6': ['Hip Hop', 'Pop'],
  '7': ['Rock'],
  '8': ['Stage & Screen'],
};
const STYLES = { '1': ['Bluegrass', 'Americana'], '2': ['Prog Rock'] };
const MOOD_TAGS = { '1': ['latenight'], '2': ['core'], '5': ['latenight'], '6': ['latenight', 'latenight'] };
const MOODS = [{ id: 'latenight', label: 'Late', color: '#a78bfa' }, { id: 'core', label: 'Core', color: '#f87171' }, { id: 'sunday', label: 'Sunday', color: '#34d399' }];

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
const ids = (rows) => rows.map((r) => r.releaseId).sort((a, b) => a - b).join(',');

function run(page, opts) {
  const sb = sandbox(opts);
  const s = PAGES[page];
  runIn([s.genres, s.note, s.filter, 'applyFilters();'].join('\n'), sb);
  return ids(sb.filtered);
}
function counts(page, records = COLLECTION) {
  const sb = { genreCache: GENRES };
  runIn([PAGES[page].genres, PAGES[page].counts].join('\n'), sb);
  return Object.fromEntries(sb.genreCounts(records));
}
function shufflePicks(page, opts, n = 80) {
  const picks = new Set();
  const sb = { ...sandbox(opts), Math, showToast() {}, openSheet: (r) => picks.add(r.releaseId) };
  runIn([PAGES[page].genres, PAGES[page].shuffle].join('\n'), sb);
  for (let i = 0; i < n; i++) sb.doShuffle();
  return [...picks].sort((a, b) => a - b).join(',');
}
// Run the shared picker block with a stub sheet so we can read the rows it builds.
function pickerSandbox(page, opts) {
  const sheet = { title: '', rows: null, active: null, onPick: null };
  const els = { moodFilterBtn: { textContent: '', className: '' }, genreFilterBtn: { textContent: '', className: '' } };
  const sb = {
    ...sandbox(opts), $: (id) => els[id] || { onclick: null, style: {}, setAttribute() {} },
    document: { createElement: () => ({}) }, setTimeout() {}, applied: 0,
  };
  runIn([PAGES[page].genres, PAGES[page].counts, PAGES[page].picker].join('\n'), sb);
  sb.openFilterPicker = (title, rows, active, onPick) => Object.assign(sheet, { title, rows, active, onPick });
  sb.applyFilters = () => { sb.applied++; };
  sb.updateShuffleLabel = () => {};
  return { sb, sheet, els };
}

for (const page of Object.keys(PAGES)) {
  check(`${page}: no filter shows every record`, run(page) === '1,2,3,4,5,6,7,8', run(page));
  check(`${page}: Rock shows every Rock record, multi-genre included (A2)`, run(page, { genre: 'Rock' }) === '1,2,5,7', run(page, { genre: 'Rock' }));
  check(`${page}: the Folk + Rock record also shows under Folk (A2)`, run(page, { genre: 'Folk, World, & Country' }) === '1', run(page, { genre: 'Folk, World, & Country' }));
  check(`${page}: the no-genre record shows under All and nowhere else (A3)`,
    run(page).includes('4') && !['Rock', 'Electronic', 'Funk / Soul', 'Stage & Screen'].some((g) => run(page, { genre: g }).split(',').includes('4')));
  check(`${page}: genre and mood combine (Rock + Late)`, run(page, { genre: 'Rock', mood: 'latenight' }) === '1,5', run(page, { genre: 'Rock', mood: 'latenight' }));
  check(`${page}: a style name finds its record (A4)`, run(page, { q: 'bluegrass' }) === '1', run(page, { q: 'bluegrass' }) || '(none)');
  check(`${page}: search and genre combine`, run(page, { q: 'prog', genre: 'Rock' }) === '2', run(page, { q: 'prog', genre: 'Rock' }) || '(none)');
  check(`${page}: NEGATIVE, an unowned genre returns nothing`, run(page, { genre: 'Classical' }) === '', run(page, { genre: 'Classical' }) || '(none)');

  // Soundtrack rule
  check(`${page}: F1 (Hip Hop + Pop at the source) shows under Stage & Screen`, run(page, { genre: 'Stage & Screen' }) === '6,8', run(page, { genre: 'Stage & Screen' }));
  check(`${page}: F1 keeps its Discogs genres too`, run(page, { genre: 'Hip Hop' }) === '6', run(page, { genre: 'Hip Hop' }));
  check(`${page}: NEGATIVE, "Music From Big Pink" is not a soundtrack`, !run(page, { genre: 'Stage & Screen' }).split(',').includes('7'));
  check(`${page}: typing "stage" finds the derived genre`, run(page, { q: 'stage & screen' }) === '6,8', run(page, { q: 'stage & screen' }));

  const c = counts(page);
  check(`${page}: counts list only owned genres (A1)`, Object.keys(c).sort().join('|') === ['Electronic', 'Folk, World, & Country', 'Funk / Soul', 'Hip Hop', 'Pop', 'Rock', 'Stage & Screen'].join('|'), Object.keys(c).join('|'));
  check(`${page}: Rock counted once per record even if listed twice`, c['Rock'] === 4, `Rock=${c['Rock']}`);
  check(`${page}: Stage & Screen counts the soundtrack once, no double add`, c['Stage & Screen'] === 2, `S&S=${c['Stage & Screen']}`);
  check(`${page}: empty collection gives no genres`, Object.keys(counts(page, [])).length === 0);

  check(`${page}: shuffle only picks from the active genre`, /^[1257](,[1257])*$/.test(shufflePicks(page, { genre: 'Rock' })), shufflePicks(page, { genre: 'Rock' }));

  // Shared picker: mood rows
  {
    const { sb, sheet, els } = pickerSandbox(page);
    sb.openMoodPicker();
    const rows = sheet.rows || [];
    check(`${page}: mood sheet lists All plus every mood in order`, sheet.title === 'Mood' && rows.map((r) => r.value).join(',') === 'all,latenight,core,sunday', rows.map((r) => r.value).join(','));
    check(`${page}: mood counts are records, a doubled tag counts once`, rows[1]?.count === 3 && rows[2]?.count === 1 && rows[3]?.count === 0, rows.map((r) => r.count).join(','));
    check(`${page}: mood rows carry their color, All does not`, rows[1]?.color === '#a78bfa' && !rows[0]?.color);
    sheet.onPick('core');
    check(`${page}: picking a mood sets the filter, label and active state`, sb.activeMoodFilter === 'core' && els.moodFilterBtn.textContent === 'Mood: Core' && /active-filter/.test(els.moodFilterBtn.className) && sb.applied === 1, els.moodFilterBtn.textContent);
    sb.openGenrePicker();
    check(`${page}: genre sheet uses the same picker, F1 counted under Stage & Screen`, sheet.title === 'Genre' && sheet.rows.find((r) => r.value === 'Stage & Screen')?.count === 2);
    sheet.onPick('Rock');
    check(`${page}: picking a genre shows the bare name`, sb.activeGenreFilter === 'Rock' && els.genreFilterBtn.textContent === 'Rock', els.genreFilterBtn.textContent);
  }

  // Todd, 2026-10-04: the genre filter narrows shuffle but never changes the label.
  {
    const el = { textContent: '' };
    const sb = { $: () => el, MOODS, activeMoodFilter: 'all', activeGenreFilter: 'Rock', shuffleMode: 'all' };
    runIn(PAGES[page].label + '\nupdateShuffleLabel();', sb);
    const withGenre = el.textContent;
    sb.activeGenreFilter = 'all';
    runIn('updateShuffleLabel();', sb);
    check(`${page}: genre filter leaves the shuffle label alone`, withGenre === el.textContent && !/rock/i.test(withGenre), `"${withGenre}"`);
    sb.activeMoodFilter = 'latenight';
    runIn('updateShuffleLabel();', sb);
    check(`${page}: NEGATIVE, mood still changes the label`, el.textContent !== withGenre, `"${el.textContent}"`);
  }
}

// ── Sort sheets and the Recent mood chip ──────────────────────
// A tiny fake DOM so the shared picker can actually build its rows.
function fakeDom() {
  const mk = (tag) => ({ tag, className: '', dataset: {}, style: {}, textContent: '', children: [],
    append(...c) { this.children.push(...c); }, appendChild(c) { this.children.push(c); }, setAttribute() {} });
  const els = { filterPicker: mk('div'), filterPickerTitle: mk('div'), filterPickerList: Object.defineProperty(mk('div'), 'innerHTML', { set() { this.children = []; }, get() { return ''; } }),
    genreFilterBtn: mk('button'), moodFilterBtn: mk('button') };
  return { els, document: { createElement: mk, createTextNode: (t) => ({ textContent: t }) } };
}
const rowText = (btn) => btn.children.map((c) => (c.children?.length ? c.children.map((x) => x.textContent).join('') : c.textContent));

for (const [page, src] of [['/vinyl', APP], ['share', SHARE]]) {
  const s = PAGES[page];
  const { els, document } = fakeDom();
  const sb = { ...sandbox(), $: (id) => els[id], document, setTimeout() {} };
  runIn([s.genres, s.counts, s.picker].join('\n'), sb);

  // Rows without a count render no number, and only a check on the active one.
  sb.openFilterPicker('Sort by', sb.sortRows(['date_desc', 'alpha'], ['Date Added ↓', 'Artist A–Z']), 'alpha', () => {});
  const rows = els.filterPickerList.children;
  check(`${page}: sort sheet spells out the arrow labels`, rowText(rows[0])[0] === 'Date added, newest first' && rowText(rows[1])[0] === 'Artist A–Z', rowText(rows[0])[0]);
  check(`${page}: rows without counts show no number, active shows only ✓`, rowText(rows[0])[1] === '' && rowText(rows[1])[1] === '✓', JSON.stringify(rows.map((r) => rowText(r)[1])));
  check(`${page}: the sheet title says Sort by`, els.filterPickerTitle.textContent === 'Sort by');

  // Mood rows: counts on the Crate view, none for Recent.
  const withCounts = sb.moodRows(true), without = sb.moodRows(false);
  check(`${page}: Recent mood rows carry no counts`, without.every((r) => r.count == null) && without.length === MOODS.length + 1);
  check(`${page}: Crate mood rows keep their counts`, withCounts.every((r) => typeof r.count === 'number'));
  sb.openFilterPicker('Mood', withCounts, 'latenight', () => {});
  const moodRowsBuilt = els.filterPickerList.children;
  check(`${page}: counted rows still show "✓ n" on the active one`, rowText(moodRowsBuilt[1])[1] === '✓ 3', rowText(moodRowsBuilt[1])[1]);

  // Wiring: each button opens the sheet, and no cycle-on-tap code survives.
  mustContain(src, /\$\('sortBtn'\)\.onclick=\(\)=>openFilterPicker\('Sort by'/, `${page} Crate sort sheet`);
  mustContain(src, /\$\('wantSortBtn'\)\.onclick=\(\)=>openFilterPicker\('Sort by'/, `${page} Wantlist sort sheet`);
  mustContain(src, /psb\.onclick=\(\)=>openFilterPicker\('Sort by'/, `${page} drill-down sort sheet`);
  mustContain(src, /\$\('recentMoodFilterBtn'\)\.onclick=\(\)=>openFilterPicker\('Mood',moodRows\(false\)/, `${page} Recent mood sheet`);
  const cycles = src.match(/\((?:sortIdx|wantSortIdx|playsSortIdx)\+1\)%|opts\.indexOf\((?:_recentMoodFilter|activeMoodFilter)\)/g) || [];
  check(`${page}: NEGATIVE guard, no cycle-on-tap handlers remain`, cycles.length === 0, cycles.join(' ') || 'none');
}

// Parity: the shared pieces are verbatim on both pages.
check('recordGenres and SOUNDTRACK_RE are identical on both pages', PAGES['/vinyl'].genres.replace(/\/\/.*$/gm, '') === PAGES.share.genres.replace(/\/\/.*$/gm, ''));
check('genreCounts is identical on both pages', PAGES['/vinyl'].counts === PAGES.share.counts);
check('the picker block is identical on both pages', PAGES['/vinyl'].picker === PAGES.share.picker);
const icon = (src) => (src.match(/^const SORT_ICON=.*$/m) || [''])[0];
check('compact sort icon is identical on both pages', icon(APP) && icon(APP) === icon(SHARE));

// Naming rule (A6): nothing these filters show says "Discogs".
for (const [p, s] of Object.entries(PAGES)) {
  const visible = [s.pickerMarkup, s.picker.replace(/\/\/.*$/gm, '')].join('\n').replace(/'[^']*'/g, (m) => m);
  const strings = [...visible.matchAll(/'([^']*)'|`([^`]*)`/g)].map((m) => m[1] ?? m[2]).join(' | ');
  check(`${p}: filter sheet and buttons never say Discogs (A6)`, strings.length > 0 && !/discogs/i.test(strings + s.pickerMarkup));
}

process.exit(report() ? 1 : 0);
