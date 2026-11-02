// "Claude" never appears on screen (HQ directive 2026-10-21, the rule the
// elbrink.com/work/crate story page follows). AI features say "AI" instead.
//
// Scans both pages with comments stripped, so any visible string, label or
// toast that names Claude or a model fails. Lowercase identifiers like
// 'claude_suggest' are data, not copy, and do not match.

import { read, check, report } from './lib/slice.mjs';

// Text the user never sees: the abstention flag body goes to Todd's admin
// feedback inbox, not to the screen.
const ALLOWED = ["'Status: low_confidence (Claude chose silence)',"];

function visible(src) {
  let s = src.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  s = s.replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
  for (const a of ALLOWED) s = s.split(a).join('');
  return s;
}
const hits = (src) => visible(src).split('\n').filter((l) => /\bClaude\b|\bHaiku\b|\bOpus\b|\bSonnet\b/.test(l)).map((l) => l.trim().slice(0, 100));

for (const [name, file] of [['/vinyl', 'index.html'], ['share page', 'share/index.html']]) {
  const h = hits(read(file));
  check(`${name} shows no Claude or model names`, h.length === 0, h.join(' | ') || 'clean');
}
check('liner notes footer reads "Written by AI" on both pages',
  read('index.html').includes("footer.textContent='Written by AI';") && read('share/index.html').includes("footer.textContent='Written by AI';"));

// Negative case: the scanner must flag visible copy and skip comments.
const bad = "<h2>Claude is suggesting moods</h2>\n// Claude in a comment\n<!-- Claude -->";
check('NEGATIVE, scanner flags visible Claude copy only', hits(bad).length === 1, hits(bad).join(' | '));

report();
