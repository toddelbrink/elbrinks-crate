// Library Stats count only records in the collection now.
//
// Todd's Sync panel read "131 of 128 records" for Genres and Moods tagged, and
// "129 of 128 covers", on 2026-10-06. Discogs had 128 records. The art, genre,
// mood and notes caches keep entries for records later removed on Discogs, and
// updateSettingsPanel counted every cache entry. He nearly held off resetting
// his cycle, thinking three albums were missing.
//
// Slices updateSettingsPanel out of the shipped page and runs it against a
// collection of 3 with caches holding a 4th, removed record.

import { execSync } from 'child_process';
import { read, sliceTo, mustContain, runIn, check, report, REPO } from './lib/slice.mjs';

function run(src) {
  const fn = sliceTo(src, /^async function updateSettingsPanel\(\)\{/, '}');
  mustContain(fn, /sMoods/, 'the Moods tagged row');
  const els = {};
  const $ = (id) => (els[id] ||= { textContent: '', style: {}, classList: { toggle() {}, add() {}, remove() {} } });
  const sb = runIn(fn, {
    $, db: {}, username: 'u', collection: [
      { releaseId: 1, artistId: 9 }, { releaseId: 2, artistId: 9 }, { releaseId: 3, artistId: 8 },
    ],
    // Release 4 was removed on Discogs. Its cache entries remain.
    artCache: { 1: 'a.jpg', 2: 'b.jpg', 3: 'c.jpg', 4: 'd.jpg' },
    genreCache: { 1: ['Rock'], 2: ['Jazz'], 3: ['Rock'], 4: ['Pop'] },
    moodCache: { 1: ['core'], 2: ['late'], 3: ['core'], 4: ['core'] },
    notesCache: { 1: 'great', 4: 'gone' },
    wikiCache: {}, playCounts: {}, cycleLog: {}, wantlist: [],
    dbGet: async () => null, crate: {}, currentCycle: 1, cycleStartedAt: null,
    console, Date, Object, Set, String, Number, Math, JSON, Promise,
  });
  return sb.updateSettingsPanel().catch(() => {}).then(() => els);
}

const APP = read('index.html');
const els = await run(APP);
check('covers count current records only', els.sArt.textContent === '3 of 3 covers', els.sArt.textContent);
check('genres count current records only', els.sGenres.textContent === '3 of 3 records', els.sGenres.textContent);
check('moods count current records only', els.sMoods.textContent === '3 of 3 records', els.sMoods.textContent);
check('user notes count current records only', /^1 user/.test(els.sNotes.textContent), els.sNotes.textContent);

// Negative case: the code before the fix must report 4 of 3.
let old = null;
try { old = execSync('git show f546955:index.html', { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { /* no history */ }
if (old) {
  const o = await run(old);
  check('negative: the old code over-counts (4 of 3)', o.sGenres.textContent === '4 of 3 records', o.sGenres.textContent);
} else {
  console.log('SKIP  negative case: git history for f546955 not available');
}

process.exit(report() ? 1 : 0);
