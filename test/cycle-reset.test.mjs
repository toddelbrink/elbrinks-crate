// Reset Cycle: the database saves the closing cycle, the app only stamps.
//
// The reset stamps vinyl_user_profile.cycle_started_at with the reset time,
// overwriting the only record of when the closing cycle began. Without that
// date the §12 recap can never be built for it.
//
// 2026-10-06: a client-side save shipped in the morning (580fa6b) and Todd's
// Cycle 2 reset still saved nothing, either from a stale app window or a
// silent skip on a non-integer cycle number. It was restored by hand. The save
// moved into the database: the save_closing_cycle trigger writes the row in
// the same statement as the stamp (migration v1_1_step12_cycle_recap_trigger,
// tested in a rolled-back transaction against real rows). This suite guards
// the client half: it must not write the row itself (that would now make two),
// it must stamp before it clears played flags, and a failed stamp must clear
// nothing.
//
// Slices resetCycle out of lib/supabase.js and runs it against a stub client
// that records every call in order.

import { execSync } from 'child_process';
import { read, sliceTo, mustContain, runIn, check, report, REPO } from './lib/slice.mjs';

function stubClient({ failStamp = false } = {}) {
  const calls = [];
  const client = {
    from(table) {
      const q = { table, ops: [] };
      const b = {
        select() { q.ops.push('select'); return b; },
        eq() { return b; }, neq() { return b; }, order() { return b; }, gte() { return b; },
        maybeSingle() { return b; },
        upsert(row) { q.ops.push('upsert'); q.row = row; return b; },
        update(f) { q.ops.push('update'); q.fields = f; return b; },
        then(res, rej) {
          calls.push(q);
          const out = { data: null, error: null };
          if (q.table === 'vinyl_user_profile' && q.ops.includes('update') && failStamp) out.error = new Error('trigger: insert failed');
          return Promise.resolve(out).then(res, rej);
        },
      };
      return b;
    },
  };
  return { client, calls };
}

async function run(src, opts, args) {
  const fn = sliceTo(src, /^async function resetCycle\(/, '}');
  const { client, calls } = stubClient(opts);
  const sb = runIn(fn, {
    supabase: client,
    getSession: async () => ({ user: { id: 'u1' } }),
    ok: (x = {}) => ({ success: true, ...x }),
    fail: (e) => ({ success: false, error: e }),
    Date, Number, console, Promise,
  });
  const res = await sb.resetCycle(args);
  return { res, calls, order: calls.map((c) => c.table + ':' + c.ops.join('+')) };
}

const SRC = read('lib/supabase.js');
mustContain(SRC, /save_closing_cycle/, 'the pointer to the database trigger');

// 1. Normal reset.
let r = await run(SRC, {}, { closingCycle: 2 });
check('reset succeeds', r.res.success === true);
check('returns the new boundary', !!(r.res.data && r.res.data.cycle_started_at));
check('the app never writes vinyl_cycle_recaps (the trigger does)', !r.calls.some((c) => c.table === 'vinyl_cycle_recaps'), r.order.join(' > '));
const iStamp = r.order.indexOf('vinyl_user_profile:update');
const iFlip = r.order.indexOf('vinyl_plays:update');
check('stamps the boundary before clearing played flags', iStamp > -1 && iFlip > iStamp, r.order.join(' > '));

// 2. The trigger's save fails, so the stamp fails: nothing else changes.
r = await run(SRC, { failStamp: true }, {});
check('a failed save fails the reset', r.res.success === false);
check('a failed save leaves every played flag alone', !r.calls.some((c) => c.table === 'vinyl_plays'), r.order.join(' > '));

// 3. Older callers that still pass closingCycle keep working.
r = await run(SRC, {}, undefined);
check('works with no arguments', r.res.success === true);

// The app's caller must not pass a cycle number any more, and must check success.
const APP = read('index.html');
check('the app calls resetCycle() with no cycle number', /const res=await crate\.resetCycle\(\);/.test(APP));

// Negative case: the 580fa6b wrapper wrote the row from the client, which
// would now duplicate the trigger's row.
let old = null;
try { old = execSync('git show 580fa6b:lib/supabase.js', { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { /* no history */ }
if (old) {
  const o = await run(old, {}, { closingCycle: 2 });
  check('negative: the 580fa6b wrapper writes the row itself', o.calls.some((c) => c.table === 'vinyl_cycle_recaps'));
} else {
  console.log('SKIP  negative case: git history for 580fa6b not available');
}

process.exit(report() ? 1 : 0);
