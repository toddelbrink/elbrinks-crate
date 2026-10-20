// v1.3 Add a Record: the pure logic behind the add flow (specs/v1_3_add_a_record.md).
//
// Slices the logic block out of the shipped index.html and runs it in a vm.
// Covers PRD 7.4: typed-barcode detection, the exact-barcode filter, the
// differences-only chooser line, the narrowing question, owned ordering,
// the wantlist same vs other pressing check, and condition defaults. Each
// with a negative case. Fixtures follow the shape of real signed search
// results (formats[].text holds the color, descriptions hold 180g/Reissue).

import { read, sliceBetween, mustContain, runIn, check, report } from './lib/slice.mjs';

const HTML = read('index.html');
const LOGIC = sliceBetween(HTML, /^\/\/ ── Add a record \(v1\.3/, /^\/\/ ── Add a record: the overlay/);
mustContain(LOGIC, /function exactBarcodeMatches\(/, 'the exact-barcode filter');
mustContain(LOGIC, /function pickNarrowingQuestion\(/, 'the narrowing question');
mustContain(LOGIC, /function wantlistMatch\(/, 'the wantlist check');
const L = runIn(LOGIC, {});
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── typed text: barcode or not ────────────────────────────────
check('13 digits are a barcode', L.typedAsBarcode('0602445069927') === '0602445069927');
check('12 digits (UPC-A) are a barcode', L.typedAsBarcode('602445069927') === '602445069927');
check('digits typed with spaces and dashes still count', L.typedAsBarcode(' 0 81227-97168 7 ') === '081227971687');
check('negative: artist and title are not a barcode', L.typedAsBarcode('Nirvana In Utero') === null);
check('negative: a catalog number is not a barcode', L.typedAsBarcode('DGC-24607') === null && L.typedAsBarcode('24607') === null);
check('negative: 14 digits are not a barcode', L.typedAsBarcode('12345678901234') === null);

// ── exact-barcode filter (PRD 3.1) ────────────────────────────
const alanis = [
  { id: 1, barcode: ['0 81227 97168 7', 'Matrix A: 081227971687-1A'] },
  { id: 2, barcode: ['081227971687'] },
  { id: 3, barcode: ['8122797168-7 1A'] },      // a runout string, not the code
  { id: 4, barcode: ['081227971687-2'] },        // runout with a suffix
  { id: 5 },
];
const hits = L.exactBarcodeMatches(alanis, '0081227971687').map((r) => r.id);
check('keeps results that list the scanned code, ignoring spaces and leading zeros', eq(hits, [1, 2]), JSON.stringify(hits));
check('a UPC-A scan matches the EAN form of the same code', L.exactBarcodeMatches([{ id: 9, barcode: ['0602445069927'] }], '602445069927').length === 1);
check('negative: an empty scan matches nothing', L.exactBarcodeMatches(alanis, '').length === 0);

// ── the chooser line shows only what differs (PRD 4.1) ────────
const fmt = (text, ...descriptions) => [{ name: 'Vinyl', qty: '1', text, descriptions: ['LP', 'Album', ...descriptions] }];
const tupac = [
  { id: 11, title: '2Pac - Me Against The World', formats: fmt('Midnight Mist'), country: 'US', year: '2025', label: ['Interscope'], catno: 'B0041' },
  { id: 12, title: '2Pac - Me Against The World', formats: fmt('Midnight Mist'), country: 'Europe', year: '2025', label: ['Interscope'], catno: 'B0041' },
];
check('two pressings that differ only by country show only the country', eq(L.pressingDiffs(tupac), ['US', 'Europe']));
const mixed = [
  { id: 21, title: 'X - Y', formats: fmt('Blue Translucent', '180g', 'Reissue'), country: 'US', year: '2017', label: ['Grand Royal'], catno: 'A1' },
  { id: 22, title: 'X - Y', formats: fmt('', 'Reissue'), country: 'Europe', year: '', label: ['Capitol'], catno: 'A1' },
];
const lines = L.pressingDiffs(mixed);
check('differences come in PRD order: color, weight, country, year, label', lines[0] === 'Blue Translucent · 180g · US · 2017 · Grand Royal', lines[0]);
check('a missing year or color is left out, never shown blank', lines[1] === 'Europe · Capitol', lines[1]);
check('shared edition and catalog number stay hidden', !lines.some((l) => /Reissue|A1/.test(l)));
check('negative: identical listings produce empty lines, not shared details', eq(L.pressingDiffs([tupac[0], { ...tupac[0], id: 13 }]), ['', '']));
check('confirm line names the pressing fully', L.pressingLine(mixed[0]) === 'Blue Translucent · 180g · Reissue · US · 2017');

// ── order: owned first, then by collectors (PRD 4.1, 4.3) ─────
const pool = [
  { id: 31, community: { have: 900 } },
  { id: 32, community: { have: 4000 } },
  { id: 33, community: { have: 10 }, user_data: { in_collection: true } },
  { id: 34, community: { have: 50 } },
];
check('owned (from search) sits on top, then most-owned first', eq(L.orderMatches(pool, new Set()).map((r) => r.id), [33, 32, 31, 34]));
check('owned from the local crate counts too', eq(L.orderMatches(pool, new Set(['34'])).map((r) => r.id), [34, 33, 32, 31]));
check('ordering never drops a match', L.orderMatches(pool, new Set()).length === 4);

// ── narrowing question for 5+ (PRD 4.2) ───────────────────────
const six = [
  ...[1, 2, 3].map((i) => ({ id: 40 + i, title: 'A - B', formats: fmt(''), country: i === 3 ? 'UK' : 'US', year: '1997' })),
  ...[4, 5, 6].map((i) => ({ id: 40 + i, title: 'A - B', formats: fmt('Red'), country: 'US', year: '1997' })),
];
const q1 = L.pickNarrowingQuestion(six, new Set());
check('asks the question that splits the list most evenly (color 3/3 beats country 5/1)', q1 && q1.key === 'color' && q1.question === 'What color is your vinyl?');
check('a blank color reads as black or not listed', q1.options.some((o) => o.value === '' && o.label === 'Black or not listed'));
const q2 = L.pickNarrowingQuestion(six, new Set(['color']));
check('"Not sure" skips to the next question', q2 && q2.key === 'country');
check('answering narrows the list', L.narrowBy(six, 'color', 'Red').length === 3);
const years = [...Array(7)].map((_, i) => ({ id: 60 + i, formats: fmt(i < 3 ? 'Red' : ''), country: 'US', year: String(2010 + i) }));
check('a question with more than five answers is skipped (unique years)', L.pickNarrowingQuestion(years, new Set()).key === 'color');
check('negative: with color skipped, seven unique years leave nothing to ask', L.pickNarrowingQuestion(years, new Set(['color'])) === null);
check('negative: nothing to ask when every pressing looks the same', L.pickNarrowingQuestion(six.map((r) => ({ ...r, formats: fmt('Red'), country: 'US' })), new Set()) === null);

// ── wantlist after an add (PRD 5.1) ───────────────────────────
const chosen = { id: 501, master_id: 77, user_data: { in_wantlist: false } };
check('same pressing on the wantlist (from search)', eq(L.wantlistMatch({ ...chosen, user_data: { in_wantlist: true } }, [], []), { kind: 'same', releaseId: '501' }));
check('same pressing on the wantlist (from the local list)', L.wantlistMatch(chosen, [], [{ releaseId: '501' }]).kind === 'same');
check('another pressing of the same album, seen in the search', eq(L.wantlistMatch(chosen, [chosen, { id: 502, master_id: 77, user_data: { in_wantlist: true } }], []), { kind: 'other', releaseId: '502' }));
check('another pressing of the same album, seen in the wantlist', eq(L.wantlistMatch(chosen, [], [{ releaseId: '900', masterId: '77' }]), { kind: 'other', releaseId: '900' }));
check('negative: a wanted record from a different album is not this one', L.wantlistMatch(chosen, [{ id: 503, master_id: 88, user_data: { in_wantlist: true } }], [{ releaseId: '901', masterId: '88' }]) === null);
check('negative: nothing on the wantlist, no prompt', L.wantlistMatch(chosen, [chosen], []) === null);

// ── condition fields and defaults (PRD 5, 7.2) ────────────────
const MEDIA = ['Mint (M)', 'Near Mint (NM or M-)', 'Very Good Plus (VG+)'];
const fields = [
  { id: 7, name: 'Vinyl media', type: 'dropdown', options: MEDIA },
  { id: 8, name: 'Sleeve', type: 'dropdown', options: ['Generic', 'Near Mint (NM or M-)'] },
  { id: 3, name: 'Notes', type: 'textarea' },
];
const cf = L.conditionFields(fields);
check('finds media and sleeve by name, whatever their ids', cf.media.id === 7 && cf.sleeve.id === 8);
check('negative: a textarea named Media is never a condition field', L.conditionFields([{ id: 3, name: 'Media notes', type: 'textarea' }]).media === null);
check('defaults to Near Mint', L.conditionDefault(cf.media, '') === 'Near Mint (NM or M-)');
check('remembers the last choice when it is still an option', L.conditionDefault(cf.media, 'Very Good Plus (VG+)') === 'Very Good Plus (VG+)');
check('negative: a remembered value the user no longer has falls back', L.conditionDefault(cf.media, 'Shiny') === 'Near Mint (NM or M-)');
check('no Near Mint option means no default, not a guess', L.conditionDefault({ options: ['Good (G)'] }, '') === '');
check('"Near Mint (NM or M-)" reads "Near Mint"', L.conditionLabel('Near Mint (NM or M-)') === 'Near Mint' && L.conditionLabel('Generic') === 'Generic');

// ── search titles ─────────────────────────────────────────────
check('splits "Artist - Title"', eq(L.splitSearchTitle('Radiohead - OK Computer'), { artist: 'Radiohead', title: 'OK Computer' }));
check('drops the Discogs artist number', L.splitSearchTitle('Low (3) - Things We Lost In The Fire').artist === 'Low');
check('a title with its own dash stays whole', L.splitSearchTitle('Beastie Boys - The In Sound From Way Out! - Live').title === 'The In Sound From Way Out! - Live');

// ── wiring the logic depends on ───────────────────────────────
check('the barcode library is pinned to an exact version', /barcode-detector@\d+\.\d+\.\d+\//.test(HTML));
check('back and nav both close the overlay and the camera', /addOverlay'\)\.classList\.contains\('open'\)\)\{closeAddRecord\(\);return;\}/.test(HTML)
  && /if\(addOpen\)closeAddRecord\(\);/.test(HTML) && /function closeAddRecord\(\)\{\n\s*addStopCamera\(\);/.test(HTML));
check('an empty crate search offers to add it', /openAddRecord\(q\)/.test(HTML) && /ADD_COPY\.emptySearch/.test(HTML));
check('adds go through the write endpoint, then the normal sync', /crate\.discogsWrite\(\{action:'add'/.test(HTML) && /addRenderDone\(r,condOk\);\n\s*\/\/[^\n]*\n\s*silentSync\(\);/.test(HTML));
check('the wantlist is removed only from the Remove button', (HTML.match(/action:'remove_want'/g) || []).length === 1 && /addWantRemove'\)\.onclick=\(\)=>addRemoveWant/.test(HTML));
check('wantlist entries carry their master id', /masterId:bi\.master_id\?String\(bi\.master_id\):''/.test(HTML));

// ── the scan loop (fixed 2026-10-20: the first build read nothing on iOS) ──
// Real decoding is browser-only (camera + wasm), so these guard the shape that
// fixed it. Proven end to end in the preview with a fake camera stream.
{
  const START = HTML.slice(HTML.indexOf('async function addStartCamera(){'), HTML.indexOf('function addStopCamera(){'));
  check('decoders get a canvas frame, never the video element', /addDetector\.det\.detect\(canvas\)/.test(START) && !/\.detect\(v\)/.test(START));
  check('scan errors are counted and logged, not swallowed', /addScanStats\.errors\+\+/.test(START) && /console\.warn\('\[add\] scan error'/.test(START));
  check('a failing native decoder falls back to the ponyfill', /addDetector\.kind==='native'[\s\S]{0,80}addWasmDetector\(\)/.test(START));
  check('if nothing can decode, the user is told and lands on the typed field', /toTyped\(ADD_COPY\.scanFailed\)/.test(START) && /scanFailed:'/.test(HTML));
  // Negative: the original loop, which swallowed every error, fails these checks.
  const OLD = "const codes=await detector.detect(v);\n        if(hit){addOnScan(hit.rawValue);return;}\n      }\n    }catch(e){}";
  check('negative: the old silent loop would be caught', /\.detect\(v\)/.test(OLD) && !/addScanStats\.errors\+\+/.test(OLD));
}

process.exit(report() ? 1 : 0);
