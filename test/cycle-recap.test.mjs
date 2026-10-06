// §12 step 4: computeRecap turns a cycle's play events into the recap data.
//
// lib/recap.js is a real ES module with no database or network, so this suite
// imports it directly (no slicing needed) and runs it on fixtures shaped like
// Todd's Cycle 2: a long cycle, mostly one mood, a most-played tie at 2 plays,
// no play history before the cycle and no saved Cycle 1.
// Also checks the bridge prompt and schema the API builds from it.

import { computeRecap, recapSlides, SYSTEM_PROMPT, bridgePrompt, bridgeSchema } from '../lib/recap.js';
import { check, report } from './lib/slice.mjs';

const records = {
  a: { title: 'Lateralus', artist: 'Tool' },
  b: { title: 'Parcels', artist: 'Parcels' },
  c: { title: 'Currents', artist: 'Moontricks' },
  d: { title: 'Mezzanine', artist: 'Massive Attack' },
};
const moodNames = { energy: 'Move', latenight: 'Late', sunday: 'Sunday' };
const ev = (id, at, moods) => ({ release_id: id, played_at: at, mood_active: moods });
const events = [
  ev('b', '2026-05-23T15:00:00Z', ['energy', 'sunday']),
  ev('d', '2026-06-01T20:00:00Z', ['latenight']),
  ev('b', '2026-05-31T19:00:00Z', ['energy']),          // out of order on purpose
  ev('c', '2026-08-24T23:00:00Z', ['energy']),
  ev('c', '2026-08-28T01:00:00Z', ['energy']),
  ev('a', '2026-10-06T13:03:58Z', ['energy']),
];

// ── cycle 2 with no history and no saved cycle 1
const r = computeRecap({
  cycleNumber: 2, start: '2026-05-19T00:24:00Z', end: '2026-10-06T13:03:58Z',
  events, priorEvents: [], records, art: { a: 'https://img/a.jpg' }, moodNames, previous: null,
});
check('days rounds up from the boundary to the last play', r.days === 141, String(r.days));
check('plays and records played', r.plays === 6 && r.records_played === 4);
check('months ran', r.started.month === 'May' && r.ended.month === 'October');
check('closer is the last play by time, not by input order', r.closer && r.closer.title === 'Lateralus' && r.closer.art === 'https://img/a.jpg');
check('most played tie goes to the more recent', r.most_played && r.most_played.title === 'Currents' && r.most_played.play_count === 2,
  JSON.stringify(r.most_played));
check('mood mix counts a multi-mood play toward each mood', r.mood_mix[0].name === 'Move' && r.mood_mix[0].count === 5, JSON.stringify(r.mood_mix));
check('mood share is of all tags, so shares total 100%', Math.abs(r.mood_mix[0].share - 5 / 7) < 1e-9 &&
  Math.abs(r.mood_mix.reduce((a, m) => a + m.share, 0) - 1) < 1e-9);
check('recap carries the current version', r.version === 2);
check('returning is null with no history before the cycle', r.returning === null);
check('cycle over cycle is null with no saved previous cycle', r.cycle_over_cycle === null);
check('repeats lists records played twice or more, heaviest then latest', r.repeats.map((x) => x.release_id).join(',') === 'c,b');
check('slides skip what has no data', recapSlides(r).join(',') === 'scale,closer,most_played,mood_mix');

// ── cycle 3 with history and a saved cycle 2: the extra slides appear
const r3 = computeRecap({
  cycleNumber: 3, start: '2027-03-01T00:00:00Z', end: '2027-09-01T00:00:00Z',
  events: [ev('d', '2027-03-10T20:00:00Z', ['latenight']), ev('b', '2027-04-01T20:00:00Z', ['latenight'])],
  priorEvents: [ev('d', '2026-06-01T20:00:00Z'), ev('b', '2027-02-20T20:00:00Z')],
  records, moodNames, previous: r,
});
check('returning finds a record unplayed for 6+ months', r3.returning && r3.returning.length === 1 && r3.returning[0].title === 'Mezzanine',
  JSON.stringify(r3.returning));
check('returning skips a record played just before the cycle', !(r3.returning || []).some((x) => x.title === 'Parcels'));
check('cycle over cycle compares against the saved previous cycle',
  r3.cycle_over_cycle && r3.cycle_over_cycle.previous_cycle === 2 && r3.cycle_over_cycle.top_mood.before === 'Move' && r3.cycle_over_cycle.top_mood.now === 'Late',
  JSON.stringify(r3.cycle_over_cycle));
check('cycle 3 shows all six slides', recapSlides(r3).length === 6);

// ── cycle 1: never the cycle 2+ slides, even with data
const r1 = computeRecap({ cycleNumber: 1, start: '2026-01-01T00:00:00Z', end: '2026-05-01T00:00:00Z', events, priorEvents: events, records, previous: r });
check('cycle 1 never shows returning or cycle over cycle', r1.returning === null && r1.cycle_over_cycle === null && recapSlides(r1).length === 4);

// ── single record, unknown release
const one = computeRecap({ cycleNumber: 1, start: '2026-01-01T00:00:00Z', end: '2026-01-01T00:00:00Z', events: [ev('zz', '2026-01-01T00:00:00Z', null)], records });
check('single-record cycle still renders (1 day, fallback title)', one.days === 1 && one.closer.title === 'Unknown record' && one.mood_mix.length === 0);
check('a cycle with no moods drops the mood slide', !recapSlides(one).includes('mood_mix'));

// ── the bridge prompt carries the facts and asks only for present slides
const prompt = bridgePrompt(r, recapSlides(r));
check('prompt names the closer and the most played', /Lateralus by Tool/.test(prompt) && /Currents by Moontricks, 2 plays/.test(prompt));
check('prompt asks only for the slides shown', /slides: scale, closer, most_played, mood_mix\.$/.test(prompt) && !/returning/.test(prompt.split('\n').pop()));
check('system prompt holds the register', /earned recognition/.test(SYSTEM_PROMPT) && /no emoji/.test(SYSTEM_PROMPT) && /Never invent/.test(SYSTEM_PROMPT));
check('system prompt keeps unsure record details out', /running times, track counts/.test(SYSTEM_PROMPT));

check('schema requires exactly the shown slides and nothing else',
  JSON.stringify(bridgeSchema(['scale', 'closer']).required) === '["scale","closer"]' && bridgeSchema(['scale']).additionalProperties === false);

// Negative case: an unsorted input must not decide the closer.
const shuffled = computeRecap({ cycleNumber: 2, start: '2026-05-19T00:24:00Z', end: '2026-10-06T13:03:58Z', events: [...events].reverse(), records });
check('negative: reversed input gives the same closer', shuffled.closer.title === 'Lateralus');

process.exit(report() ? 1 : 0);
