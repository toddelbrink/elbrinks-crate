// v1.3 Add a Record: the Discogs write endpoint (specs/v1_3_add_a_record.md §7.1).
//
// Runs the real api/discogs-write.js and api/discogs-proxy.js handlers. The
// Supabase package is swapped for an in-memory fake, global fetch stands in for
// Discogs, and every Discogs call is recorded so the tests can assert exactly
// what was written, in what order, and what was never sent.
//
// The endpoint is Crate's first write to anyone's Discogs account, so most of
// these cases are about what it refuses.

import fs from 'fs';
import path from 'path';
import url from 'url';
import { REPO, check, report } from './lib/slice.mjs';

const helpersUrl = url.pathToFileURL(path.join(REPO, 'lib/discogs-oauth-helpers.js')).href;
function load(rel, mutate = (s) => s) {
  let src = fs.readFileSync(path.join(REPO, rel), 'utf8');
  for (const [a, b] of [
    [`import { createClient } from '@supabase/supabase-js';`, `const createClient = globalThis.__fakeCreateClient;`],
    [`from '../lib/discogs-oauth-helpers.js';`, `from '${helpersUrl}';`],
  ]) {
    if (!src.includes(a)) throw new Error(`import not found in ${rel}, test is stale: ${a}`);
    src = src.replace(a, b);
  }
  src = mutate(src);
  return import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src)).then((m) => m.default);
}

// ── fakes ─────────────────────────────────────────────────────
let settings; // the caller's vinyl_settings rows
let signedIn;
globalThis.__fakeCreateClient = () => ({
  auth: { getUser: async () => (signedIn ? { data: { user: { id: 'u1' } }, error: null } : { data: {}, error: { message: 'bad jwt' } }) },
  from() {
    const b = { select: () => b, in: () => Promise.resolve({ data: settings, error: null }) };
    return b;
  },
});
process.env.DISCOGS_CONSUMER_KEY = 'ck';
process.env.DISCOGS_CONSUMER_SECRET = 'cs';

const FIELDS = { fields: [
  { id: 1, name: 'Media Condition', type: 'dropdown', options: ['Mint (M)', 'Near Mint (NM or M-)', 'Very Good Plus (VG+)'] },
  { id: 2, name: 'Sleeve Condition', type: 'dropdown', options: ['Generic', 'Near Mint (NM or M-)', 'Very Good Plus (VG+)'] },
  { id: 3, name: 'Notes', type: 'textarea' },
] };
let calls, discogsReply;
globalThis.fetch = async (u, opts = {}) => {
  const p = u.replace('https://api.discogs.com', '');
  calls.push({ method: opts.method || 'GET', path: p, auth: opts.headers?.Authorization, body: opts.body });
  const [status, json] = discogsReply(opts.method || 'GET', p);
  return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, text: async () => (json === undefined ? '' : JSON.stringify(json)) };
};
const normal = (method, p) => {
  if (p === '/oauth/identity') return [200, { username: 'ElbrinksCrateTest1' }];
  if (p.endsWith('/collection/fields')) return [200, FIELDS];
  if (method === 'POST' && /\/instances\/\d+\/fields\/\d+$/.test(p)) return [204];
  if (method === 'POST' && /\/collection\/folders\/1\/releases\/\d+$/.test(p)) return [201, { instance_id: 555, resource_url: 'x' }];
  if (method === 'DELETE' && /\/wants\/\d+$/.test(p)) return [204];
  return [404, { message: 'not found' }];
};

async function call(handler, body, { method = 'POST', auth = 'Bearer jwt' } = {}) {
  const res = { code: 0, json: null, headers: {} };
  const r = {
    status(c) { res.code = c; return r; },
    json(j) { res.json = j; return r; },
    send(t) { res.text = t; return r; },
    setHeader(k, v) { res.headers[k] = v; },
  };
  await handler({ method, headers: { authorization: auth }, body }, r);
  return res;
}
function reset({ mode = 'oauth', reply = normal } = {}) {
  calls = []; discogsReply = reply; signedIn = true;
  settings = mode === 'oauth'
    ? [{ setting_key: 'discogs_mode', setting_val: 'oauth' }, { setting_key: 'discogs_oauth_token', setting_val: 'at' }, { setting_key: 'discogs_oauth_secret', setting_val: 'as' }]
    : mode === 'pat' ? [{ setting_key: 'discogs_mode', setting_val: 'pat' }, { setting_key: 'token', setting_val: 'PAT123' }]
    : [];
}
const writes = () => calls.filter((c) => c.method !== 'GET');
const NM = 'Near Mint (NM or M-)';
const condition = [{ id: 1, value: NM }, { id: 2, value: NM }];

