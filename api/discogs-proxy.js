// Vercel serverless function — Discogs API proxy
//
// POST /api/discogs-proxy
// Header: Authorization: Bearer <supabase_access_token>
// Body:   { endpoint: '/users/{username}/collection/...' }   (always a leading slash)
//
// Why a proxy exists: Discogs OAuth 1.0a requires every authenticated call to
// be signed with the consumer_secret + the user's per-user access_secret. The
// browser cannot sign safely (consumer_secret would leak). The proxy reads the
// user's stored credentials and signs server-side.
//
// PAT users go through the same path — proxy reads discogs_token (legacy key)
// and sends `Authorization: Discogs token=...` instead of an OAuth header. So
// all Discogs traffic in v1 funnels through this endpoint regardless of mode.
//
// The proxy returns Discogs's response body verbatim with the same status code
// and a JSON Content-Type, so the existing discogsGet caller in the browser can
// continue to call res.json() / check res.ok / handle 429 as before.

import { createClient } from '@supabase/supabase-js';
import {
  discogsAuthForUser,
  getSupabaseForRequest,
} from '../lib/discogs-oauth-helpers.js';

export const config = { runtime: 'nodejs' };

const SUPABASE_URL = 'https://cejdraimvieqjopiccpb.supabase.co';
const SUPABASE_KEY = 'sb_publishable_n63_gkGCZwL1DodV18o8kA_sJxUcrly';

const DISCOGS_BASE = 'https://api.discogs.com';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // 1. Verify Supabase session
  const { supabase, error: authError } = await getSupabaseForRequest(req, createClient, SUPABASE_URL, SUPABASE_KEY);
  if (authError) {
    res.status(401).json({ error: authError });
    return;
  }

  // 2. Parse + validate endpoint
  const body = req.body || {};
  const endpoint = (body.endpoint || '').toString();
  if (!endpoint.startsWith('/')) {
    res.status(400).json({ error: 'endpoint must start with /' });
    return;
  }
  // Restrict to Discogs's expected path shapes. Block path traversal + offsite.
  if (endpoint.includes('..') || endpoint.includes('://')) {
    res.status(400).json({ error: 'invalid endpoint' });
    return;
  }

  // 3-4. The caller's own Discogs credentials, as an Authorization header.
  // Shared with api/discogs-write.js (lib/discogs-oauth-helpers.js).
  const { authHeader, status, error } = await discogsAuthForUser(supabase);
  if (!authHeader) {
    res.status(status).json({ error });
    return;
  }

  // 5. Forward the request
  const upstreamUrl = `${DISCOGS_BASE}${endpoint}`;
  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'GET',
      headers: {
        Authorization: authHeader,
        'User-Agent': 'ElbrinksCrate/1.0 +https://elbrink.com/vinyl',
        Accept: 'application/json',
      },
    });
  } catch (e) {
    console.error('[discogs-proxy] upstream fetch failed', e?.message || e);
    res.status(502).json({ error: 'Failed to reach Discogs' });
    return;
  }

  // 6. Pass through status + body. Preserve Retry-After on 429.
  const retryAfter = upstream.headers.get('Retry-After');
  if (retryAfter) res.setHeader('Retry-After', retryAfter);
  // Force JSON content type — Discogs returns JSON for the endpoints we use,
  // and the browser caller will call .json() on the response.
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(upstream.status);
  const text = await upstream.text();
  res.send(text);
}
