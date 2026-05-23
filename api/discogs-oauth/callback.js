// Vercel serverless function — Discogs OAuth 1.0a, Phase 2 (callback)
//
// GET /api/discogs-oauth/callback?oauth_token=...&oauth_verifier=...
// Cookie: discogs_oauth_pending=<signed payload from /request>
//
// Flow:
//   1. Read + verify the signed cookie from /request (recovers token_secret + user_id).
//   2. Exchange request_token + verifier for access_token + access_secret via Discogs.
//   3. Call /oauth/identity (signed with the new access token) to get the username.
//   4. Render an HTML page that:
//        a. Loads the Supabase client using the user's own session in localStorage.
//        b. Writes discogs_oauth_token + discogs_oauth_secret + username + mode to vinyl_settings.
//        c. postMessages the opener window: { source: 'discogs-oauth', status, username }.
//        d. Self-closes the popup.
//
// Why client-side save? Discogs strips Authorization headers on its redirect, so the
// callback has no Supabase JWT in the request. We CAN trust the user_id in the signed
// cookie (we signed it), but writing on their behalf would require SUPABASE_SERVICE_ROLE_KEY
// (a Step 9 pre-flight item). The popup is same-origin with the opener and has access
// to the user's existing Supabase session in localStorage — let the user's own JWT do
// the writes, RLS approves naturally, no service_role required.

import {
  oauthAuthHeader,
  parseOAuthBody,
  verifyCookie,
  readCookie,
} from '../../lib/discogs-oauth-helpers.js';

export const config = { runtime: 'nodejs' };

const SUPABASE_URL = 'https://cejdraimvieqjopiccpb.supabase.co';
const SUPABASE_KEY = 'sb_publishable_n63_gkGCZwL1DodV18o8kA_sJxUcrly';

