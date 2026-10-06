// §12 front moment: the closing play queues it, it waits for other surfaces,
// then hands off to the Crate Complete card.
//
// Slices queueCycleComplete out of index.html and runs it with a stub
// playCycleMoment and a controllable blocker, on a fake clock. Also guards the
// markup rules: no emoji, no static cycle number, and logPlay no longer opens
// the card directly (that was the thin modal §12 replaces).

import { execSync } from 'child_process';
import { read, sliceTo, mustContain, runIn, check, report, REPO } from './lib/slice.mjs';

const APP = read('index.html');

// ── markup and wiring
const markup = APP.slice(APP.indexOf('<div id="cycleMoment"'), APP.indexOf('<div id="resetModal"'));
mustContain(markup, /class="cycle-moment"/, 'the front moment markup');
check('cycle number is not static in the markup', /<p class="cm-title" id="cmTitle"><\/p>/.test(markup));
check('no emoji in the moment or the card',
  !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(markup + APP.slice(APP.indexOf('<div id="resetModal"'), APP.indexOf('<!-- Clear All Data'))));
const logPlay = sliceTo(APP, /^async function logPlay\(/, '}');
check('the closing play queues the moment', /allIds\.every\(id=>cycleLog\[id\]\)\)queueCycleComplete\(\);/.test(logPlay));
check('the closing play no longer opens the card directly', !/resetModal/.test(logPlay));
check('the recap counts as a blocker for other pop-ups', /getElementById\('cycleRecap'\)\?\.classList\.contains\('on'\)/.test(APP));
check('the moment counts as a blocker for other pop-ups', /getElementById\('cycleMoment'\)\?\.classList\.contains\('on'\)/.test(APP));
check('the moment respects the celebration-sounds setting', /function playRunoutSound\(\)\{\s*if\(!celebrationSounds\)return;/.test(APP));
check('reduced motion stops the animation', /@media \(prefers-reduced-motion:reduce\)\{\s*\.cm-record,\.cm-arm/.test(APP));

// ── behavior on a fake clock
// From the queued flag through the end of queueCycleComplete.
const fn = sliceTo(APP, /^let _cycleCompleteQueued=false;/, '}');
mustContain(fn, /function queueCycleComplete\(\)\{/, 'queueCycleComplete');
function harness({ recapShown = true } = {}) {
  let now = 0; const timers = [];
  const log = [];
  const card = { style: { display: 'none' } };
  let blocked = true;
  const sb = runIn(fn, {
    currentCycle: 2,
    anyUpdateBlockerActive: () => blocked,
    playCycleMoment: async (n) => { log.push('moment ' + n); },
    crate: { loadCycleRecap: (w) => { log.push('load ' + JSON.stringify(w)); return Promise.resolve({ success: recapShown }); } },
    playRecap: async (p, opts) => { await p; log.push('recap closing=' + opts.closing); return recapShown; },
    $: (id) => (id === 'resetModal' ? card : {}),
    setTimeout: (f, ms) => timers.push({ at: now + ms, f }),
  });
  async function advance(ms) {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      if (!timers.length || timers[0].at > end) break;
      const t = timers.shift(); now = t.at; await t.f();
    }
    now = end;
  }
  return { sb, log, card, advance, unblock: () => { blocked = false; } };
}

const h = harness();
h.sb.queueCycleComplete();
h.sb.queueCycleComplete();                      // a second closing call is ignored
await h.advance(5000);
check('waits while another surface is open', h.log.length === 0 && h.card.style.display === 'none', h.log.join(', '));
h.unblock();
await h.advance(1000);
check('loads the recap as the moment starts, then plays the slides',
  h.log.join(', ') === 'load {"closing":true}, moment 2, recap closing=true', h.log.join(', '));
check('a shown recap replaces the Crate Complete card', h.card.style.display === 'none');

// No recap (offline, server error): the old card still offers the reset.
const f = harness({ recapShown: false });
f.unblock();
f.sb.queueCycleComplete();
await f.advance(2000);
check('without a recap, falls back to the Crate Complete card', f.card.style.display === 'flex', f.log.join(', '));

// Negative case: before the moment, the closing play opened the thin card directly.
let old = null;
try { old = execSync('git show 580fa6b:index.html', { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { /* no history */ }
if (old) {
  const oldLogPlay = sliceTo(old, /^async function logPlay\(/, '}');
  check('negative: the old closing play skips the moment', !/queueCycleComplete/.test(oldLogPlay) && /resetModal/.test(oldLogPlay));
} else {
  console.log('SKIP  negative case: git history for 580fa6b not available');
}

process.exit(report() ? 1 : 0);
