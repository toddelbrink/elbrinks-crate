// Sync refreshes the cycle line; auto-suggest skips users with no moods.
//
// Seen on the test user, 2026-10-20: after Add a record and a Sync the crate
// showed 5 records but the line under the header still read "Cycle 1 — 0 of 3
// played". updateCrateProgress counts the live collection, but silentSync and
// fullSync never called it, so the line kept the count from app start.
//
// Same session: with zero moods, startAutoSuggestFetch called suggest-moods for
// every record, each answering 400 "No moods configured", behind a "Claude is
// tagging N records" toast.

import { read, sliceTo, mustContain, runIn, check, report } from './lib/slice.mjs';

const HTML = read('index.html');
const PROGRESS = sliceTo(HTML, /^function updateCrateProgress\(\)\{/, '}');
const SILENT = sliceTo(HTML, /^async function silentSync\(\)\{/, '}');
const FULL = sliceTo(HTML, /^async function fullSync\(\)\{/, '}');
const AUTO = sliceTo(HTML, /^async function startAutoSuggestFetch\(\{retagAuto=false\}=\{\}\)\{/, '}');
mustContain(PROGRESS, /\$\{played\} of \$\{total\}/, 'the "played of total" cycle text');
mustContain(SILENT, /applyFilters\(\);updateCrateProgress\(\);/, 'the cycle line refresh in silentSync');
mustContain(FULL, /applyFilters\(\);updateCrateProgress\(\);showToast\(`Synced/, 'the cycle line refresh in fullSync');
mustContain(AUTO, /if\(!MOODS\.length\)return;/, 'the no-moods guard');

const rec = (id) => ({ releaseId: String(id) });
const three = ['1', '2', '3'].map(rec);
const five = ['1', '2', '3', '4', '5'].map(rec);

function el() {
  return { style: {}, innerHTML: '', textContent: '', disabled: false, parentElement: { style: {} }, classList: { contains: () => false } };
}

// One sandbox holds the real updateCrateProgress next to the sync function
// under test, so the label reflects whatever the sync left in `collection`.
function makeSync(src) {
  const els = {};
  const noop = async () => {};
  const sandbox = {
    $: (id) => (els[id] ||= el()),
    collection: three.slice(), filtered: [], cycleLog: {}, currentCycle: 1, shuffleMode: 'unplayed', token: 'tok',
    fetchCollection: async () => Object.assign(five.slice(), { discogsTotal: 5, listed: 5 }),
    mergeConditions: (fresh) => fresh.slice(),
    pushLocalMeta: noop, dbSet: noop, saveCollectionToAPI: noop, pruneRemovedRecords: noop,
    loadPlaysFromAPI: noop, loadMetaFromAPI: noop, loadArtistsFromAPI: noop,
    applyFilters() {}, seedDiscogsNotes() {}, startArtFetch() {}, startGenreFetch() {}, startWikiFetch() {},
    startAutoSuggestFetch: noop, startLinerNotesFetch: noop, showToast() {}, setProgress() {}, hideProgress() {},
    updateSettingsPanel() {}, console: { log() {}, error() {}, warn() {} },
  };
  runIn(PROGRESS + '\n' + src, sandbox);
  sandbox.updateCrateProgress(); // app start: 3 records
  return { sandbox, label: () => els.crateLabel.innerHTML };
}

{
  const { sandbox, label } = makeSync(SILENT);
  const before = label();
  await sandbox.silentSync();
  check('app start shows 0 of 3', before.includes('0 of 3'), before);
  check('after a background sync brings 2 new records the line reads 0 of 5', label().includes('0 of 5'), label());
}
{
  const { sandbox, label } = makeSync(FULL);
  await sandbox.fullSync();
  check('after Full Sync brings 2 new records the line reads 0 of 5', label().includes('0 of 5'), label());
}
// Negative: the same sync without the refresh call leaves the stale count.
{
  const { sandbox, label } = makeSync(SILENT.replace('applyFilters();updateCrateProgress();', 'applyFilters();'));
  await sandbox.silentSync();
  check('negative: without the refresh the line stays at 0 of 3', label().includes('0 of 3'), label());
}

// ── auto-suggest with and without moods ───────────────────────
function makeAuto(moods) {
  const log = { calls: 0, toasts: [] };
  const sandbox = {
    MOODS: moods, collection: three.slice(), moodsSource: {}, genreCache: {}, stylesCache: {}, moodCache: {},
    autoSuggestRunning: false, autoSuggestEnabled: true, autoSuggestDone: 0, autoSuggestTotal: 0, autoSuggestLastSummary: null,
    crate: { suggestMoods: async () => { log.calls++; return { success: false, error: 'No moods configured for this user' }; }, saveMeta: async () => {} },
    renderAutoSuggestStatus() {}, updateSettingsRowDots() {}, applyFilters() {}, dbSet: async () => {},
    showToast: (t) => log.toasts.push(t), sleep: async () => {}, console: { log() {}, error() {}, warn() {} }, Date,
  };
  runIn(AUTO, sandbox);
  return { run: sandbox.startAutoSuggestFetch, log };
}
{
  const { run, log } = makeAuto([]);
  await run();
  check('no moods: no suggest-moods calls', log.calls === 0, `${log.calls} calls`);
  check('no moods: no "Claude is tagging" toast', log.toasts.length === 0, JSON.stringify(log.toasts));
}
{
  const { run, log } = makeAuto([{ id: 'mellow', label: 'Mellow' }]);
  await run();
  check('negative: with a mood the worker still runs for every record', log.calls === 3, `${log.calls} calls`);
}

process.exit(report());
