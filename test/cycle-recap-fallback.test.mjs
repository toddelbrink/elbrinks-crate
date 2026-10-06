// §12 step 11: the recap never waits on Claude (specs/v1_1.md §12.13).
//
// Runs the real api/cycle-recap.js handler. The two package imports
// (@anthropic-ai/sdk, @supabase/supabase-js) are swapped for in-memory fakes
// and the rest of the file loads verbatim, so this tests what ships. Cases:
//   1. Claude down on first open: 200, stats computed and stored, bridges
//      null with the error named, nothing about bridges stored.
//   2. Claude back on the next open: bridges written and stored.
//   3. A later open reads the stored copy: no Claude call.
//   4. Claude declines (stop_reason refusal): same as down.
//   5. A reply missing a slide: rejected, nothing stored.
//   6. No ANTHROPIC_API_KEY: stats still return.

import fs from 'fs';
import path from 'path';
import url from 'url';
import { REPO, check, report } from './lib/slice.mjs';

// ── load the handler with the two packages swapped for fakes
const SRC_PATH = path.join(REPO, 'api/cycle-recap.js');
let src = fs.readFileSync(SRC_PATH, 'utf8');
const imports = [
  [`import Anthropic from '@anthropic-ai/sdk';`, `const Anthropic = globalThis.__FakeAnthropic;`],
  [`import { createClient } from '@supabase/supabase-js';`, `const createClient = globalThis.__fakeCreateClient;`],
  [`from '../lib/recap.js';`, `from '${url.pathToFileURL(path.join(REPO, 'lib/recap.js')).href}';`],
];
for (const [a, b] of imports) {
  if (!src.includes(a)) throw new Error('import not found, test is stale: ' + a);
  src = src.replace(a, b);
}

// ── fake Supabase: a few tables in memory, enough of the query builder
const USER = 'u1';
let db;
function freshDb() {
  db = {
    vinyl_cycle_recaps: [{ user_id: USER, cycle_number: 2, start_date: '2026-05-19T00:24:00Z', end_date: '2026-10-06T13:03:58Z',
      total_plays: 3, recap_data: { status: 'pending' }, bridges: null, created_at: '2026-10-06T13:51:07Z' }],
    vinyl_play_events: [
      { user_id: USER, release_id: 'b', played_at: '2026-05-23T15:00:00Z', mood_active: ['energy'] },
      { user_id: USER, release_id: 'b', played_at: '2026-06-01T15:00:00Z', mood_active: ['energy'] },
      { user_id: USER, release_id: 'a', played_at: '2026-10-06T13:03:58Z', mood_active: ['sunday'] },
    ],
    vinyl_collection: [
      { user_id: USER, release_id: 'a', data: { title: 'Lateralus', artist: 'Tool' } },
      { user_id: USER, release_id: 'b', data: { title: 'Parcels', artist: 'Parcels' } },
    ],
    vinyl_meta: [], vinyl_user_moods: [{ slug: 'energy', mood_name: 'Move' }, { slug: 'sunday', mood_name: 'Sunday' }],
    vinyl_user_profile: [{ user_id: USER, cycle_started_at: '2026-10-06T13:51:07Z' }],
  };
}
globalThis.__fakeCreateClient = () => ({
  auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) },
  from(table) {
    const q = { filters: [], op: 'select' };
    const rows = () => db[table].filter((r) => q.filters.every((f) => f(r)));
    const b = {
      select() { return b; },
      eq(c, v) { q.filters.push((r) => String(r[c]) === String(v)); return b; },
      gte(c, v) { q.filters.push((r) => r[c] >= v); return b; },
      lte(c, v) { q.filters.push((r) => r[c] <= v); return b; },
      lt(c, v) { q.filters.push((r) => r[c] < v); return b; },
      order() { return b; }, limit() { return b; },
      maybeSingle() { q.single = true; return b; },
      update(fields) { q.op = 'update'; q.fields = fields; return b; },
      insert(row) { q.op = 'insert'; q.row = row; return b; },
      then(res, rej) {
        let out;
        if (q.op === 'update') { rows().forEach((r) => Object.assign(r, q.fields)); out = { data: null, error: null }; }
        else if (q.op === 'insert') { db[table].push(q.row); out = { data: null, error: null }; }
        else { const r = rows(); out = { data: q.single ? (r[0] || null) : r, error: null }; }
        return Promise.resolve(out).then(res, rej);
      },
    };
    return b;
  },
});

