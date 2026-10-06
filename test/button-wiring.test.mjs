// Every button on both pages is wired to something.
//
// Commit 8e75c4b (2026-10-04) replaced two sort handlers and, in the same edit,
// deleted the 169 lines between them and the next section: Start Fresh Cycle,
// Full sync, the alpha/year scrubber, scroll-hide bars, the mood review modal's
// buttons, Clear plays and Clear notes. The page still parsed and every other
// suite passed, because nothing checked that a button had a handler. Todd found
// it two days later, locked on the Crate Complete modal.
//
// This suite reads both shipped pages, finds every <button id="..."> in the
// markup, and requires the script to reference that id: $('id'),
// getElementById('id'), '#id' in a selector, or a delegated e.target.id==='id'.
// A reference is not proof the handler is right, but a button nobody references
// can never work.

import { execSync } from 'child_process';
import { read, mustContain, check, report, REPO } from './lib/slice.mjs';

// Buttons that are deliberately inert. Exact ids, each with its reason, so a
// newly orphaned button can't hide here.
const INERT = new Map([
  ['telemetryToggleBtn', 'disabled in the markup until Step 6 ships'],
]);

function scriptOf(html) {
  return [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
}

function unwired(html) {
  const script = scriptOf(html);
  const ids = [...html.matchAll(/<button[^>]*\bid="([^"$]+)"/g)].map((m) => m[1]);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const missing = ids.filter((id) => {
    if (INERT.has(id)) return false;
    const q = `['"\`]`;
    const re = new RegExp(
      `(\\$\\(|getElementById\\()\\s*${q}${esc(id)}${q}` +   // $('id') / getElementById('id')
      `|${q}#${esc(id)}\\b` +                                 // '#id' in a selector
      `|\\.id\\s*===?\\s*${q}${esc(id)}${q}`                  // delegated e.target.id==='id'
    );
    return !re.test(script);
  });
  return { ids, missing };
}

const APP = read('index.html');
const SHARE = read('share/index.html');
mustContain(APP, /<button id="resetConfirmBtn">/, 'the Crate Complete button');

const app = unwired(APP);
const share = unwired(SHARE);
check('found the /vinyl buttons', app.ids.length >= 60, `${app.ids.length} buttons`);
check('found the share page buttons', share.ids.length >= 10, `${share.ids.length} buttons`);
check('every /vinyl button is referenced by the script', app.missing.length === 0, app.missing.join(', ') || 'all wired');
check('every share page button is referenced by the script', share.missing.length === 0, share.missing.join(', ') || 'all wired');

// The specific chain Todd hit: Start Fresh Cycle must reset and close the modal.
check('Start Fresh Cycle resets the cycle and closes the modal',
  /\$\('resetConfirmBtn'\)\.onclick=async\(\)=>\{await resetCycle\(\);\$\('resetModal'\)\.style\.display='none';\};/.test(APP));
// applyFilters and applyWantlistFilters call this unguarded. Without it every
// filter, sort and search threw at its last step.
check('updateAlphaScrubber is defined', /^function updateAlphaScrubber\(\)\{/m.test(APP));

// Negative case: the broken revision must fail this check, or the check is vacuous.
let broken = null;
try { broken = execSync('git show 8e75c4b:index.html', { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { /* no git history here */ }
if (broken) {
  const b = unwired(broken);
  check('negative: the 8e75c4b page is caught (resetConfirmBtn unwired)', b.missing.includes('resetConfirmBtn'), b.missing.join(', '));
} else {
  console.log('SKIP  negative case: git history for 8e75c4b not available');
}

// Inert list stays honest: each entry must still exist and still be disabled.
for (const [id, why] of INERT) {
  check(`inert ${id} is still disabled (${why})`, new RegExp(`<button[^>]*id="${id}"[^>]*\\bdisabled\\b`).test(APP));
}

process.exit(report() ? 1 : 0);
