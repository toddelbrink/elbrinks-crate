// Liner notes — note selection after the Opus 5 + web search upgrade.
//
// Two failures this guards:
// 1. A note about the model instead of the record shipped at 0.95 confidence:
//    "The Great Divide does not exist in my training data as a Noah Kahan
//    release through 2023." It cleared the 0.7 floor and rendered as History.
// 2. With web search, notes now carry source links shown on public pages. A
//    link must have actually come back from the search, never be invented.

import { read, sliceTo, mustContain, runIn, check, report } from './lib/slice.mjs';

const SRC = read('api/liner-notes.js');
const PIECES = [
  sliceTo(SRC, /^const CONFIDENCE_FLOOR = /, 'const CONFIDENCE_FLOOR = 0.7;'),
  sliceTo(SRC, /^const CATEGORIES = \[/, '];'),
  sliceTo(SRC, /^const BLOCKED_DOMAINS = \[/, '];'),
  sliceTo(SRC, /^function isBlockedSource\(url\) \{/, '}'),
  sliceTo(SRC, /^const SELF_REFERENCE = \[/, '];'),
  sliceTo(SRC, /^function isSelfReferential\(body\) \{/, '}'),
  sliceTo(SRC, /^function collectSearchUrls\(node, out\) \{/, '}'),
  sliceTo(SRC, /^function selectNotes\(rawNotes, searchedUrls\) \{/, '}'),
].join('\n').replace(/^const /gm, 'var ');
mustContain(PIECES, /searchedUrls\.has\(u\)/, 'the searched-URL check on sources');
mustContain(PIECES, /!isSelfReferential\(n\.body\)/, 'the self-reference filter');

const sb = runIn(PIECES, { URL });
const note = (body, extra = {}) => ({ category: 'History', body, confidence: 0.9, sources: [], ...extra });

// ── self-referential notes ────────────────────────────────────
const JUNK = "The Great Divide does not exist in my training data as a Noah Kahan release through 2023. Kahan's most recent album in my knowledge is Stick Season (2022), which saw expanded editions in 2023.";
check('the shipped Great Divide junk note is dropped', sb.selectNotes([note(JUNK, { confidence: 0.95 })], new Set()).length === 0);
for (const body of [
  'I could not find details about this pressing.',
  'Search results show little about the recording sessions.',
  'This release is past my knowledge cutoff, so specifics are unavailable.',
  'As an AI, I have no information on this reissue.',
  'Not aware of any notable session players on this record.',
]) {
  check(`meta note dropped: "${body.slice(0, 40)}…"`, sb.isSelfReferential(body));
}
check('a quoted lyric in first person is kept',
  !sb.isSelfReferential('Kahan wrote the title track after a Vermont winter; the refrain "I don\'t know where I\'m going" came from a voice memo.'));
check('an ordinary factual note is kept',
  sb.selectNotes([note('Stick Season was written in Strafford, Vermont, and first surfaced as a 30-second TikTok clip in 2020.')], new Set()).length === 1);

// ── sources ───────────────────────────────────────────────────
{
  const searched = new Set(['https://pitchfork.com/reviews/albums/noah-kahan-the-great-divide/']);
  const [kept] = sb.selectNotes([note('Recorded with producer Gabe Simon in Nashville.', {
    category: 'Recording',
    sources: ['https://pitchfork.com/reviews/albums/noah-kahan-the-great-divide/', 'https://made-up.example.com/liner', 'https://pitchfork.com/reviews/albums/noah-kahan-the-great-divide/'],
  })], searched);
  check('only sources the search returned survive, deduped', JSON.stringify(kept.sources) === JSON.stringify([...searched]), JSON.stringify(kept.sources));
}
{
  const [kept] = sb.selectNotes([note('From memory.', { sources: ['https://invented.example.com'] })], new Set());
  check('a note from its own knowledge keeps no invented link', kept && kept.sources.length === 0);
}

{
  // Hear Say's backfill cited a piracy site (israbox-music.com) on the public page.
  const urls = ['https://israbox-music.com/1234-hear-say.html', 'https://www.facebook.com/uncle.kunkel/posts/1', 'https://m.x.com/band/status/9', 'https://unclekunkelsonegramband.bandcamp.com/album/hear-say', 'https://notamazon.com/review'];
  const [kept] = sb.selectNotes([note('Tracked at Wright Way Studios in Baltimore.', { category: 'Recording', sources: urls })], new Set(urls));
  check('blocked sites are dropped (subdomains too) but lookalike domains are not',
    JSON.stringify(kept.sources) === JSON.stringify(['https://unclekunkelsonegramband.bandcamp.com/album/hear-say', 'https://notamazon.com/review']), JSON.stringify(kept.sources));
  check('the blocklist is sent to the search tool', /blocked_domains: BLOCKED_DOMAINS/.test(SRC));
  check('blocklist entries are bare ASCII domains, as the API requires',
    sb.BLOCKED_DOMAINS.every(d => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)));
}

// ── collectSearchUrls walks nested dynamic-filtering results ──
{
  const content = [
    { type: 'text', text: 'Looking this up.' },
    { type: 'server_tool_use', name: 'code_execution' },
    { type: 'bash_code_execution_tool_result', content: { stdout: '' }, nested: [
      { type: 'web_search_tool_result', caller: { type: 'code_execution_20260120' }, content: [
        { type: 'web_search_result', url: 'https://a.example/1', title: 'A' },
        { type: 'web_search_result', url: 'https://b.example/2', title: 'B' },
      ] },
    ] },
    { type: 'text', text: 'x', citations: [{ type: 'web_search_result_location', url: 'https://c.example/3' }] },
    { type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
  ];
  const out = new Set();
  sb.collectSearchUrls(content, out);
  check('search URLs are collected from nested results and citations, errors ignored',
    out.size === 3 && out.has('https://a.example/1') && out.has('https://c.example/3'));
}

// ── floor, categories, cap ────────────────────────────────────
{
  const picked = sb.selectNotes([
    note('Low.', { confidence: 0.5 }),
    note('Bad category.', { category: 'Gossip' }),
    note('Clamped.', { confidence: 1.7 }),
    note('Two.'), note('Three.'), note('Four.'),
  ], new Set());
  check('floor and category filters apply, confidence clamps, capped at 3 after filtering',
    picked.length === 3 && picked[0].body === 'Clamped.' && picked[0].confidence === 1);
}

// Negative case: without the self-reference filter the junk note ships again.
{
  const broken = runIn(PIECES.replace(' && !isSelfReferential(n.body)', ''), { URL });
  check('negative: without the filter, the Great Divide junk note would ship', broken.selectNotes([note(JUNK, { confidence: 0.95 })], new Set()).length === 1);
}

// ── request shape guards for claude-opus-5 ────────────────────
check('model is claude-opus-5', /const MODEL = 'claude-opus-5';/.test(SRC));
check('no sampling params or structured output (400 / incompatible with web search)', !/temperature\s*:/.test(SRC) && !/format\s*:\s*\{/.test(SRC));
check('each request is bounded by the remaining deadline, with no silent retries',
  /timeout: remaining, maxRetries: 0/.test(SRC) && /DEADLINE_MS = 250_000/.test(SRC) && /maxDuration: 300/.test(SRC));
check('refusal fallbacks and pause_turn resume are wired',
  /fallbacks: 'default'/.test(SRC) && /server-side-fallback-2026-07-01/.test(SRC) && /stop_reason !== 'pause_turn'/.test(SRC));

process.exit(report() ? 1 : 0);
