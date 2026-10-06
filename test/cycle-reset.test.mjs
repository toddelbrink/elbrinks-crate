// Reset Cycle saves the closing cycle before it starts the next one.
//
// The reset stamps vinyl_user_profile.cycle_started_at with the reset time,
// which overwrites the only record of when the closing cycle began. Without
// that date the §12 recap can never be built for it. Todd finished Cycle 2 on
// 2026-10-06 and held his reset until this shipped.
//
// Slices resetCycle out of lib/supabase.js and runs it against a stub client
// that records every call in order.

import { execSync } from 'child_process';
import { read, sliceTo, mustContain, runIn, check, report, REPO } from './lib/slice.mjs';

function stubClient({ startedAt, events, failUpsert = false }) {
  const calls = [];
  const client = {
    from(table) {
      const q = { table, ops: [] };
      const b = {
        select(c) { q.ops.push('select'); q.cols = c; return b; },
        eq() { return b; }, neq() { return b; }, order() { return b; },
        gte(col, v) { q.gte = v; return b; },
        maybeSingle() { q.single = true; return b; },
        upsert(row, opts) { q.ops.push('upsert'); q.row = row; q.opts = opts; return b; },
        update(f) { q.ops.push('update'); q.fields = f; return b; },
        then(res, rej) {
          calls.push(q);
          let out = { data: null, error: null };
          if (q.table === 'vinyl_user_profile' && q.single) out.data = { cycle_started_at: startedAt };
          else if (q.table === 'vinyl_play_events') out.data = events.filter((e) => !q.gte || e.played_at >= q.gte);
          else if (q.table === 'vinyl_cycle_recaps' && failUpsert) out.error = new Error('insert failed');
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
  return { res, calls };
}

const SRC = read('lib/supabase.js');
mustContain(SRC, /vinyl_cycle_recaps/, 'the cycle-history save');

const events = [
  { played_at: '2026-05-01T00:00:00Z' },   // before the boundary: an earlier cycle
  { played_at: '2026-05-19T00:28:56Z' },
  { played_at: '2026-07-04T20:00:00Z' },
  { played_at: '2026-10-06T13:03:58Z' },
];

// 1. Normal close: Cycle 2, boundary set.
let { res, calls } = await run(SRC, { startedAt: '2026-05-19T00:24:00Z', events }, { closingCycle: 2 });
const save = calls.find((c) => c.table === 'vinyl_cycle_recaps');
check('reset succeeds', res.success === true);
check('saves the closing cycle', !!save && save.row.cycle_number === 2, JSON.stringify(save && save.row));
check('start is the old boundary', save && save.row.start_date === '2026-05-19T00:24:00Z');
check('end is the last play, not the reset', save && save.row.end_date === '2026-10-06T13:03:58Z');
check('plays counted inside the cycle only', save && save.row.total_plays === 3, String(save && save.row.total_plays));
check('never overwrites an existing saved cycle', save && save.opts && save.opts.ignoreDuplicates === true);
const order = calls.map((c) => c.table + ':' + c.ops.join('+'));
const iSave = order.indexOf('vinyl_cycle_recaps:upsert');
const iStamp = order.lastIndexOf('vinyl_user_profile:update');
check('saves before stamping the new boundary', iSave > -1 && iStamp > iSave, order.join(' > '));

// 2. First cycle: no boundary yet, so the cycle began with the first play.
({ res, calls } = await run(SRC, { startedAt: null, events }, { closingCycle: 1 }));
const save1 = calls.find((c) => c.table === 'vinyl_cycle_recaps');
check('first cycle starts at the first play', save1 && save1.row.start_date === '2026-05-01T00:00:00Z');
check('first cycle counts every play', save1 && save1.row.total_plays === 4);

// 3. The save fails: nothing is reset.
({ res, calls } = await run(SRC, { startedAt: '2026-05-19T00:24:00Z', events, failUpsert: true }, { closingCycle: 2 }));
check('a failed save fails the reset', res.success === false);
check('a failed save leaves plays and the boundary untouched',
  !calls.some((c) => c.ops.includes('update')), calls.map((c) => c.table + ':' + c.ops.join('+')).join(' > '));

// Negative case: the wrapper before this change never saved the cycle.
let old = null;
try { old = execSync('git show c71f03e:lib/supabase.js', { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { /* no history */ }
if (old) {
  const o = await run(old, { startedAt: '2026-05-19T00:24:00Z', events }, { closingCycle: 2 });
  check('negative: the old wrapper stamped a new boundary without saving',
    !o.calls.some((c) => c.table === 'vinyl_cycle_recaps') && o.calls.some((c) => c.table === 'vinyl_user_profile' && c.ops.includes('update')));
} else {
  console.log('SKIP  negative case: git history for c71f03e not available');
}

process.exit(report() ? 1 : 0);