const write = await load('api/discogs-write.js');
const proxy = await load('api/discogs-proxy.js');

// ── add: the happy path ───────────────────────────────────────
{
  reset();
  const r = await call(write, { action: 'add', releaseId: '1234', fields: condition });
  check('add returns the new instance', r.code === 200 && r.json.added === true && r.json.instanceId === 555 && r.json.folderId === 1);
  const w = writes();
  check('add writes to Uncategorized (folder 1) on the identity user', w[0] && w[0].path === '/users/ElbrinksCrateTest1/collection/folders/1/releases/1234');
  check('then sets media and sleeve on that instance', w.length === 3
    && w[1].path === '/users/ElbrinksCrateTest1/collection/folders/1/releases/1234/instances/555/fields/1'
    && w[2].path.endsWith('/instances/555/fields/2')
    && JSON.parse(w[1].body).value === NM);
  check('fields are checked before the add', calls.findIndex((c) => c.path.endsWith('/collection/fields')) < calls.indexOf(w[0]));
  check('OAuth calls are signed with the user token', calls.every((c) => /^OAuth /.test(c.auth) && /oauth_token="at"/.test(c.auth) && /oauth_signature="cs%26as"/.test(c.auth)));
  check('every field reports ok', r.json.fields.every((f) => f.ok));
}
{
  reset({ mode: 'pat' });
  const r = await call(write, { action: 'add', releaseId: 1234, fields: condition });
  check('personal token users can add too', r.code === 200 && calls.every((c) => c.auth === 'Discogs token=PAT123'));
}
{
  reset();
  const r = await call(write, { action: 'add', releaseId: '1234' });
  check('an add with no fields is one write and reads no fields', r.code === 200 && writes().length === 1 && !calls.some((c) => c.path.endsWith('/fields')));
}

// ── add: what it refuses ──────────────────────────────────────
{
  reset();
  const r = await call(write, { action: 'add', releaseId: '1234', fields: [{ id: 1, value: 'Like new' }, { id: 2, value: NM }] });
  check('a value outside the user\'s options is refused with nothing written', r.code === 400 && writes().length === 0);
}
{
  reset();
  const r = await call(write, { action: 'add', releaseId: '1234', fields: [{ id: 3, value: 'a note' }] });
  check('a non-dropdown field (Notes) is refused', r.code === 400 && writes().length === 0);
}
{
  reset();
  const r = await call(write, { action: 'add', releaseId: '1234', fields: [{ id: 9, value: NM }] });
  check('a field the user does not have is refused', r.code === 400 && writes().length === 0);
}
{
  reset();
  const r = await call(write, { action: 'add', releaseId: '1234', fields: [condition[0], condition[0]] });
  check('the same field twice is refused before any call', r.code === 400 && calls.length === 0);
}
{
  reset();
  const r = await call(write, { action: 'add', releaseId: '1234', fields: [...condition, { id: 3, value: NM }] });
  check('more than two fields is refused before any call', r.code === 400 && calls.length === 0);
}
{
  let ok = true;
  for (const bad of ['../1', '0', '12a', '', null, '1234/instances/5', 1.5, '1'.repeat(13)]) {
    reset();
    const r = await call(write, { action: 'add', releaseId: bad });
    if (r.code !== 400 || calls.length) ok = false;
  }
  check('malformed release ids are refused before any call', ok);
}
{
  let ok = true;
  for (const action of ['delete', 'move', 'remove', undefined, 'ADD']) {
    reset();
    const r = await call(write, { action, releaseId: '1234' });
    if (r.code !== 400 || calls.length) ok = false;
  }
  check('only add and remove_want exist', ok);
}
{
  reset();
  const r = await call(write, { action: 'add', releaseId: '1234', folderId: 0, username: 'telbrink', user: 'telbrink' });
  check('the body cannot pick the folder or the account', r.code === 200
    && writes()[0].path === '/users/ElbrinksCrateTest1/collection/folders/1/releases/1234');
}
{
  reset();
  const r = await call(write, { action: 'add', releaseId: '1234' }, { method: 'GET' });
  check('GET is refused', r.code === 405 && calls.length === 0);
}
{
  reset(); signedIn = false;
  const r = await call(write, { action: 'add', releaseId: '1234' });
  check('no valid session means no Discogs call', r.code === 401 && calls.length === 0);
}
{
  reset({ mode: 'none' });
  const r = await call(write, { action: 'add', releaseId: '1234' });
  check('no Discogs connection is a 403 with no call', r.code === 403 && calls.length === 0);
}

