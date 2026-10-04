// The main app never shows the word "Discogs" (Todd, 2026-10-04).
// Settings and onboarding may name it. Everything else may not.
//
// A full scan of user-visible text isn't practical in single-file HTML, so this
// guards the surfaces that were fixed in the v1.2 §3.7 audit: links that point
// at discogs.com, the Wantlist empty state, the notes-seed toast, and the
// auth-expired error that surfaces in sync and wantlist toasts.

import { read, sliceTo, mustContain, check, report } from './lib/slice.mjs';

const APP = read('index.html');
const SHARE = read('share/index.html');

// Visible label of every <a> whose href points at discogs.com, with markup stripped.
function discogsLinkLabels(src) {
  const out = [];
  const re = /<a href="[^"]*discogs\.com[^"]*"[\s\S]*?<\/a>|<a href="'\+\(artist\.discogs_url[\s\S]*?<\/a>/g;
  for (const m of src.matchAll(re)) {
    out.push(m[0].replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '').replace(/'\+[^+]*\+'/g, '').replace(/['+\s]+/g, ' ').trim());
  }
  return out;
}
// Settings-only links, allowed to name Discogs: the About panel credit and the
// developer-settings link in the access-token modal. Exact labels, so a new
// main-app link can't hide behind this list.
const SETTINGS_ONLY = new Set(['Discogs', 'discogs.com/settings/developers']);
const named = (labels, allow = new Set()) => labels.filter((l) => /discogs/i.test(l) && !allow.has(l));
const ABOUT_CREDIT = /Collection data from <a href="https:\/\/www\.discogs\.com"/;
mustContain(APP, ABOUT_CREDIT, 'the About panel credit (the only allowed bare "Discogs" link)');

const appLabels = discogsLinkLabels(APP);
const shareLabels = discogsLinkLabels(SHARE);
check('found the /vinyl discogs.com links (album, artist, wantlist shop)', appLabels.length >= 3, appLabels.join(' | '));
check('found the share page discogs.com links', shareLabels.length >= 3, shareLabels.join(' | '));
// The allowlist covers one bare "Discogs" label (the About credit). A second one
// means a main-app link reverted.
const bareDiscogs = appLabels.filter((l) => l === 'Discogs').length;
check('no /vinyl link label says Discogs outside Settings', named(appLabels, SETTINGS_ONLY).length === 0 && bareDiscogs <= 1,
  named(appLabels, SETTINGS_ONLY).join(' | ') || `clean (${bareDiscogs} allowed Settings credit)`);
check('no share page link label says Discogs', named(shareLabels).length === 0, named(shareLabels).join(' | ') || 'clean');

// Negative case: the extractor must flag a label that does say Discogs.
const bad = '<a href="https://www.discogs.com/release/1" class="ext-link"><svg><path/></svg>\n      Discogs\n    </a>';
check('NEGATIVE, extractor flags a Discogs label', named(discogsLinkLabels(bad)).length === 1);

const EMPTY = sliceTo(APP, /<div id="wantlistEmpty"/, '    </div>');
check('Wantlist empty state does not say Discogs', !/discogs/i.test(EMPTY.replace(/id="[^"]*"/g, '')), EMPTY.match(/<p>.*<\/p>/)?.[0]);

const SEED = sliceTo(APP, /^async function seedDiscogsNotes\(\)\{/, '}');
const toast = SEED.match(/showToast\(`([^`]*)`\)/)?.[1] || '';
mustContain(SEED, /showToast\(/, 'the notes-seed toast');
check('notes-seed toast does not say Discogs', toast && !/discogs/i.test(toast), toast);

const GET = sliceTo(APP, /^async function discogsGet\(/, '}');
mustContain(GET, /res\.status===401\|\|res\.status===403/, 'the auth-expired branch');
const thrown = [...GET.matchAll(/throw new Error\(([^;]*)\);/g)].map((m) => m[1]);
check('auth-expired error shown to users does not say Discogs', thrown.length && thrown.every((t) => !/discogs/i.test(t)), thrown.join(' | '));

process.exit(report() ? 1 : 0);
