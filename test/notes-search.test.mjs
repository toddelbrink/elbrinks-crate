// Notes search — v1.2 piece 1.
//
// Todd marks his Heady Wax Fiends record-club records in notes, and search
// never looked at notes, so there was no way to pull them up. Search now also
// matches a record's in-app note and its Discogs note, on both /vinyl and the
// share page (which already shows notes publicly in album detail). Liner notes
// are Claude's words, not the user's, and must NOT match.
//
// Runs the shipped applyFilters from BOTH pages against the same fixtures.

import { read, sliceTo, mustContain, runIn, check, report } from './lib/slice.mjs';

const APP = read('index.html');
const SHARE = read('share/index.html');

const APP_NOTE = sliceTo(APP, /^function recordNoteText\(r\)\{/, '}');
const SHARE_NOTE = sliceTo(SHARE, /^function recordNoteText\(r\)\{/, '}');
const APP_FILTER = sliceTo(APP, /^function applyFilters\(\)\{/, '}');
const SHARE_FILTER = sliceTo(SHARE, /^function applyFilters\(\)\{/, '}');
mustContain(APP_FILTER, /recordNoteText\(r\)\.includes\(q\)/, 'the notes match in /vinyl search');
mustContain(SHARE_FILTER, /recordNoteText\(r\)\.includes\(q\)/, 'the notes match in share page search');
mustContain(APP_NOTE, /discogsNotes/, 'the Discogs note source');

// ── fixtures ──────────────────────────────────────────────────
const rec = (id, artist, title, extra = {}) => ({ releaseId: id, artist, title, label: 'Label', ...extra });
const COLLECTION = [
  rec('1', 'Miles Davis', 'Kind of Blue'),                                  // in-app note only
  rec('2', 'Goose', 'Shenanigans', { discogsNotes: 'HEADY Wax club, #4' }), // Discogs note only
  rec('3', 'Spafford', 'Abaculus', { discogsNotes: 'Heady Wax Fiends' }),   // both (seeded copy)
  rec('4', 'Brewer', 'Heady Topper Sessions'),                              // title match
  rec('5', 'Pink Floyd', 'Animals'),                                        // liner notes mention it
  rec('6', 'Portishead', 'Dummy'),                                          // no match anywhere
];
const NOTES = { '1': 'Heady Wax Fiends, March pick', '3': 'Heady Wax Fiends' };
const LINER = { '5': [{ text: 'Pressed for a heady wax collectors run.' }] };
const MOOD_TAGS = { '1': ['latenight'], '2': ['core'], '3': ['latenight'] };
const MOODS = [{ id: 'latenight', label: 'Late' }, { id: 'core', label: 'Core' }];

function sandbox(q, { notes = NOTES, collection = COLLECTION, mood = 'all' } = {}) {
  const els = { searchBarTop: { value: q }, countBadge: { textContent: '' } };
  return {
    $: (id) => els[id],
    collection, filtered: [], activeMoodFilter: mood, activeView: 'crate',
    moodCache: MOOD_TAGS, genreCache: {}, stylesCache: {}, activeGenreFilter: 'all',
    notesCache: notes, linerNotesCache: LINER, MOODS,
    sortFiltered() {}, applySort() {}, renderGrid() {}, updateAlphaScrubber() {}, updateScrubber() {},
    console,
  };
}

function search(page, q, opts) {
  const sb = sandbox(q, opts);
  const src = page === 'app' ? [APP_NOTE, APP_FILTER] : [SHARE_NOTE, SHARE_FILTER];
  runIn(src.join('\n') + '\napplyFilters();', sb);
  return sb.filtered.map((r) => r.releaseId).sort().join(',');
}

const stripNotes = COLLECTION.map(({ discogsNotes, ...r }) => r);

for (const page of ['app', 'share']) {
  const p = page === 'app' ? '/vinyl' : 'share';
  check(`${p}: "heady" finds note matches from both sources plus the title match`,
    search(page, 'heady') === '1,2,3,4', search(page, 'heady'));
  check(`${p}: liner notes never match`, !search(page, 'collectors').includes('5'), search(page, 'collectors') || '(none)');
  check(`${p}: matching is case-insensitive and partial`, search(page, 'wax fie') === '1,3', search(page, 'wax fie'));
  check(`${p}: title search unchanged`, search(page, 'kind of') === '1', search(page, 'kind of'));
  check(`${p}: mood filter still narrows a notes search`,
    search(page, 'heady', { mood: 'latenight' }) === '1,3', search(page, 'heady', { mood: 'latenight' }));
  // Negative case: with no notes anywhere, the same query must find nothing.
  // Proves the matches above came from notes, not from something matching everything.
  check(`${p}: NEGATIVE, no notes means "wax" finds nothing`,
    search(page, 'wax', { notes: {}, collection: stripNotes }) === '', search(page, 'wax', { notes: {}, collection: stripNotes }) || '(none)');
}

check('recordNoteText is identical on both pages', APP_NOTE === SHARE_NOTE);

process.exit(report() ? 1 : 0);
