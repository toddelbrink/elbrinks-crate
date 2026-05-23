// Server-side OAuth 1.0a helpers for the Discogs handshake + proxy.
//
// Bundled into Vercel functions that import it — NOT loaded by the browser.
// (The browser-loaded supabase.js is a sibling file but a separate concern.)
//
// PLAINTEXT signature: Discogs accepts it over HTTPS, which lets us skip the
// HMAC-SHA1 base-string dance. The signature is just:
//   request_token:  encode(CONSUMER_SECRET) + "&"
//   access_token / authenticated calls: encode(CONSUMER_SECRET) + "&" + encode(TOKEN_SECRET)
//
// Cookies use HMAC-SHA256 with DISCOGS_OAUTH_COOKIE_SECRET. Format:
//   base64url(JSON payload) + "." + base64url(hmac signature)
// Verification is constant-time.

import crypto from 'node:crypto';

// ── OAuth 1.0a header building ────────────────────────────────

// RFC 3986 percent-encoding (stricter than encodeURIComponent: also escapes !*'() etc).
export function pctEncode(str) {
  return encodeURIComponent(str).replace(/[!*'()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// Build PLAINTEXT-signed Authorization header for a Discogs OAuth 1.0a call.
//
// extras: any of { oauth_callback, oauth_verifier, oauth_token }
// tokenSecret: pass '' for the request_token call (no token yet), pass the
//   token secret for access_token and authenticated calls.
export function oauthAuthHeader({ consumerKey, consumerSecret, tokenSecret = '', extras = {} }) {
  const params = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'PLAINTEXT',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_version: '1.0',
    oauth_signature: `${pctEncode(consumerSecret)}&${pctEncode(tokenSecret)}`,
    ...extras,
  };
  const pairs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${pctEncode(k)}="${pctEncode(v)}"`);
  return 'OAuth ' + pairs.join(', ');
}

// Parse Discogs's url-encoded response bodies (oauth_token=...&oauth_token_secret=...).
export function parseOAuthBody(text) {
  const out = {};
  for (const pair of (text || '').split('&')) {
    const [k, v] = pair.split('=');
    if (k) out[decodeURIComponent(k)] = v ? decodeURIComponent(v) : '';
  }
  return out;
}

// ── Signed cookies (HmAC-SHA256, base64url, constant-time verify) ──

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

// Encode { ...payload } as a signed cookie string. Payload should include its
// own expiry (e.g. expires: Date.now() + 600000) — verifyCookie checks that.
export function signCookie(payload, secret) {
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(body).digest();
  return `${body}.${b64urlEncode(sig)}`;
}

// Returns the parsed payload if valid and not expired, otherwise null.
// Constant-time signature compare.
export function verifyCookie(cookieValue, secret) {
  if (!cookieValue || typeof cookieValue !== 'string') return null;
  const dot = cookieValue.indexOf('.');
  if (dot < 1) return null;
  const body = cookieValue.slice(0, dot);
  const providedSig = cookieValue.slice(dot + 1);
  const expectedSig = b64urlEncode(crypto.createHmac('sha256', secret).update(body).digest());
  if (expectedSig.length !== providedSig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expectedSig), Buffer.from(providedSig))) return null;
  let payload;
  try { payload = JSON.parse(b64urlDecode(body).toString('utf-8')); }
  catch { return null; }
  if (payload?.expires && Date.now() > payload.expires) return null;
  return payload;
}

// ── Cookie header parsing ─────────────────────────────────────

// Minimal — pulls one named cookie out of a Cookie header value.
export function readCookie(header, name) {
  if (!header) return null;
  const parts = header.split(';');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

// ── JWT-scoped Supabase client (mirrors suggest-moods.js pattern) ──

// Returns a Supabase client scoped to the caller's session, or null if the
// Authorization header is missing or invalid. RLS enforces ownership.
export async function getSupabaseForRequest(req, createClient, SUPABASE_URL, SUPABASE_KEY) {
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!jwt) return { supabase: null, user: null, error: 'Missing auth token' };

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) return { supabase: null, user: null, error: 'Invalid session' };
  return { supabase, user: data.user, error: null };
}
