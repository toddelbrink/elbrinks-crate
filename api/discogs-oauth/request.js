// Vercel serverless function — Discogs OAuth 1.0a, Phase 1 (request_token)
//
// GET /api/discogs-oauth/request
// Header: Authorization: Bearer <supabase_access_token>
//
// Flow:
//   1. Verify the caller has a valid Supabase session.
//   2. Call Discogs /oauth/request_token with a PLAINTEXT-signed Auth header.
//   3. Stash the returned oauth_token_secret (keyed by oauth_token) in a
//      signed, HttpOnly, SameSite=Lax cookie with a 10-min expiry.
//   4. Respond with { authorize_url } so the browser can open the popup.
//
// Reachable at: https://elbrink.com/vinyl/api/discogs-oauth/request
// Also direct:  https://elbrinks-crate.vercel.app/api/discogs-oauth/request

import { createClient } from '@supabase/supabase-js';
import {
  oauthAuthHeader,
  parseOAuthBody,
  signCookie,
  getSupabaseForRequest,
} from '../../lib/discogs-oauth-helpers.js';

export const config = { runtime: 'nodejs' };

const SUPABASE_URL = 'https://cejdraimvieqjopiccpb.supabase.co';
const SUPABASE_KEY = 'sb_publishable_n63_gkGCZwL1DodV18o8kA_sJxUcrly';

// Registered in the Discogs app config at https://www.discogs.com/settings/developers.
// Hardcoded for v1 — prod traffic always lands at elbrink.com.
const CALLBACK_URL = 'https://elbrink.com/vinyl/api/discogs-oauth/callback';

// 10 minutes. User has this long to authorize on Discogs before the cookie expires.
const COOKIE_TTL_SEC = 600;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // 1. Auth gate
  const { user, error: authError } = await getSupabaseForRequest(req, createClient, SUPABASE_URL, SUPABASE_KEY);
  if (authError) {
    res.status(401).json({ error: authError });
    return;
  }

  // 2. Env vars
  const CONSUMER_KEY = process.env.DISCOGS_CONSUMER_KEY;
  const CONSUMER_SECRET = process.env.DISCOGS_CONSUMER_SECRET;
  const COOKIE_SECRET = process.env.DISCOGS_OAUTH_COOKIE_SECRET;
  if (!CONSUMER_KEY || !CONSUMER_SECRET || !COOKIE_SECRET) {
    res.status(500).json({ error: 'Discogs OAuth env vars not configured' });
    return;
  }

  // 3. Request token from Discogs
  const authHeader = oauthAuthHeader({
    consumerKey: CONSUMER_KEY,
    consumerSecret: CONSUMER_SECRET,
    tokenSecret: '',
    extras: { oauth_callback: CALLBACK_URL },
  });

  let parsed;
  try {
    const r = await fetch('https://api.discogs.com/oauth/request_token', {
      method: 'GET',
      headers: {
        Authorization: authHeader,
        'User-Agent': 'ElbrinksCrate/1.0 +https://elbrink.com/vinyl',
      },
    });
    const text = await r.text();
    if (!r.ok) {
      console.error('[discogs-oauth/request] Discogs returned', r.status, text);
      res.status(502).json({ error: `Discogs returned ${r.status}` });
      return;
    }
    parsed = parseOAuthBody(text);
  } catch (e) {
    console.error('[discogs-oauth/request] fetch failed', e?.message || e);
    res.status(502).json({ error: 'Failed to reach Discogs' });
    return;
  }

  if (!parsed.oauth_token || !parsed.oauth_token_secret) {
    console.error('[discogs-oauth/request] missing tokens in Discogs response', parsed);
    res.status(502).json({ error: 'Discogs returned an unexpected response' });
    return;
  }
  if (parsed.oauth_callback_confirmed && parsed.oauth_callback_confirmed !== 'true') {
    console.error('[discogs-oauth/request] callback not confirmed', parsed);
    res.status(502).json({ error: 'Discogs did not confirm the callback URL' });
    return;
  }

  // 4. Stash the token_secret + user_id in a signed cookie. The callback uses
  // these to (a) recover the token_secret for the access-token exchange and
  // (b) verify the caller is the same user who started the flow.
  const cookieValue = signCookie(
    {
      token: parsed.oauth_token,
      secret: parsed.oauth_token_secret,
      user_id: user.id,
      expires: Date.now() + COOKIE_TTL_SEC * 1000,
    },
    COOKIE_SECRET
  );

  // SameSite=Lax so the cookie is sent on the top-level navigation back from
  // Discogs to /api/discogs-oauth/callback. HttpOnly + Secure for safety.
  res.setHeader('Set-Cookie',
    `discogs_oauth_pending=${cookieValue}; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_TTL_SEC}; Path=/`
  );

  res.status(200).json({
    authorize_url: `https://www.discogs.com/oauth/authorize?oauth_token=${encodeURIComponent(parsed.oauth_token)}`,
  });
}
