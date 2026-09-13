// Share page parity — moods + play-history stats.
//
// The share page used to hardcode the original five moods, so renames and new
// moods in /vinyl never reached it (Core was invisible, Move still read
// "Energy"). It now builds MOODS from public_moods and derives Mood Patterns,
// cycle counts, and the Recent timeline from one public_play_events read.
//
// The owner app computes the same aggregates with separate queries in
// lib/supabase.js. This suite runs BOTH against the same rows and asserts
// they agree, so the two surfaces can't drift apart silently.

import { read, sliceTo, mustContain, runIn, check, report } from './lib/slice.mjs';

const SHARE = read('share/index.html');
const LIB = read('lib/supabase.js');

const BUILD_MOODS = sliceTo(SHARE, /^function buildMoods\(rows\)\{/, '}');
const PALETTE = sliceTo(SHARE, /^const MOOD_COLOR_PALETTE=\{/, '};');
const MOOD_ACTIVE = sliceTo(SHARE, /^function moodActiveArray\(ev\)\{/, '}');
const COUNT = sliceTo(SHARE, /^function countMoodEvents\(events\)\{/, '}');
const DERIVE = sliceTo(SHARE, /^function derivePlayEventData\(\)\{/, '}');
mustContain(SHARE, /crate\.loadPublicMoods\(/, 'the public_moods load');
mustContain(SHARE, /^let MOODS=\[\];$/m, 'a server-built (not hardcoded) MOODS');
mustContain(DERIVE, /inCycle/, 'the cycle-boundary filter');

const LIB_COUNTS = sliceTo(LIB, /^async function loadMoodEventCounts\(/, '}');
const LIB_CYCLE = sliceTo(LIB, /^async function loadCyclePlayCounts\(/, '}');
const LIB_TOP = sliceTo(LIB, /^async function loadMostPlayedByMood\(/, '}');
const LIB_LAST = sliceTo(LIB, /^async function loadMoodLastPlayed\(/, '}');

// ── fixtures ──────────────────────────────────────────────────
const CYCLE_START = '2026-05-19T00:00:00Z';
const EVENTS = [ // newest first, as public_play_events returns them
  { release_id: 'A', played_at: '2026-09-12T23:00:00Z', mood_active: ['latenight', 'sunday'] },
  { release_id: 'B', played_at: '2026-09-11T16:00:00Z', mood_active: ['latenight', 'core'] },
  { release_id: 'A', played_at: '2026-09-10T15:00:00Z', mood_active: ['energy'] },
  { release_id: 'C', played_at: '2026-08-01T10:00:00Z', mood_active: null },
  { release_id: 'A', played_at: '2026-06-01T10:00:00Z', mood_active: 'energy' }, // legacy string
  { release_id: 'D', played_at: '2026-05-01T10:00:00Z', mood_active: ['energy'] }, // before cycle
];

// Minimal PostgREST stand-in: select/eq/gte over the fixture rows.
function fakeSupabase(rows) {
  return {
    from: () => {
      let out = rows.map((r) => ({ ...r, user_id: 'u1' }));
      const q = {
        select: () => q,
        eq: (col, v) => { out = out.filter((r) => r[col] === v); return q; },
        gte: (col, v) => { out = out.filter((r) => new Date(r[col]) >= new Date(v)); return q; },
        then: (res) => res({ data: out, error: null }),
      };
      return q;
    },
  };
}

function libSandbox(rows) {
  const sb = {
    supabase: fakeSupabase(rows),
    ok: (extra = {}) => ({ success: true, ...extra }),
    fail: (e, fb = {}) => ({ success: false, error: e, ...fb }),
    console,
  };
  runIn([LIB_COUNTS, LIB_CYCLE, LIB_TOP, LIB_LAST].join('\n'), sb);
  return sb;
}

function shareSandbox(events, cycleStartedAt) {
  const sb = { playEvents: events, cycleStartedAt, Date, console };
  runIn([MOOD_ACTIVE, COUNT, DERIVE, 'derivePlayEventData();'].join('\n'), sb);
  return sb;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

// ── header logo ───────────────────────────────────────────────
// The share page kept the retired "EC" mark after /vinyl moved to the record
// logo. Compare the header SVGs so the next logo change can't skip one page.
{
  const logoSvg = (html) => ((html.match(/<div class="logo">\s*(<svg[\s\S]*?<\/svg>)/) || [])[1] || '').replace(/\s+/g, ' ');
  const priv = logoSvg(read('index.html'));
  check('share page header logo matches /vinyl', priv.length > 0 && logoSvg(SHARE) === priv);
  const retired = logoSvg(SHARE.replace(/<div class="logo">\s*<svg[\s\S]*?<\/svg>/, '<div class="logo"><svg width="28" height="28"><text>EC</text></svg>'));
  check('negative: the retired EC mark fails the comparison', retired !== priv);
}

// ── pieces copied verbatim from /vinyl ────────────────────────
// Theme palettes, rating stars, last-played wording, condition shorthand, and
// the Most Played sort were each re-implemented slightly differently on the
// share page. They're now copies; these checks keep them copies.
{
  const PRIV = read('index.html');
  const block = (src, startRe, end) => { try { return sliceTo(src, startRe, end).replace(/\s+/g, ' '); } catch { return null; } };
  const same = (label, startRe, end) => {
    const p = block(PRIV, startRe, end), q = block(SHARE, startRe, end);
    check(`${label} matches /vinyl`, !!p && p === q, p && q ? '' : 'missing on one page');
  };
  same('THEMES palette list', /^const THEMES=\{/, '};');
  const line = (src, re) => (src.split('\n').find(l => re.test(l)) || null);
  check('stars() matches /vinyl', !!line(PRIV, /^function stars\(n\)/) && line(PRIV, /^function stars\(n\)/) === line(SHARE, /^function stars\(n\)/));
  same('formatLastPlayed()', /^function formatLastPlayed\(/, '}');
  same('shortCondition()', /^function shortCondition\(c\)\{/, '}');
  same('sortPlaysList()', /^function sortPlaysList\(records\)\{/, '}');
  check('share page applies the owner theme from public_settings',
    /loadPublicSettings\(\{userId:ownerUserId\}\)/.test(SHARE) && /applyTheme\(settings\.success/.test(SHARE));
}

// ── moods ─────────────────────────────────────────────────────
{
  const sb = runIn(`${PALETTE}\n${BUILD_MOODS}`, {});
  const moods = sb.buildMoods([
    { slug: 'energy', mood_name: 'Move', color_key: 'teal', sort_order: 2 },
    { slug: 'core', mood_name: 'Core', color_key: 'red', sort_order: 5 },
    { slug: 'odd', mood_name: 'Odd', color_key: 'not-a-key', sort_order: 9 },
  ]);
  check('moods take their label from the owner vocabulary', moods[0].id === 'energy' && moods[0].label === 'Move');
  check('a mood added after the original five renders (Core)', moods.some((m) => m.id === 'core' && m.color === '#ef4444'));
  check('unknown color_key falls back to blue, not undefined', moods[2].color === '#3b82f6');
}

// ── play-history parity with lib/supabase.js ──────────────────
const lib = libSandbox(EVENTS);
const share = shareSandbox(EVENTS, CYCLE_START);
const libAll = (await lib.loadMoodEventCounts({ userId: 'u1' })).data;
const libCycle = (await lib.loadMoodEventCounts({ userId: 'u1', since: CYCLE_START })).data;
const libCycleCounts = (await lib.loadCyclePlayCounts({ userId: 'u1', since: CYCLE_START })).data;
const libTop = (await lib.loadMostPlayedByMood({ userId: 'u1' })).data;
const libLast = (await lib.loadMoodLastPlayed({ userId: 'u1' })).data;

check('all-time mood mix matches loadMoodEventCounts',
  share._mpData.all.totalPlays === libAll.totalPlays && same(sortKeys(share._mpData.all.counts), sortKeys(libAll.counts)),
  JSON.stringify(share._mpData.all));
check('cycle mood mix matches loadMoodEventCounts(since cycle start)',
  share._mpData.cycle.totalPlays === libCycle.totalPlays && same(sortKeys(share._mpData.cycle.counts), sortKeys(libCycle.counts)));
check('"This cycle N" matches loadCyclePlayCounts', same(sortKeys(share.cycleCounts), sortKeys(libCycleCounts)),
  JSON.stringify(share.cycleCounts));
check('most-played per mood matches loadMostPlayedByMood', same(sortKeys(share._mpData.mostPlayed), sortKeys(libTop)));
check('last play per mood matches loadMoodLastPlayed', same(sortKeys(share._mpData.lastPlayed), sortKeys(libLast)));

// ── behaviour the parity checks rely on ───────────────────────
check('a play before the cycle start is excluded from this cycle', !('D' in share.cycleCounts) && share._mpData.all.counts.energy === 2 && share._mpData.cycle.counts.energy === 1);
check('a multi-mood play credits each mood but counts once', share._mpData.all.counts.latenight === 2 && share._mpData.all.totalPlays === 4);
check('a null-mood play counts toward the cycle but not the mix', share.cycleCounts.C === 1 && share._mpData.cycle.totalPlays === 3);
check('a legacy string mood_active counts as a play but not toward the mix, like the owner queries', share.cycleCounts.A === 3 && share._mpData.all.counts.energy === 2);
check('the mini-donut reads the same all-time mix', share.moodMixAllTime === share._mpData.all);

{
  const noBoundary = shareSandbox(EVENTS, null);
  check('with no cycle start yet, every play is in the first cycle', noBoundary.cycleCounts.D === 1 && noBoundary._mpData.cycle.totalPlays === noBoundary._mpData.all.totalPlays);
  const many = Array.from({ length: 620 }, (_, i) => ({ release_id: 'R' + i, played_at: new Date(Date.UTC(2026, 8, 1) - i * 6e4).toISOString(), mood_active: ['energy'] }));
  check('streak/day/time tiles scan the newest 500, like loadRecentPlays(500)', shareSandbox(many, null)._mpData.recentForStreak.length === 500);
}

// Negative case: drop the cycle-boundary filter and the parity check must fail.
{
  const broken = DERIVE.replace(/const inCycle=[^;]+;/, 'const inCycle=playEvents;');
  const sb = { playEvents: EVENTS, cycleStartedAt: CYCLE_START, Date, console };
  runIn([MOOD_ACTIVE, COUNT, broken, 'derivePlayEventData();'].join('\n'), sb);
  check('negative: without the boundary filter, cycle counts diverge from the owner app', !same(sortKeys(sb.cycleCounts), sortKeys(libCycleCounts)));
}

process.exit(report());
