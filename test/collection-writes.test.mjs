// P0 Defect 2 — durable collection writes.
//
// saveCollectionToAPI was fire-and-forget at all four call sites. Desktop tabs
// stay open long enough for the promise to land; Android suspends and kills it.
// John had 187 vinyl_meta rows and 0 vinyl_collection rows — never written,
// not deleted. Awaiting is necessary but not sufficient: an error-free partial
// write is indistinguishable from success, so saveCollection now asserts the
// returned row count matches what was sent.

import { read, sliceTo, mustContain, runIn, check, report } from './lib/slice.mjs';

const SAVE_COLLECTION = sliceTo(read('lib/supabase.js'), /^async function saveCollection\(records\) \{/, '}');
const SAVE_TO_API = sliceTo(read('index.html'), /^async function saveCollectionToAPI\(records\)\{/, '}');
mustContain(SAVE_COLLECTION, /partial collection write/, 'the row-count assertion');
mustContain(SAVE_COLLECTION, /byId\.set/, 'the pre-upsert dedupe');
mustContain(SAVE_TO_API, /throw new Error/, 'the throw-on-failure path');

function makeLib({ rowsReturned = null, error = null } = {}) {
  const calls = { selected: null };
  const sandbox = {
    ok: (extra = {}) => ({ success: true, ...extra }),
    fail: (e, fb = {}) => ({ success: false, error: e, ...fb }),
    supabase: {
      from: () => ({
        upsert: (rows) => ({
          select: (cols) => {
            calls.selected = cols;
            const n = rowsReturned === null ? rows.length : rowsReturned;
            return Promise.resolve({
              data: error ? null : rows.slice(0, n).map((r) => ({ release_id: r.release_id })),
              error,
            });
          },
        }),
      }),
    },
    console,
  };
  runIn(SAVE_COLLECTION, sandbox);
  return { saveCollection: sandbox.saveCollection, calls };
}

function makeApi({ saveResult, token = 'TOK' }) {
  const log = { toasts: [], saveCalls: 0 };
  const sandbox = {
    token,
    crate: { saveCollection: async () => { log.saveCalls++; return saveResult; } },
    showToast: (m) => log.toasts.push(m),
    console,
  };
  runIn(SAVE_TO_API, sandbox);
  return { fn: sandbox.saveCollectionToAPI, log };
}

const recs = Array.from({ length: 187 }, (_, i) => ({ releaseId: i + 1, mediaCondition: 'VG+' }));

{
  const { saveCollection, calls } = makeLib();
  const res = await saveCollection(recs);
  check('full write returns success', res.success === true && calls.selected === 'release_id');
}

// THE FIX: a partial write must not report success.
{
  const { saveCollection } = makeLib({ rowsReturned: 100 });
  const res = await saveCollection(recs);
  check('partial write (100/187) reports failure',
    res.success === false && /partial collection write: 100\/187/.test(res.error?.message || ''),
    res.error?.message || '');
}

// NEGATIVE-CASE SIBLING: a silently dropped write is the exact shape of John's bug.
{
  const { saveCollection } = makeLib({ rowsReturned: 0 });
  const res = await saveCollection(recs);
  check('silently dropped write (0/187) reports failure', res.success === false);
}

// Duplicates must dedupe, not read as a partial write. Owning two copies of the
// same pressing would otherwise fail every sync, and would also trip Postgres's
// "ON CONFLICT DO UPDATE command cannot affect row a second time".
{
  const { saveCollection } = makeLib();
  const res = await saveCollection([
    { releaseId: 1, mediaCondition: 'VG+' },
    { releaseId: 2, mediaCondition: 'NM' },
    { releaseId: 1, mediaCondition: 'G' },
  ]);
  check('duplicate release_ids dedupe instead of failing',
    res.success === true && /Saved 2 records/.test(res.message || ''), res.message || '');
}

{
  const { fn, log } = makeApi({ saveResult: { success: false, error: { message: 'partial collection write: 0/187 rows persisted' } } });
  let threw = false;
  try { await fn(recs); } catch { threw = true; }
  check('saveCollectionToAPI throws + toasts on failure', threw && log.toasts.length === 1);
}

{
  const { fn, log } = makeApi({ saveResult: { success: true } });
  let threw = false;
  try { await fn(recs); } catch { threw = true; }
  check('saveCollectionToAPI is silent on success', !threw && log.toasts.length === 0);
}

// The regression the bare `!token` guard was one refactor away from: `token`
// holds the OAuth access token for OAuth users, so testing it bare conflates
// "no credentials" with "OAuth user".
{
  const { fn, log } = makeApi({ saveResult: { success: true }, token: 'OAUTH_ACCESS_TOKEN' });
  await fn([{ releaseId: 1 }]);
  check('authenticated user without mediaCondition still writes', log.saveCalls === 1);
}

{
  const { fn, log } = makeApi({ saveResult: { success: true }, token: '' });
  await fn([{ releaseId: 1 }]);
  check('unauthenticated condition-less write is skipped', log.saveCalls === 0);
}

process.exit(report() ? 1 : 0);
