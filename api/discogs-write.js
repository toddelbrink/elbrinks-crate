// Vercel serverless function — the only path that writes to Discogs.
//
// POST /api/discogs-write
// Header: Authorization: Bearer <supabase_access_token>
// Body, one of:
//   { action: 'add', releaseId, fields: [{ id, value }, ...] }
//   { action: 'remove_want', releaseId }
//
// v1.3 Add a Record (specs/v1_3_add_a_record.md §7.1). api/discogs-proxy.js
// forwards GET only and stays that way. This endpoint can do exactly three
// things and nothing else:
//   1. Add a release to the caller's collection, always folder 1
//      (Uncategorized). Folder 0 ("All") does not accept writes. No picker.
//   2. Set collection fields (media and sleeve condition) on that new instance.
//   3. Remove a release from the caller's wantlist, only when the user tapped
//      Remove. The browser decides that. This endpoint just refuses anything
//      broader than one release id.
//
// Whose collection: the Discogs username comes from /oauth/identity, signed
// with the caller's own credentials. Nothing from the request body names a
// user, so a request can only ever touch the caller's own Discogs account.
//
// Fields: users can rename or delete collection fields, so ids and allowed
// values are never hardcoded. The browser reads /collection/fields (through the
// proxy) to build the condition picker and sends the ids it chose. This
// endpoint re-reads the fields and checks each id is a dropdown and each value
// is one of its options, BEFORE the add. A bad value fails with nothing written.
//
// An add is two or three Discogs writes. If the add lands and a field write
// fails, the record is still in the collection, so the response is 200 with
// that field marked ok:false. The caller reports it; it does not retry the add.

import { createClient } from '@supabase/supabase-js';
import {
  discogsAuthForUser,
  getSupabaseForRequest,
} from '../lib/discogs-oauth-helpers.js';

export const config = { runtime: 'nodejs' };

const SUPABASE_URL = 'https://cejdraimvieqjopiccpb.supabase.co';
const SUPABASE_KEY = 'sb_publishable_n63_gkGCZwL1DodV18o8kA_sJxUcrly';

const DISCOGS_BASE = 'https://api.discogs.com';
const ADD_FOLDER = 1; // Uncategorized
const MAX_FIELDS = 2; // media and sleeve condition

const isReleaseId = (v) => (typeof v === 'string' || typeof v === 'number') && /^[1-9]\d{0,11}$/.test(String(v));

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // 1. Validate the request before touching credentials.
  const body = req.body || {};
  const action = body.action;
  if (action !== 'add' && action !== 'remove_want') {
    res.status(400).json({ error: 'unknown action' });
    return;
  }
  if (!isReleaseId(body.releaseId)) {
    res.status(400).json({ error: 'invalid releaseId' });
    return;
  }
  const releaseId = String(body.releaseId);

  let fields = [];
  if (action === 'add') {
    if (body.fields !== undefined && !Array.isArray(body.fields)) {
      res.status(400).json({ error: 'fields must be a list' });
      return;
    }
    fields = body.fields || [];
    if (fields.length > MAX_FIELDS) {
      res.status(400).json({ error: `at most ${MAX_FIELDS} fields` });
      return;
    }
    const seen = new Set();
    for (const f of fields) {
      if (!f || !Number.isInteger(f.id) || f.id < 1 || typeof f.value !== 'string' || !f.value || f.value.length > 100) {
        res.status(400).json({ error: 'invalid field' });
        return;
      }
      if (seen.has(f.id)) {
        res.status(400).json({ error: 'duplicate field' });
        return;
      }
      seen.add(f.id);
    }
  }

  // 2. Verify the Supabase session, then build the caller's Discogs header.
  const { supabase, error: authError } = await getSupabaseForRequest(req, createClient, SUPABASE_URL, SUPABASE_KEY);
  if (authError) {
    res.status(401).json({ error: authError });
    return;
  }
  const { authHeader, status, error } = await discogsAuthForUser(supabase);
  if (!authHeader) {
    res.status(status).json({ error });
    return;
  }

  const discogs = async (method, path, json) => {
    const headers = {
      Authorization: authHeader,
      'User-Agent': 'ElbrinksCrate/1.0 +https://elbrink.com/vinyl',
      Accept: 'application/json',
    };
    if (json !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(`${DISCOGS_BASE}${path}`, {
      method,
      headers,
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { status: r.status, ok: r.ok, data, retryAfter: r.headers.get('Retry-After') };
  };
  const passThrough = (r, what) => {
    if (r.retryAfter) res.setHeader('Retry-After', r.retryAfter);
    const msg = (r.data && r.data.message) || `${what} failed`;
    console.error(`[discogs-write] ${what}: ${r.status} ${msg}`);
    res.status(r.status >= 400 ? r.status : 502).json({ error: msg });
  };

  try {
    // 3. Whose account. Signed with the caller's own credentials.
    const who = await discogs('GET', '/oauth/identity');
    if (!who.ok || !who.data || !who.data.username) return passThrough(who, 'identity');
    const user = encodeURIComponent(who.data.username);

    if (action === 'remove_want') {
      const r = await discogs('DELETE', `/users/${user}/wants/${releaseId}`);
      if (r.status === 404) {
        // Already gone. The user's intent holds.
        res.status(200).json({ removed: false, reason: 'not on wantlist' });
        return;
      }
      if (!r.ok) return passThrough(r, 'remove from wantlist');
      res.status(200).json({ removed: true });
      return;
    }

    // 4. Check every field against the user's own field definitions first.
    if (fields.length) {
      const defs = await discogs('GET', `/users/${user}/collection/fields`);
      if (!defs.ok || !defs.data || !Array.isArray(defs.data.fields)) return passThrough(defs, 'read collection fields');
      for (const f of fields) {
        const def = defs.data.fields.find((d) => d.id === f.id);
        if (!def || def.type !== 'dropdown' || !Array.isArray(def.options) || !def.options.includes(f.value)) {
          res.status(400).json({ error: `field ${f.id} does not accept that value` });
          return;
        }
      }
    }

    // 5. Add to Uncategorized. Returns the new instance id.
    const added = await discogs('POST', `/users/${user}/collection/folders/${ADD_FOLDER}/releases/${releaseId}`);
    if (!added.ok || !added.data || !added.data.instance_id) return passThrough(added, 'add to collection');
    const instanceId = added.data.instance_id;

    // 6. Set each field on the new instance. A failure here does not undo the add.
    const results = [];
    for (const f of fields) {
      const r = await discogs(
        'POST',
        `/users/${user}/collection/folders/${ADD_FOLDER}/releases/${releaseId}/instances/${instanceId}/fields/${f.id}`,
        { value: f.value },
      );
      if (!r.ok) console.error(`[discogs-write] set field ${f.id}: ${r.status}`);
      results.push({ id: f.id, value: f.value, ok: r.ok });
    }

    res.status(200).json({ added: true, instanceId, folderId: ADD_FOLDER, fields: results });
  } catch (e) {
    console.error('[discogs-write] upstream fetch failed', e?.message || e);
    res.status(502).json({ error: 'Failed to reach Discogs' });
  }
}
