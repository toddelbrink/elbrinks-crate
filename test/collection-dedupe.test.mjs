// Collection dedupe — two copies of one pressing are one record in the app.
//
// Crate keys everything by Discogs release id. Owning two copies of the exact
// same pressing gives two Discogs collection items with one id. The database
// already collapsed them (saveCollection, last wins), but the in-memory list
// came straight from the Discogs listing, so the grid showed two cards until
// the next cold load from Supabase. v1.3 "Add another copy" (PRD 4.4) makes
// this case routine, so fetchCollection now dedupes the same way, last wins.
//
// The prune guard compares items received to Discogs' item count. It must read
// the count from before the dedupe, or a crate holding a duplicate would never
// prune again.

import { read, sliceTo, mustContain, runIn, check, report } from './lib/slice.mjs';

const HTML = read('index.html');
const DEDUPE = sliceTo(HTML, /^function dedupeByRelease\(list\)\{/, '}');
const FETCH = sliceTo(HTML, /^async function fetchCollection\(silent=false\)\{/, '}');
const PRUNE = sliceTo(HTML, /^async function pruneRemovedRecords\(fresh\)\{/, '}');
mustContain(FETCH, /dedupeByRelease\(results\.map\(normalizeRelease\)\)/, 'the dedupe on the fetch result');
mustContain(FETCH, /out\.listed=results\.length/, 'the pre-dedupe item count');

// ── the helper ────────────────────────────────────────────────
const { dedupeByRelease } = runIn(DEDUPE, {});
{
  const out = dedupeByRelease([
    { releaseId: '1', mediaCondition: 'Very Good (VG)' },
    { releaseId: '2' },
    { releaseId: '1', mediaCondition: 'Near Mint (NM or M-)' },
  ]);
  check('two copies of one pressing become one record', out.length === 2);
  check('last copy wins, matching the database', out[0].mediaCondition === 'Near Mint (NM or M-)');
  check('order follows first appearance', out.map((r) => r.releaseId).join() === '1,2');
}
{
  const out = dedupeByRelease([{ releaseId: 1 }, { releaseId: '1' }]);
  check('numeric and string ids are the same record', out.length === 1);
}
{
  const out = dedupeByRelease([{ releaseId: '' }, {}, null, { releaseId: '3' }]);
  check('records with no id are dropped, not merged into one', out.length === 1 && out[0].releaseId === '3');
}
{
  const list = [{ releaseId: '7' }, { releaseId: '8' }];
  const out = dedupeByRelease(list);
  check('a list with no duplicates comes back whole', out.length === 2 && out[0] === list[0] && out[1] === list[1]);
}

// ── fetchCollection, end to end with prune ────────────────────
// 128 Discogs items: 127 distinct pressings plus a second copy of 1000.
const items = Array.from({ length: 127 }, (_, i) => 1000 + i).concat(1000);
function fetchSandbox(src) {
  const pages = [
    { releases: items.slice(0, 100).map((id) => ({ basic_information: { id } })), pagination: { pages: 2, items: 128 } },
    { releases: items.slice(100).map((id) => ({ basic_information: { id } })), pagination: { pages: 2, items: 128 } },
  ];
  let call = 0;
  return runIn(src, {
    username: 'someone',
    discogsGet: async () => ({ json: async () => pages[call++] }),
    sleep: async () => {},
    setProgress() {},
    normalizeRelease: (r) => ({ releaseId: String(r.basic_information.id) }),
  });
}
const fresh = await fetchSandbox(DEDUPE + '\n' + FETCH).fetchCollection(true);
check('the fetched collection holds one record per pressing', fresh.length === 127, `${fresh.length}`);
check('it still reports every Discogs item that arrived', fresh.listed === 128 && fresh.discogsTotal === 128);

{
  // The stored crate has one record that is no longer on Discogs.
  const stored = Array.from({ length: 127 }, (_, i) => ({ releaseId: String(1000 + i) })).concat({ releaseId: '999' });
  const sandbox = runIn(PRUNE, {
    crate: {
      loadCollection: async () => ({ success: true, data: stored }),
      removeFromCollection: async (ids) => { sandbox.removed = ids; return { success: true, data: ids }; },
    },
    console: { log() {}, warn() {} },
  });
  await sandbox.pruneRemovedRecords(fresh);
  check('a crate holding a duplicate still prunes', JSON.stringify(sandbox.removed) === '["999"]', JSON.stringify(sandbox.removed));
}

// ── negative cases ────────────────────────────────────────────
{
  // Without the dedupe, the second copy comes back as a second record.
  const broken = FETCH.replace('dedupeByRelease(results.map(normalizeRelease))', 'results.map(normalizeRelease)');
  const out = await fetchSandbox(broken).fetchCollection(true);
  check('negative: without the dedupe, one pressing shows as two records', out.length === 128);
}
{
  // If prune compared the deduped length instead of the item count, a crate
  // with a duplicate would look short and never prune.
  const broken = PRUNE.replace('fresh.listed!==fresh.discogsTotal', 'fresh.length!==fresh.discogsTotal');
  const stored = [{ releaseId: '999' }].concat(fresh.map((r) => ({ releaseId: r.releaseId })));
  const sandbox = runIn(broken, {
    crate: {
      loadCollection: async () => ({ success: true, data: stored }),
      removeFromCollection: async (ids) => { sandbox.removed = ids; return { success: true, data: ids }; },
    },
    console: { log() {}, warn() {} },
  });
  await sandbox.pruneRemovedRecords(fresh);
  check('negative: comparing the deduped length stalls prune', sandbox.removed === undefined);
}

process.exit(report() ? 1 : 0);
