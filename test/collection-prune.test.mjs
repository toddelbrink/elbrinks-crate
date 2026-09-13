// Collection prune — records removed on Discogs leave the crate.
//
// saveCollection only upserts, so a record removed on Discogs stayed in
// vinyl_collection forever and kept showing on the public share page. Real case:
// The Great Divide was added twice (37161246 kept, 37155918 removed on Discogs);
// /vinyl showed 127 records, the share page 128.
//
// Pruning deletes rows, so the guards matter more than the happy path: a short
// or failed Discogs listing must never empty a crate.

import { read, sliceTo, mustContain, runIn, check, report } from './lib/slice.mjs';

const HTML = read('index.html');
const FETCH = sliceTo(HTML, /^async function fetchCollection\(silent=false\)\{/, '}');
const PRUNE = sliceTo(HTML, /^async function pruneRemovedRecords\(fresh\)\{/, '}');
const REMOVE = sliceTo(read('lib/supabase.js'), /^async function removeFromCollection\(releaseIds\) \{/, '}');
mustContain(FETCH, /out\.discogsTotal=total/, 'the Discogs item count on the fetch result');
mustContain(PRUNE, /fresh\.length!==fresh\.discogsTotal/, 'the complete-listing guard');
mustContain(PRUNE, /Math\.floor\(stored\.data\.length\/4\)/, 'the mass-removal cap');
mustContain(HTML, /saveCollectionToAPI\(collection\);\n\s*await pruneRemovedRecords\(fresh\);/, 'the prune call after a sync save');

const rec = (id) => ({ releaseId: String(id) });
const listing = (ids, total = ids.length) => Object.assign(ids.map(rec), { discogsTotal: total });
const crate128 = Array.from({ length: 127 }, (_, i) => String(1000 + i)).concat('37155918');
const discogs127 = crate128.filter((id) => id !== '37155918');

function makePrune({ stored = crate128, loadOk = true, removeOk = true } = {}) {
  const log = { removed: null, loads: 0 };
  const sandbox = {
    crate: {
      loadCollection: async () => { log.loads++; return loadOk ? { success: true, data: stored.map(rec) } : { success: false, error: 'boom' }; },
      removeFromCollection: async (ids) => { log.removed = ids; return removeOk ? { success: true, data: ids } : { success: false, error: 'rls' }; },
    },
    console: { log() {}, warn() {} },
  };
  runIn(PRUNE, sandbox);
  return { prune: sandbox.pruneRemovedRecords, log };
}

// ── the real case ─────────────────────────────────────────────
{
  const { prune, log } = makePrune();
  await prune(listing(discogs127));
  check('a record removed on Discogs is removed from the crate', JSON.stringify(log.removed) === '["37155918"]', JSON.stringify(log.removed));
}

// ── guards ────────────────────────────────────────────────────
{
  const { prune, log } = makePrune();
  await prune(listing(discogs127.slice(0, 100), 127));
  check('a short listing (100 of 127) removes nothing', log.removed === null && log.loads === 0);
}
{
  const { prune, log } = makePrune();
  await prune(discogs127.map(rec)); // a copy without discogsTotal, e.g. mergeConditions output
  check('a listing without a Discogs total removes nothing', log.removed === null);
}
{
  const { prune, log } = makePrune();
  await prune(listing([], 0));
  check('an empty listing removes nothing', log.removed === null);
}
{
  const { prune, log } = makePrune();
  await prune(listing(discogs127.slice(0, 60)));
  check('removing more than a quarter of the crate is refused', log.removed === null);
}
{
  const { prune, log } = makePrune({ stored: ['1', '2', '3', '4', '5'] });
  await prune(listing(['1', '2']));
  check('small crates can still drop a few records (floor of 3)', JSON.stringify(log.removed) === '["3","4","5"]');
}
{
  const { prune, log } = makePrune({ loadOk: false });
  await prune(listing(discogs127));
  check('a failed read of the stored crate removes nothing', log.removed === null);
}
{
  const { prune, log } = makePrune();
  await prune(Object.assign(discogs127.map(rec).concat(rec('1000')), { discogsTotal: 128 }));
  check('two copies of one pressing count as a complete listing, not a removal', JSON.stringify(log.removed) === '["37155918"]');
}
{
  const { prune } = makePrune({ removeOk: false });
  let threw = false;
  try { await prune(listing(discogs127)); } catch { threw = true; }
  check('a failed delete never throws into the sync', !threw);
}
{
  const { prune, log } = makePrune({ stored: discogs127 });
  await prune(listing(discogs127));
  check('nothing stale means no delete call', log.removed === null);
}

// ── fetchCollection supplies the total the guard relies on ────
{
  const pages = [
    { releases: Array.from({ length: 100 }, (_, i) => ({ id: i, basic_information: { id: i } })), pagination: { pages: 2, items: 127 } },
    { releases: Array.from({ length: 27 }, (_, i) => ({ id: 100 + i, basic_information: { id: 100 + i } })), pagination: { pages: 2, items: 127 } },
  ];
  let call = 0;
  const sandbox = {
    username: 'telbrink',
    discogsGet: async () => ({ json: async () => pages[call++] }),
    sleep: async () => {},
    setProgress() {},
    normalizeRelease: (r) => ({ releaseId: String(r.basic_information.id) }),
  };
  runIn(FETCH, sandbox);
  const out = await sandbox.fetchCollection(true);
  check('fetchCollection reads every page and carries Discogs\' item count', out.length === 127 && out.discogsTotal === 127);
}

// Negative case: strip the complete-listing guard and a short listing must
// wrongly delete — proving the guard, not the fixture, is what stops it.
{
  const broken = PRUNE.replace(/if\(typeof fresh\.discogsTotal[^\n]*\n[^\n]*\n\s*return;\n\s*\}/, '');
  const sandbox = {
    crate: {
      loadCollection: async () => ({ success: true, data: crate128.map(rec) }),
      removeFromCollection: async (ids) => { sandbox.removed = ids; return { success: true, data: ids }; },
    },
    console: { log() {}, warn() {} },
  };
  runIn(broken, sandbox);
  await sandbox.pruneRemovedRecords(listing(discogs127.slice(0, 110), 127));
  check('negative: without the completeness guard, a short listing deletes records', Array.isArray(sandbox.removed) && sandbox.removed.length > 1);
}

// ── lib: removeFromCollection is scoped and exact ─────────────
{
  const calls = [];
  const chain = {
    delete() { calls.push('delete'); return chain; },
    eq(c, v) { calls.push(`eq:${c}=${v}`); return chain; },
    in(c, v) { calls.push(`in:${c}=${JSON.stringify(v)}`); return chain; },
    select() { return Promise.resolve({ data: [{ release_id: '37155918' }], error: null }); },
  };
  const sandbox = {
    supabase: { from: (t) => { calls.push(`from:${t}`); return chain; } },
    getSession: async () => ({ user: { id: 'u1' } }),
    ok: (extra = {}) => ({ success: true, ...extra }),
    fail: (e, fb = {}) => ({ success: false, error: e, ...fb }),
  };
  runIn(REMOVE, sandbox);
  const res = await sandbox.removeFromCollection(['37155918', '37155918']);
  check('removeFromCollection deletes only the named ids for the signed-in user',
    res.success && calls.join(' ') === 'from:vinyl_collection delete eq:user_id=u1 in:release_id=["37155918"]', calls.join(' '));
  calls.length = 0;
  const none = await sandbox.removeFromCollection([]);
  check('an empty id list never reaches the database', none.success && calls.length === 0);
}

process.exit(report() ? 1 : 0);
