// Artist info fetch — Discogs placeholders and 404s.
//
// Compilations list their artist as Discogs "Various" (id 194), a placeholder
// with no artist page, so /artists/194 always 404s. The fetch stored nothing on
// failure, so every cold open asked again: a console error, a wasted Discogs
// call, and a "Loading artist info… 0 of 1" flash. Now placeholders are never
// requested, a real 404 stores a name-only row so it isn't retried, and other
// failures (5xx, timeouts) stay loud and retry next open.
//
// Runs the shipped startWikiFetch twice against a fake Discogs.

import { read, sliceTo, mustContain, runIn, check, report } from './lib/slice.mjs';

const HTML = read('index.html');
const PLACEHOLDERS = (HTML.match(/^const DISCOGS_PLACEHOLDER_ARTISTS=.*$/m) || [''])[0];
const FETCH = sliceTo(HTML, /^async function startWikiFetch\(\)\{/, '}');
mustContain(PLACEHOLDERS, /'194'/, 'the Various placeholder id');
mustContain(FETCH, /DISCOGS_PLACEHOLDER_ARTISTS\.has/, 'the placeholder skip');
mustContain(FETCH, /e\.message==='HTTP 404'/, 'the 404 branch');

const rec = (releaseId, artistId, artist) => ({ releaseId, artistId, artist, title: 't' });
const COLLECTION = [
  rec('r1', 194, 'Various'),            // F1 The Album
  rec('r2', 194, 'Various'),            // Pump Up The Volume
  rec('r3', 111, 'Oasis'),              // normal artist
  rec('r4', 404404, 'Deleted Band'),    // artist page gone on Discogs
  rec('r5', 500500, 'Flaky Server'),    // Discogs 5xx
];

function makeWorld() {
  const requested = [], logs = [], debugs = [], bulks = [];
  const sb = {
    collection: COLLECTION, wikiCache: {}, artistsDB: {}, token: 'TOK', wikiFetching: false,
    discogsGet: async (url) => {
      const id = url.split('/').pop();
      requested.push(id);
      if (id === '111') return { json: async () => ({ name: 'Oasis', urls: ['https://en.wikipedia.org/wiki/Oasis_(band)'], uri: 'x', images: [] }) };
      if (id === '500500') throw new Error('HTTP 500');
      throw new Error('HTTP 404'); // 194, 404404 and anything unexpected
    },
    saveMetaToAPI() {}, setProgress() {}, hideProgress() {}, updateSettingsPanel() {},
    sleep: async () => {},
    crate: { bulkArtists: async (b) => { bulks.push(b); } },
    console: { log: (...a) => logs.push(a.join(' ')), debug: (...a) => debugs.push(a.join(' ')) },
  };
  runIn(PLACEHOLDERS + '\n' + FETCH, sb);
  return { sb, requested, logs, debugs, bulks };
}

const w = makeWorld();
await w.sb.startWikiFetch();
check('first open never asks Discogs for Various (194)', !w.requested.includes('194'), w.requested.join(','));
check('first open asks for the real artists', ['111', '404404', '500500'].every((id) => w.requested.includes(id)), w.requested.join(','));
check('normal artist is stored as before', w.bulks[0]?.['111']?.artist_name === 'Oasis');
check('a 404 artist is stored name-only so it is not retried', w.bulks[0]?.['404404']?.artist_name === 'Deleted Band' && w.sb.artistsDB['404404']);
check('a 404 is logged quietly (debug), not as a failure', w.debugs.some((d) => /404404/.test(d)) && !w.logs.some((l) => /404404/.test(l)), w.debugs.join(' | '));
check('a 5xx stays loud', w.logs.some((l) => /500500 fetch failed/.test(l)), w.logs.join(' | '));
check('a 5xx is not stored, so it can retry', !w.bulks[0]?.['500500'] && !w.sb.artistsDB['500500']);

// Second cold open: only the transient failure is asked again.
w.requested.length = 0;
w.sb.wikiFetching = false;
await w.sb.startWikiFetch();
check('second open asks only for the 5xx artist', w.requested.join(',') === '500500', w.requested.join(',') || '(none)');

// Negative: without the placeholder set, Various WOULD be requested. Proves
// the first check isn't passing because nothing is fetched at all.
const neg = makeWorld();
runIn('DISCOGS_PLACEHOLDER_ARTISTS.clear();', neg.sb);
await neg.sb.startWikiFetch();
check('NEGATIVE, with an empty placeholder set Various is requested', neg.requested.includes('194'), neg.requested.join(','));

process.exit(report() ? 1 : 0);
