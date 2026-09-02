# Tests

Crate is single-file HTML with no build step and no module boundary, so there is
nothing to import. These harnesses **slice the function out of the shipped source
at runtime** and run it in a Node `vm` against stubs.

Run them:

    node test/oauth-completion.test.mjs
    node test/collection-writes.test.mjs

No dependencies, no install. Exit code 0 means pass.

## Rules

1. **Never retype the logic into a test.** Read it out of the real file every
   run, or you are testing your transcription rather than what ships.
2. **Slice by markers, never line numbers.** Line numbers drift the moment you
   edit the file under test.
3. **Every suite includes a negative case** that fails if the mechanism is
   absent. "Poll completes onboarding" proves nothing alone — a stub that always
   reported success would pass it.
4. **`mustContain` guards against vacuous runs.** If a refactor deletes the
   feature, the suite errors instead of going green.
5. **`let`/`const` are not reachable from a vm sandbox** (only `var` and function
   declarations). Do not reshape production code to make internals visible —
   inject at the seams (a fake `Date`, a wrapped `clearInterval`) and assert on
   observable behaviour.

## What these do and don't prove

They prove the state machine. They do not prove DOM wiring, browser behaviour,
or that a real-world trigger produces the condition being simulated. The OAuth
suite proves "onboarding completes when postMessage never arrives" without any
Android device, because the *condition* is simulable even though the *trigger*
(Firefox Android unloading a background tab) is not. Say which one you tested.

Background: `_claude/memory/verbatim_source_harness.md` and
`_claude/memory/verification_can_lie_silently.md`.