// HTML-escape for safe embedding in a <script> string literal context.
// JSON.stringify covers most of it but we still escape </script and U+2028/9.
function jsLiteral(val) {
  return JSON.stringify(val)
    .replace(/<\/script/gi, '<\\/script')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// Render a small HTML page that runs in the popup, saves the tokens via the
// user's own Supabase session, posts a message to the opener, and self-closes.
function renderResultPage({ status, username, oauth_token, oauth_secret, errorMsg }) {
  const payload = {
    status,
    username: username || null,
    oauth_token: oauth_token || null,
    oauth_secret: oauth_secret || null,
    error: errorMsg || null,
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Discogs connected</title>
<style>
  html,body{margin:0;height:100%;background:#111;color:#e5e5e5;font:14px/1.4 -apple-system,system-ui,sans-serif}
  .wrap{display:flex;align-items:center;justify-content:center;height:100%;padding:24px;text-align:center}
  .card{max-width:360px}
  .ok{color:#84cc16}
  .err{color:#ef4444}
  h1{font-size:18px;margin:0 0 8px}
  p{color:#a3a3a3;margin:0}
  .small{font-size:12px;margin-top:16px}
</style>
</head>
<body>
<div class="wrap"><div class="card">
  <h1 id="hdr">Finishing up…</h1>
  <p id="msg">Saving your Discogs connection.</p>
  <p class="small" id="hint"></p>
</div></div>
<script type="module">
  import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.48.0';
  const SUPABASE_URL = ${jsLiteral(SUPABASE_URL)};
  const SUPABASE_KEY = ${jsLiteral(SUPABASE_KEY)};
  const PAYLOAD = ${jsLiteral(payload)};

  const hdr = document.getElementById('hdr');
  const msg = document.getElementById('msg');
  const hint = document.getElementById('hint');

  function notifyAndClose(message) {
    try { if (window.opener) window.opener.postMessage(message, window.location.origin); } catch (e) {}
    setTimeout(() => { try { window.close(); } catch (e) {} }, 800);
  }

  (async () => {
    if (PAYLOAD.status !== 'success') {
      hdr.textContent = 'Connection failed';
      hdr.className = 'err';
      msg.textContent = PAYLOAD.error || 'Something went wrong.';
      hint.textContent = 'This window will close in a moment.';
      notifyAndClose({ source: 'discogs-oauth', status: 'error', error: PAYLOAD.error || 'unknown' });
      return;
    }

    try {
      const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: true, autoRefreshToken: true },
      });
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('No active session in this browser — please sign in first.');

      // Three vinyl_settings rows: token, secret, username, mode. saveSetting upserts.
      const rows = [
        { setting_key: 'discogs_oauth_token', setting_val: PAYLOAD.oauth_token },
        { setting_key: 'discogs_oauth_secret', setting_val: PAYLOAD.oauth_secret },
        { setting_key: 'username', setting_val: PAYLOAD.username },
        { setting_key: 'discogs_mode', setting_val: 'oauth' },
      ];
      const { error } = await supabase.from('vinyl_settings').upsert(rows);
      if (error) throw error;

      hdr.textContent = 'Connected as @' + PAYLOAD.username;
      hdr.className = 'ok';
      msg.textContent = 'You can close this window.';
      hint.textContent = 'Returning to Crate…';
      notifyAndClose({ source: 'discogs-oauth', status: 'success', username: PAYLOAD.username });
    } catch (e) {
      hdr.textContent = 'Save failed';
      hdr.className = 'err';
      msg.textContent = (e && e.message) ? e.message : 'Could not save credentials.';
      hint.textContent = 'Try again from Settings → Discogs → Reconnect.';
      notifyAndClose({ source: 'discogs-oauth', status: 'error', error: (e && e.message) || 'save_failed' });
    }
  })();
</script>
</body>
</html>`;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).send('Method not allowed');
    return;
  }

  const CONSUMER_KEY = process.env.DISCOGS_CONSUMER_KEY;
  const CONSUMER_SECRET = process.env.DISCOGS_CONSUMER_SECRET;
  const COOKIE_SECRET = process.env.DISCOGS_OAUTH_COOKIE_SECRET;
  if (!CONSUMER_KEY || !CONSUMER_SECRET || !COOKIE_SECRET) {
    res.status(500).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderResultPage({ status: 'error', errorMsg: 'Server misconfigured (env vars missing).' }));
    return;
  }

  const url = new URL(req.url || '/', `https://${req.headers.host}`);
  const oauth_token = url.searchParams.get('oauth_token');
  const oauth_verifier = url.searchParams.get('oauth_verifier');
  const denied = url.searchParams.get('denied');

  // User cancelled at the Discogs authorize page.
  if (denied || !oauth_verifier) {
    res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderResultPage({ status: 'error', errorMsg: 'Connection cancelled.' }));
    return;
  }
  if (!oauth_token) {
    res.status(400).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderResultPage({ status: 'error', errorMsg: 'Missing oauth_token from Discogs.' }));
    return;
  }

  // Read + verify the cookie set by /request. Get back token_secret + user_id.
  const cookieHeader = req.headers.cookie || '';
  const cookieValue = readCookie(cookieHeader, 'discogs_oauth_pending');
  const payload = verifyCookie(cookieValue, COOKIE_SECRET);
  if (!payload) {
    res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderResultPage({ status: 'error', errorMsg: 'Connection timed out — please start over.' }));
    return;
  }
  if (payload.token !== oauth_token) {
    // Either the user kicked off two flows and we're seeing the second token,
    // or someone is replaying. Either way, refuse.
    res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderResultPage({ status: 'error', errorMsg: 'Token mismatch — please start over.' }));
    return;
  }

  // Phase 2 — exchange request_token + verifier for access_token + access_secret.
  const accessAuthHeader = oauthAuthHeader({
    consumerKey: CONSUMER_KEY,
    consumerSecret: CONSUMER_SECRET,
    tokenSecret: payload.secret,
    extras: { oauth_token, oauth_verifier },
  });

  let accessTokens;
  try {
    const r = await fetch('https://api.discogs.com/oauth/access_token', {
      method: 'POST',
      headers: {
        Authorization: accessAuthHeader,
        'User-Agent': 'ElbrinksCrate/1.0 +https://elbrink.com/vinyl',
      },
    });
    const text = await r.text();
    if (!r.ok) {
      console.error('[discogs-oauth/callback] access_token failed', r.status, text);
      res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(renderResultPage({ status: 'error', errorMsg: `Discogs returned ${r.status}.` }));
      return;
    }
    accessTokens = parseOAuthBody(text);
  } catch (e) {
    console.error('[discogs-oauth/callback] access_token fetch error', e?.message || e);
    res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderResultPage({ status: 'error', errorMsg: 'Failed to reach Discogs.' }));
    return;
  }

  const access_token = accessTokens.oauth_token;
  const access_secret = accessTokens.oauth_token_secret;
  if (!access_token || !access_secret) {
    res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderResultPage({ status: 'error', errorMsg: 'Discogs returned an unexpected response.' }));
    return;
  }

  // Phase 3 — fetch /oauth/identity to get the username.
  let username = null;
  try {
    const identityHeader = oauthAuthHeader({
      consumerKey: CONSUMER_KEY,
      consumerSecret: CONSUMER_SECRET,
      tokenSecret: access_secret,
      extras: { oauth_token: access_token },
    });
    const r = await fetch('https://api.discogs.com/oauth/identity', {
      method: 'GET',
      headers: {
        Authorization: identityHeader,
        'User-Agent': 'ElbrinksCrate/1.0 +https://elbrink.com/vinyl',
      },
    });
    if (r.ok) {
      const j = await r.json();
      username = j.username || null;
    } else {
      console.warn('[discogs-oauth/callback] identity returned', r.status);
    }
  } catch (e) {
    console.warn('[discogs-oauth/callback] identity fetch error', e?.message || e);
  }

  // Clear the pending cookie — it's served its purpose.
  res.setHeader('Set-Cookie', 'discogs_oauth_pending=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/');
  res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderResultPage({
    status: 'success',
    username,
    oauth_token: access_token,
    oauth_secret: access_secret,
  }));
}
