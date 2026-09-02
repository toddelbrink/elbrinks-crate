// P0 Defect 1 — OAuth completion detection.
//
// postMessage from the popup used to be the only completion signal. On Firefox
// Android window.open yields a real tab which Firefox unloads under memory
// pressure, so window.opener is gone when the callback fires. The credential
// write still succeeds inside the popup, so success and failure looked
// identical from the app's side. John looped on "Connect Discogs" for two
// months while holding valid tokens.
//
// These tests drive the two detection channels against stubs. The condition
// ("postMessage never arrives") is what the fix must survive, and it's fully
// reproducible on any browser — unlike the trigger (Android tab unload), which
// needs a device. Be precise about which one you've tested when reporting.

import { read, sliceBetween, mustContain, runIn, check, report, sleep } from './lib/slice.mjs';

const SRC = sliceBetween(
  read('index.html'),
  /^\/\/ ── OAuth completion detection/,
  /^\/\/ Re-read vinyl_settings after OAuth completes/
);
mustContain(SRC, /oauthCompletionHandled/, 'the single-fire guard');
mustContain(SRC, /setInterval/, 'the polling fallback');

function makeEnv({ existingToken = null, mode = null, onboarding = true, setupVisible = true, fakeClock = false } = {}) {
  const log = { toasts: [], firstSyncRuns: 0, reloads: 0, settingsReads: 0, cleared: 0 };
  // `let` bindings inside a vm are NOT reachable from the sandbox object (only
  // `var` and function declarations are). Internal state can only be observed
  // behaviourally — clock and clearInterval are the injection points.
  let now = Date.now();
  const clock = { now: () => now, advance: (ms) => { now += ms; } };
  let settingsRow = { discogs_oauth_token: existingToken, username: 'steffej3' };
  const listeners = { message: [], visibilitychange: [] };
  const setupCard = { style: { display: setupVisible ? 'block' : 'none' } };

  const sandbox = {
    discogsMode: mode,
    token: existingToken || '',
    onboardingInProgress: onboarding,
    crate: { loadSettings: async () => { log.settingsReads++; return { success: true, data: { ...settingsRow } }; } },
    reloadDiscogsCredentials: async () => { log.reloads++; },
    completeFirstSync: async () => { log.firstSyncRuns++; },
    showAutoSuggestConsent: async () => false,
    startAutoSuggestFetch: () => Promise.resolve(),
    showToast: (m) => log.toasts.push(m),
    $: (id) => (id === 'setupCard' ? setupCard : null),
    document: { visibilityState: 'visible', addEventListener: (e, f) => (listeners[e] ||= []).push(f) },
    window: { addEventListener: (e, f) => (listeners[e] ||= []).push(f), location: { origin: 'https://elbrink.com' } },
    setInterval,
    clearInterval: (t) => { log.cleared++; return clearInterval(t); },
    Date: fakeClock ? clock : Date,
    console,
  };
  runIn(SRC, sandbox);

  return {
    log, sandbox, clock,
    grantToken: (t) => { settingsRow = { discogs_oauth_token: t, username: 'steffej3' }; },
    fireMessage: (data) => Promise.all(listeners.message.map((f) => f({ origin: 'https://elbrink.com', data }))),
    fireVisible: () => Promise.all(listeners.visibilitychange.map((f) => f())),
  };
}

// 1. THE FIX. postMessage never arrives; the poll must complete onboarding.
{
  const e = makeEnv();
  e.sandbox.startOAuthWatch();
  e.grantToken('NEWTOKEN40CHARS');
  await sleep(3000);
  e.sandbox.stopOAuthWatch();
  check('poll completes onboarding when postMessage never fires',
    e.log.firstSyncRuns === 1 && e.log.reloads === 1,
    `firstSync=${e.log.firstSyncRuns} reload=${e.log.reloads}`);
}

// 2. NEGATIVE CASE. Without this the other tests prove nothing — a stub that
//    always reported success would pass all of them.
{
  const e = makeEnv();
  e.sandbox.startOAuthWatch();
  await sleep(3000);
  e.sandbox.stopOAuthWatch();
  check('poll does NOT report success when no credentials land',
    e.log.firstSyncRuns === 0, `firstSync=${e.log.firstSyncRuns}`);
}

// 3. Single-fire guard.
{
  const e = makeEnv();
  e.sandbox.startOAuthWatch();
  e.grantToken('NEWTOKEN40CHARS');
  await Promise.all([
    e.fireMessage({ source: 'discogs-oauth', status: 'success', username: 'steffej3' }),
    sleep(3000),
  ]);
  e.sandbox.stopOAuthWatch();
  check('postMessage + poll together run completeFirstSync exactly once',
    e.log.firstSyncRuns === 1, `firstSync=${e.log.firstSyncRuns}`);
}

// 4. Settings reconnect must not false-positive off the pre-existing token.
{
  const e = makeEnv({ existingToken: 'OLDTOKEN40CHARS', mode: 'oauth', onboarding: false });
  e.sandbox.startOAuthWatch();
  await sleep(3000);
  const falsePositive = e.log.toasts.length > 0;
  e.grantToken('ROTATEDTOKEN40CHARS');
  await sleep(3000);
  e.sandbox.stopOAuthWatch();
  check('reconnect ignores stale token, fires only on a NEW one',
    !falsePositive && e.log.reloads === 1 && e.log.firstSyncRuns === 0,
    `falsePositive=${falsePositive} reload=${e.log.reloads}`);
}

// 5. Returning to a parked setupCard mid-onboarding recovers.
{
  const e = makeEnv();
  e.grantToken('NEWTOKEN40CHARS');
  await e.fireVisible();
  await sleep(50);
  check('returning to a parked setupCard with valid credentials recovers',
    e.log.firstSyncRuns === 1, `firstSync=${e.log.firstSyncRuns}`);
}

// 6. Watch self-expires (drives the real deadline via an injected clock).
{
  const e = makeEnv({ setupVisible: false, fakeClock: true });
  e.sandbox.startOAuthWatch();
  await sleep(3000);
  const armedReads = e.log.settingsReads;
  const clearedBefore = e.log.cleared;
  e.clock.advance(200000);
  await sleep(3000);
  const clearedAfter = e.log.cleared;
  const readsAtExpiry = e.log.settingsReads;
  await sleep(3000);
  check('expired watch stops polling',
    armedReads > 0 && clearedAfter > clearedBefore && e.log.settingsReads === readsAtExpiry,
    `armedReads=${armedReads} clearedOnExpiry=${clearedAfter > clearedBefore}`);
}

process.exit(report() ? 1 : 0);
