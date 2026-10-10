// Theme tap-to-preview (v1.1 §5.1, Sprint 4 item 7).
//
// Tapping a theme card used to apply and save it at once. Now a tap previews:
// the CSS variables swap, nothing is written, and an Apply / Cancel bar shows.
// Only Apply saves. Cancel, re-tapping the applied card, or leaving the Theme
// panel reverts to the applied theme.
//
// Slices the theme functions and the panel renderer out of the shipped page
// and runs them against a fake DOM that records every CSS variable write and
// every saveSetting call.

import { execSync } from 'child_process';
import { read, sliceTo, sliceBetween, mustContain, runIn, check, report, REPO } from './lib/slice.mjs';

const THEMES_SRC = `var THEMES={
  dark:{name:'Dark Default',vars:{bg:'#000',surface:'#111',accent:'#f00',text:'#fff'}},
  wax:{name:'Vinyl Wax',vars:{bg:'#210',surface:'#321',accent:'#d90',text:'#fec'}},
  coast:{name:'Coastline',vars:{bg:'#eef',surface:'#fff',accent:'#c84',text:'#123'}},
};`;

function fakeDom() {
  const vars = {};
  const saves = [];
  const cards = [];
  const bar = { cls: new Set(), classList: null };
  bar.classList = { toggle: (c, on) => (on ? bar.cls.add(c) : bar.cls.delete(c)) };
  const theme = { id: 'subpanelTheme', classList: { remove() {} } };
  const grid = {
    set innerHTML(html) {
      cards.length = 0;
      for (const m of html.matchAll(/data-theme-id="([a-z]+)"/g)) {
        const c = { id: m[1], cls: new Set(), status: { textContent: '' }, listeners: [] };
        c.getAttribute = () => c.id;
        c.classList = { toggle: (k, on) => (on ? c.cls.add(k) : c.cls.delete(k)) };
        c.querySelector = (s) => (s === '.theme-card-status' ? c.status : null);
        c.addEventListener = (ev, fn) => c.listeners.push(fn);
        cards.push(c);
      }
    },
    querySelectorAll: () => cards,
  };
  const document = {
    documentElement: { style: { setProperty: (k, v) => (vars[k] = v) } },
    getElementById: (id) =>
      ({ themeGrid: grid, themePreviewBar: bar, subpanelTheme: theme, rowThemeSecondary: { textContent: '' } })[id] || null,
    querySelectorAll: (s) => (s === '.theme-card' ? cards : []),
    querySelector: () => theme,
  };
  const crate = { saveSetting: async (k, v) => (saves.push([k, v]), { success: true }) };
  return { vars, saves, cards, bar, document, crate };
}