// ── fake Anthropic: behavior set per case, every call counted
let claude = { mode: 'down', calls: 0 };
globalThis.__FakeAnthropic = class {
  constructor() {
    this.beta = { messages: { create: async (params) => {
      claude.calls++;
      claude.lastSchema = params.output_config && params.output_config.format && params.output_config.format.schema;
      if (claude.mode === 'down') throw new Error('Connection error.');
      if (claude.mode === 'refuse') return { stop_reason: 'refusal', content: [] };
      const slides = claude.lastSchema.required;
      const body = {};
      for (const s of slides) body[s] = `A quiet line for ${s}.`;
      if (claude.mode === 'partial') delete body[slides[slides.length - 1]];
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(body) }] };
    } } };
  }
};

const mod = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src));
const handler = mod.default;
async function open(body = { cycle_number: 2 }) {
  return new Promise((resolve) => {
    const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; resolve(this); } };
    handler({ method: 'POST', headers: { authorization: 'Bearer jwt' }, body }, res);
  });
}
const row = () => db.vinyl_cycle_recaps[0];
const quiet = console.error; console.error = () => {};   // the handler logs failures by design

// 1. Claude down on first open
freshDb(); process.env.ANTHROPIC_API_KEY = 'test'; claude = { mode: 'down', calls: 0 };
let r = await open();
check('1. Claude down: still 200', r.code === 200, String(r.code));
check('1. stats come back', r.body.recap && r.body.recap.plays === 3 && r.body.recap.closer.title === 'Lateralus');
check('1. stats are stored', row().recap_data.version >= 3 && row().recap_data.plays === 3);
check('1. bridges null, the error named', r.body.bridges === null && /Connection error/.test(r.body.bridges_error || ''));
check('1. nothing stored for bridges', row().bridges === null);
// The negative case for this suite: the fallback is only meaningful if the
// call was really attempted and failed, not skipped.
check('1. negative: Claude was actually tried, not skipped', claude.calls === 1, String(claude.calls));

// 2. Claude back on the next open
claude.mode = 'ok'; const before = claude.calls;
r = await open();
check('2. Claude back: bridges filled', r.body.bridges && r.body.bridges.closer === 'A quiet line for closer.', JSON.stringify(r.body.bridges));
check('2. bridges stored', row().bridges && row().bridges.mood_mix === 'A quiet line for mood_mix.');
check('2. one Claude call for the fill', claude.calls === before + 1);
check('2. Claude was asked only for the slides shown', JSON.stringify(claude.lastSchema.required) === JSON.stringify(r.body.slides));

// 3. A later open reads the stored copy
const afterFill = claude.calls;
r = await open();
check('3. later open: no Claude call', claude.calls === afterFill);
check('3. later open: same stored bridges', r.body.bridges && r.body.bridges.scale === 'A quiet line for scale.');

// 4. Claude declines
freshDb(); claude = { mode: 'refuse', calls: 0 };
r = await open();
check('4. a refusal is handled like an outage', r.code === 200 && r.body.bridges === null && /declined/.test(r.body.bridges_error) && row().bridges === null);

// 5. A reply missing a slide
freshDb(); claude = { mode: 'partial', calls: 0 };
r = await open();
check('5. a reply missing a slide is rejected, nothing stored', r.body.bridges === null && /missing bridge/.test(r.body.bridges_error) && row().bridges === null);

// 6. No API key
freshDb(); delete process.env.ANTHROPIC_API_KEY; claude = { mode: 'ok', calls: 0 };
r = await open();
check('6. no key: stats still return, Claude never called', r.code === 200 && r.body.recap.plays === 3 && r.body.bridges === null && claude.calls === 0);

// Closing mode reuses the row the reset trigger would match (same start)
freshDb(); process.env.ANTHROPIC_API_KEY = 'test'; claude = { mode: 'ok', calls: 0 };
db.vinyl_cycle_recaps = []; db.vinyl_user_profile[0].cycle_started_at = '2026-05-19T00:24:00Z';
r = await open({ closing: true });
check('closing: saves the finished cycle as number 1 and opens it', r.code === 200 && r.body.cycle_number === 1 && db.vinyl_cycle_recaps.length === 1);
r = await open({ closing: true });
check('closing twice: reuses the same row, no duplicate', r.body.cycle_number === 1 && db.vinyl_cycle_recaps.length === 1);

console.error = quiet;
process.exit(report() ? 1 : 0);
