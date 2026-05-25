// Crate app version — single source of truth.
//
// IMPORTANT: bump this and /version.json TOGETHER on every release.
// The PWA update mechanism (§11) reads /version.json on a poll interval and
// compares it to APP_VERSION on the running page. A mismatch = "new version
// available", shows the update card. If the two files drift apart in a deploy
// (one bumped, the other not), the card fires endlessly until the next deploy.
//
// Loaded as a plain <script> (not type=module) in vercel/index.html so the
// constant is available on window before any inline <script> blocks run.
//
// Format: "vMAJOR.MINOR.PATCH" or "vMAJOR.MINOR.PATCH-tag-NNN" for prerelease.
window.APP_VERSION = 'v1.1.0-step9-006-3-fix1-silent-insert';