function load(src, { withPreview }) {
  const parts = [THEMES_SRC];
  if (withPreview) {
    const fns = sliceBetween(src, /^\/\/ Swap the CSS variables only/, /^async function setTheme\(key\)\{/);
    mustContain(fns, /function previewTheme\(key\)/, 'previewTheme');
    mustContain(fns, /function cancelThemePreview\(\)/, 'cancelThemePreview');
    parts.push(fns, sliceTo(src, /^function closeSubpanel\(name\)\{/, '}'));
  } else {
    parts.push(sliceTo(src, /^function applyTheme\(key\)\{/, '}'));
  }
  parts.push(sliceTo(src, /^async function setTheme\(key\)\{/, '}'));
  parts.push(sliceTo(src, /^function renderThemeSubpanel\(\)\{/, '}'));
  const dom = fakeDom();
  const sb = runIn(parts.join('\n'), {
    ...dom, activeThemeKey: 'dark', previewThemeKey: null,
    wireCelebrationSoundsToggle() {}, showToast() {}, console, Object, setTimeout,
  });
  sb.applyTheme('dark');
  sb.renderThemeSubpanel();
  const tap = (id) => dom.cards.find((c) => c.id === id).listeners.forEach((fn) => fn());
  return { sb, dom, tap };
}

const APP = read('index.html');
const flush = () => new Promise((r) => setTimeout(r, 0));

// 1. A tap previews and writes nothing.
{
  const { sb, dom, tap } = load(APP, { withPreview: true });
  tap('wax'); await flush();
  check('tap repaints to the tapped theme', dom.vars['--bg'] === '#210', dom.vars['--bg']);
  check('tap writes nothing', dom.saves.length === 0, JSON.stringify(dom.saves));
  check('applied theme is unchanged during preview', sb.activeThemeKey === 'dark', sb.activeThemeKey);
  check('Apply / Cancel bar shows', dom.bar.cls.has('open'));
  const wax = dom.cards.find((c) => c.id === 'wax');
  const dark = dom.cards.find((c) => c.id === 'dark');
  check('tapped card is marked Previewing', wax.cls.has('previewing') && wax.status.textContent === 'Previewing');
  check('applied card keeps a Current label', dark.status.textContent === 'Current' && !dark.cls.has('active'));

  // Tapping another theme swaps the preview, still no write.
  tap('coast'); await flush();
  check('second tap swaps the preview', dom.vars['--bg'] === '#eef' && sb.previewThemeKey === 'coast');
  check('second tap writes nothing', dom.saves.length === 0);

  // Cancel reverts.
  sb.cancelThemePreview();
  check('Cancel repaints the applied theme', dom.vars['--bg'] === '#000', dom.vars['--bg']);
  check('Cancel hides the bar', !dom.bar.cls.has('open'));
  check('Cancel writes nothing', dom.saves.length === 0);
}

// 2. Apply saves once and becomes the applied theme.
{
  const { sb, dom, tap } = load(APP, { withPreview: true });
  tap('wax');
  await sb.applyThemePreview();
  check('Apply saves the previewed theme once', JSON.stringify(dom.saves) === '[["theme","wax"]]', JSON.stringify(dom.saves));
  check('Apply makes it the applied theme', sb.activeThemeKey === 'wax' && sb.previewThemeKey === null);
  check('Apply hides the bar', !dom.bar.cls.has('open'));
  const wax = dom.cards.find((c) => c.id === 'wax');
  check('applied card is active and Current', wax.cls.has('active') && wax.status.textContent === 'Current');
}

// 3. Re-tapping the applied card ends the preview without a write.
{
  const { sb, dom, tap } = load(APP, { withPreview: true });
  tap('wax'); tap('dark'); await flush();
  check('re-tap of applied card reverts', dom.vars['--bg'] === '#000' && sb.previewThemeKey === null);
  check('re-tap of applied card writes nothing', dom.saves.length === 0);
  check('re-tap hides the bar', !dom.bar.cls.has('open'));
}

// 4. Leaving the Theme panel mid-preview reverts, with no implicit apply.
{
  const { sb, dom, tap } = load(APP, { withPreview: true });
  tap('coast');
  sb.closeSubpanel('theme');
  check('closing the Theme panel reverts', dom.vars['--bg'] === '#000' && sb.previewThemeKey === null);
  check('closing the Theme panel writes nothing', dom.saves.length === 0);
}

// 5. The other exit paths call the revert too.
mustContain(sliceTo(APP, /^function closeAllOverlays\(\)\{/, '}'), /cancelThemePreview\(\)/, 'revert in closeAllOverlays');
check('bottom-nav exit (closeAllOverlays) reverts the preview', true);
check('closeSettings reverts the preview', /^function closeSettings\(\)\{[^\n]*cancelThemePreview\(\)/m.test(APP));
check('Apply and Cancel buttons are wired',
  /getElementById\('themePreviewCancel'\)\.onclick=\(\)=>cancelThemePreview\(\)/.test(APP) &&
  /getElementById\('themePreviewApply'\)\.onclick=\(\)=>applyThemePreview\(\)/.test(APP));

// Negative case: before this change a tap saved immediately. The same harness
// must see that write, or the "tap writes nothing" checks above prove nothing.
let old = null;
try { old = execSync('git show 0982e49:index.html', { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { /* no history */ }
if (old) {
  const { dom, tap } = load(old, { withPreview: false });
  tap('wax'); await flush();
  check('negative: the old code saved on tap', JSON.stringify(dom.saves) === '[["theme","wax"]]', JSON.stringify(dom.saves));
} else {
  console.log('SKIP  negative case: git history for 0982e49 not available');
}

process.exit(report() ? 1 : 0);
