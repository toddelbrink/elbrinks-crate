// Pull a function or block out of the SHIPPED source at test time.
//
// Crate is single-file HTML with no module boundary and no build step, so
// there's nothing to import. Rather than retype the logic into a test (which
// would test the transcription, not the code), we slice it out of the real
// file and run it in a Node vm.
//
// Slice by MARKERS, never by line numbers — line numbers drift the moment you
// edit the file under test.
//
// See _claude/memory/verbatim_source_harness.md for the full rationale.

import fs from 'fs';
import path from 'path';
import url from 'url';
import vm from 'vm';

export const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..');

export function read(rel) {
  return fs.readFileSync(path.join(REPO, rel), 'utf8');
}

/** Lines from the first line matching `startRe` through the first subsequent
 *  line exactly equal to `endMarker` (inclusive). */
export function sliceTo(src, startRe, endMarker) {
  const lines = src.split('\n');
  const s = lines.findIndex((l) => startRe.test(l));
  if (s < 0) throw new Error(`slice start not found: ${startRe}`);
  for (let i = s; i < lines.length; i++) {
    if (lines[i] === endMarker) return lines.slice(s, i + 1).join('\n');
  }
  throw new Error(`slice end not found: ${JSON.stringify(endMarker)}`);
}

/** Lines from the first line matching `startRe` up to (not including) the first
 *  subsequent line matching `endRe`. */
export function sliceBetween(src, startRe, endRe) {
  const lines = src.split('\n');
  const s = lines.findIndex((l) => startRe.test(l));
  if (s < 0) throw new Error(`slice start not found: ${startRe}`);
  for (let i = s + 1; i < lines.length; i++) {
    if (endRe.test(lines[i])) return lines.slice(s, i).join('\n');
  }
  throw new Error(`slice end not found: ${endRe}`);
}

/** Guard against a green run on code where the feature has been deleted. */
export function mustContain(src, re, what) {
  if (!re.test(src)) throw new Error(`sliced source no longer contains ${what} — test is vacuous`);
}

export function runIn(src, sandbox) {
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox;
}

// ── tiny assertion reporter ──────────────────────────────────
const results = [];
export function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
export function report() {
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  return failed.length;
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