// ── add: partial and failed writes ────────────────────────────
{
  reset({ reply: (m, p) => (/\/fields\/2$/.test(p) ? [500, { message: 'boom' }] : normal(m, p)) });
  const r = await call(write, { action: 'add', releaseId: '1234', fields: condition });
  const adds = writes().filter((c) => /\/releases\/1234$/.test(c.path));
  check('a failed sleeve write still reports the add, with that field marked', r.code === 200 && r.json.added
    && r.json.fields[0].ok === true && r.json.fields[1].ok === false);
  check('and the add is never retried', adds.length === 1);
}
{
  reset({ reply: (m, p) => (m === 'POST' && /\/releases\/1234$/.test(p) ? [401, { message: 'You must authenticate to access this resource.' }] : normal(m, p)) });
  const r = await call(write, { action: 'add', releaseId: '1234', fields: condition });
  check('a refused add passes the status through and sets no fields', r.code === 401 && writes().length === 1 && /authenticate/.test(r.json.error));
}
{
  reset({ reply: (m, p) => (p === '/oauth/identity' ? [401, { message: 'expired' }] : normal(m, p)) });
  const r = await call(write, { action: 'add', releaseId: '1234', fields: condition });
  check('expired credentials stop at identity, nothing written', r.code === 401 && writes().length === 0);
}

// ── remove_want ───────────────────────────────────────────────
{
  reset();
  const r = await call(write, { action: 'remove_want', releaseId: '1234' });
  const w = writes();
  check('remove_want deletes exactly one want on the identity user', r.code === 200 && r.json.removed === true
    && w.length === 1 && w[0].method === 'DELETE' && w[0].path === '/users/ElbrinksCrateTest1/wants/1234');
}
{
  reset({ reply: (m, p) => (m === 'DELETE' ? [404, { message: 'not found' }] : normal(m, p)) });
  const r = await call(write, { action: 'remove_want', releaseId: '1234' });
  check('a want that is already gone is not an error', r.code === 200 && r.json.removed === false);
}

// ── the read proxy, after moving its credential code to the helper ──
{
  reset({ mode: 'pat' });
  const r = await call(proxy, { endpoint: '/users/x/collection/fields' });
  check('proxy still forwards GET with the personal token', r.code === 200 && calls.length === 1
    && calls[0].method === 'GET' && calls[0].auth === 'Discogs token=PAT123');
}
{
  reset();
  await call(proxy, { endpoint: '/oauth/identity' });
  check('proxy still signs OAuth calls', calls.length === 1 && /oauth_signature="cs%26as"/.test(calls[0].auth));
}
{
  reset({ mode: 'none' });
  const r = await call(proxy, { endpoint: '/oauth/identity' });
  check('proxy still refuses users with no connection', r.code === 403 && calls.length === 0);
}
{
  const src = fs.readFileSync(path.join(REPO, 'api/discogs-proxy.js'), 'utf8');
  check('proxy has no write method in it', !/method:\s*['"](POST|PUT|DELETE|PATCH)['"]/.test(src) && /method: 'GET'/.test(src));
}

// ── negative cases: the checks above can fail ─────────────────
{
  // Strip the options check: an invented condition must then reach Discogs.
  const loose = await load('api/discogs-write.js', (s) => {
    const a = "!Array.isArray(def.options) || !def.options.includes(f.value)";
    if (!s.includes(a)) throw new Error('options check not found, test is stale');
    return s.replace(a, 'false');
  });
  reset();
  await call(loose, { action: 'add', releaseId: '1234', fields: [{ id: 1, value: 'Like new' }] });
  check('negative: without the options check, a bad value gets written', writes().length === 2);
}
{
  // Hardcode the folder to 0 and the folder assertion must catch it.
  const wrong = await load('api/discogs-write.js', (s) => s.replace('const ADD_FOLDER = 1;', 'const ADD_FOLDER = 0;'));
  reset();
  await call(wrong, { action: 'add', releaseId: '1234' });
  check('negative: a folder-0 build is visible to the folder check', writes()[0].path.includes('/folders/0/'));
}

process.exit(report() ? 1 : 0);
