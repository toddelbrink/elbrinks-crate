// Elbrink's Crate — Supabase client + API wrappers
//
// Loaded as <script type="module" src="/lib/supabase.js"></script>.
// Modules are implicitly deferred, so this runs after HTML parse.
// The hosting page must set up window.crateReady BEFORE this loads:
//
//   <script>window.crateReady = new Promise(r => window._crateReadyResolve = r);</script>
//   <script type="module" src="/lib/supabase.js"></script>
//
// And replace its `init()` call with `crateReady.then(init)`.
//
// Each wrapper returns the same shape the old PHP API returned
// ({ success: true, data: ... } or { success: true, ...result }) so
// the calling code can stay nearly identical.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.48.0';

const SUPABASE_URL = 'https://cejdraimvieqjopiccpb.supabase.co';
// Publishable key from Supabase dashboard → Project Settings → API → Publishable and secret API keys.
// Public by design; RLS is the security boundary. Do NOT use the secret key here.
const SUPABASE_KEY = 'sb_publishable_n63_gkGCZwL1DodV18o8kA_sJxUcrly';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true, // handles magic-link callback
  },
});

// ── Helpers ──────────────────────────────────────────────────
function ok(extra = {}) { return { success: true, ...extra }; }
function fail(error, fallback = {}) {
  console.error('[crate]', error);
  return { success: false, error: error?.message || String(error), ...fallback };
}

// Strip undefined keys (preserve null — explicit null means "set to null").
function trim(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// ── Reads ─────────────────────────────────────────────────────

// Read wrappers accept an optional { userId } arg used by the share page
// to filter anon-readable queries to a single user's rows. Authenticated
// callers (the PWA) omit it — RLS scopes to auth.uid() automatically.
// Pre-multi-user, anon read everything; post-v1, anon RLS scopes to
// share_enabled = true profiles only; with multiple opted-in users the
// explicit user_id filter is what keeps share pages from mixing data.

async function loadPlays({ userId } = {}) {
  try {
    let q = supabase.from('vinyl_plays').select('*');
    if (userId) q = q.eq('user_id', userId);
    const { data, error } = await q;
    if (error) throw error;
    const map = {};
    for (const row of data) {
      map[row.release_id] = {
        play_count: row.play_count || 0,
        last_played: row.last_played || null,
        cycle_played: !!row.cycle_played,
      };
    }
    return ok({ data: map });
  } catch (e) { return fail(e, { data: {} }); }
}

async function loadMeta({ userId } = {}) {
  try {
    let q = supabase.from('vinyl_meta').select('*');
    if (userId) q = q.eq('user_id', userId);
    const { data, error } = await q;
    if (error) throw error;
    const map = {};
    for (const row of data) {
      map[row.release_id] = {
        genres: row.genres || [],
        styles: row.styles || [],
        moods: row.moods || [],
        notes: row.notes || '',
        art_url: row.art_url || '',
        artist_wiki_url: row.artist_wiki_url || '',
      };
    }
    return ok({ data: map });
  } catch (e) { return fail(e, { data: {} }); }
}

async function loadCollection({ userId } = {}) {
  try {
    let q = supabase.from('vinyl_collection').select('release_id, data');
    if (userId) q = q.eq('user_id', userId);
    const { data, error } = await q;
    if (error) throw error;
    return ok({ data: data.map(r => r.data) });
  } catch (e) { return fail(e, { data: [] }); }
}

async function loadArtists({ userId } = {}) {
  try {
    let q = supabase.from('vinyl_artists').select('*');
    if (userId) q = q.eq('user_id', userId);
    const { data, error } = await q;
    if (error) throw error;
    const map = {};
    for (const row of data) {
      map[row.artist_id] = {
        artist_name: row.artist_name || '',
        discogs_url: row.discogs_url || '',
        wiki_url: row.wiki_url || '',
        bio_text: row.bio_text || '',
        image_url: row.image_url || '',
      };
    }
    return ok({ data: map });
  } catch (e) { return fail(e, { data: {} }); }
}

async function loadWantlist({ userId } = {}) {
  try {
    let q = supabase.from('vinyl_wantlist').select('release_id, data');
    if (userId) q = q.eq('user_id', userId);
    const { data, error } = await q;
    if (error) throw error;
    return ok({ data: data.map(r => r.data) });
  } catch (e) { return fail(e, { data: [] }); }
}

// Authenticated only — vinyl_settings has the Discogs token.
async function loadSettings() {
  try {
    const { data, error } = await supabase.from('vinyl_settings').select('setting_key, setting_val');
    if (error) throw error;
    const map = {};
    for (const row of data) map[row.setting_key] = row.setting_val;
    return ok({ data: map });
  } catch (e) { return fail(e, { data: {} }); }
}

// Anon-readable subset (cycle, etc.) via public_settings view.
async function loadPublicSettings() {
  try {
    const { data, error } = await supabase.from('public_settings').select('setting_key, setting_val');
    if (error) throw error;
    const map = {};
    for (const row of data) map[row.setting_key] = row.setting_val;
    return ok({ data: map });
  } catch (e) { return fail(e, { data: {} }); }
}

// ── Writes — settings ────────────────────────────────────────

async function saveSetting(key, value) {
  if (!key) return fail('key required');
  try {
    const { error } = await supabase
      .from('vinyl_settings')
      .upsert({ setting_key: key, setting_val: value });
    if (error) throw error;
    return ok();
  } catch (e) { return fail(e); }
}

// ── Writes — collection ──────────────────────────────────────

async function saveCollection(records) {
  if (!records?.length) return ok({ message: 'Nothing to save' });
  try {
    const rows = [];
    for (const r of records) {
      const rid = r.releaseId || r.id;
      if (!rid) continue;
      rows.push({ release_id: String(rid), data: r });
    }
    const { error } = await supabase.from('vinyl_collection').upsert(rows);
    if (error) throw error;
    return ok({ message: `Saved ${rows.length} records` });
  } catch (e) { return fail(e); }
}

// ── Writes — meta ────────────────────────────────────────────

// COALESCE-style merge: only the fields you pass are updated.
// Caller passes { genres, moods, notes, art_url, artist_wiki_url } — any subset.
async function saveMeta(releaseId, fields) {
  if (!releaseId) return fail('release_id required');
  const payload = trim({ release_id: String(releaseId), ...fields });
  if (Object.keys(payload).length <= 1) return ok({ message: 'No fields to update' });
  try {
    const { error } = await supabase.from('vinyl_meta').upsert(payload);
    if (error) throw error;
    return ok();
  } catch (e) { return fail(e); }
}

// data: { [release_id]: { genres?, moods?, notes?, art_url?, artist_wiki_url? } }
async function bulkMeta(data) {
  const ids = Object.keys(data || {});
  if (!ids.length) return ok({ message: 'Nothing to save' });
  try {
    // Build payloads; keep only provided fields per row.
    const rows = ids.map(rid => trim({ release_id: rid, ...data[rid] }));
    const { error } = await supabase.from('vinyl_meta').upsert(rows);
    if (error) throw error;
    return ok({ message: `Saved ${rows.length} records` });
  } catch (e) { return fail(e); }
}

async function clearMeta() {
  try {
    const { error } = await supabase.from('vinyl_meta').delete().neq('release_id', '');
    if (error) throw error;
    return ok({ message: 'All metadata cleared' });
  } catch (e) { return fail(e); }
}

// ── Writes — plays ───────────────────────────────────────────

// Increment play_count by 1, set last_played=now, set cycle_played=true.
// Single-user app — read-then-write is acceptable, no race concern.
async function recordPlay(releaseId) {
  if (!releaseId) return fail('release_id required');
  try {
    const { data: existing } = await supabase
      .from('vinyl_plays')
      .select('play_count')
      .eq('release_id', releaseId)
      .maybeSingle();
    const newCount = (existing?.play_count || 0) + 1;
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from('vinyl_plays')
      .upsert({
        release_id: String(releaseId),
        play_count: newCount,
        last_played: now,
        cycle_played: true,
      })
      .select()
      .single();
    if (error) throw error;
    return ok({
      release_id: data.release_id,
      play_count: data.play_count,
      last_played: data.last_played,
      cycle_played: true,
    });
  } catch (e) { return fail(e); }
}

// Set absolute play count. count <= 0 deletes the row.
// Also keeps vinyl_play_events aligned: the +/- editor is an admin correction,
// not real listening — it never *adds* events, but on decrement it trims the
// most-recent matching events so Recent Plays stays truthful. count <= 0 wipes
// every event for this release. RLS scopes everything to the current user.
async function setPlayCount(releaseId, count) {
  if (!releaseId) return fail('release_id required');
  count = parseInt(count) || 0;
  try {
    if (count <= 0) {
      const { error: evErr } = await supabase
        .from('vinyl_play_events')
        .delete()
        .eq('release_id', String(releaseId));
      if (evErr) throw evErr;
      const { error } = await supabase.from('vinyl_plays').delete().eq('release_id', releaseId);
      if (error) throw error;
      return ok({ release_id: releaseId, play_count: 0 });
    }
    const { data: existing } = await supabase
      .from('vinyl_plays')
      .select('play_count')
      .eq('release_id', releaseId)
      .maybeSingle();
    const oldCount = existing?.play_count || 0;
    if (count < oldCount) {
      const toDelete = oldCount - count;
      const { data: stale, error: rdErr } = await supabase
        .from('vinyl_play_events')
        .select('id')
        .eq('release_id', String(releaseId))
        .order('played_at', { ascending: false })
        .limit(toDelete);
      if (rdErr) throw rdErr;
      if (stale && stale.length) {
        const { error: delErr } = await supabase
          .from('vinyl_play_events')
          .delete()
          .in('id', stale.map(r => r.id));
        if (delErr) throw delErr;
      }
    }
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from('vinyl_plays')
      .upsert({
        release_id: String(releaseId),
        play_count: count,
        last_played: now,
        cycle_played: true,
      })
      .select()
      .single();
    if (error) throw error;
    return ok({
      release_id: data.release_id,
      play_count: data.play_count,
      last_played: data.last_played,
    });
  } catch (e) { return fail(e); }
}

async function resetCycle() {
  try {
    const { error } = await supabase
      .from('vinyl_plays')
      .update({ cycle_played: false })
      .neq('release_id', '');
    if (error) throw error;
    return ok({ message: 'Cycle reset' });
  } catch (e) { return fail(e); }
}

async function clearPlays() {
  try {
    const { error } = await supabase.from('vinyl_plays').delete().neq('release_id', '');
    if (error) throw error;
    return ok({ message: 'All play data cleared' });
  } catch (e) { return fail(e); }
}

// data: { [release_id]: { play_count, last_played, cycle_played } }
// Mirrors PHP sync: GREATEST(play_count), COALESCE(last_played), GREATEST(cycle_played).
// Read-merge-upsert in JS — fine for ~100 rows, single-user.
async function syncPlays(data) {
  const ids = Object.keys(data || {});
  if (!ids.length) return ok({ message: 'Nothing to sync' });
  try {
    const { data: existing, error: readErr } = await supabase
      .from('vinyl_plays')
      .select('*')
      .in('release_id', ids);
    if (readErr) throw readErr;
    const existingMap = Object.fromEntries((existing || []).map(r => [r.release_id, r]));
    const rows = ids.map(rid => {
      const inc = data[rid] || {};
      const ex = existingMap[rid] || { play_count: 0, last_played: null, cycle_played: false };
      return {
        release_id: String(rid),
        play_count: Math.max(ex.play_count || 0, parseInt(inc.play_count) || 0),
        last_played: ex.last_played || inc.last_played || null,
        cycle_played: !!(ex.cycle_played || inc.cycle_played),
      };
    });
    const { error } = await supabase.from('vinyl_plays').upsert(rows);
    if (error) throw error;
    return ok({ message: `Synced ${rows.length} records` });
  } catch (e) { return fail(e); }
}

// ── Writes — artists ─────────────────────────────────────────

async function saveArtist(artistId, fields) {
  if (!artistId) return fail('artist_id required');
  const payload = trim({ artist_id: String(artistId), ...fields });
  if (Object.keys(payload).length <= 1) return ok({ message: 'No fields to update' });
  try {
    const { error } = await supabase.from('vinyl_artists').upsert(payload);
    if (error) throw error;
    return ok();
  } catch (e) { return fail(e); }
}

// artists: { [artist_id]: { artist_name?, discogs_url?, wiki_url?, bio_text?, image_url? } }
async function bulkArtists(artists) {
  const ids = Object.keys(artists || {});
  if (!ids.length) return ok({ message: 'Nothing to save' });
  try {
    const rows = ids.map(aid => trim({ artist_id: aid, ...artists[aid] }));
    const { error } = await supabase.from('vinyl_artists').upsert(rows);
    if (error) throw error;
    return ok({ message: `Saved ${rows.length} artists` });
  } catch (e) { return fail(e); }
}

// Replaces wiki URL and clears cached bio so next render re-fetches.
async function saveArtistWiki(artistId, wikiUrl) {
  if (!artistId) return fail('artist_id required');
  try {
    const { error } = await supabase
      .from('vinyl_artists')
      .update({ wiki_url: wikiUrl || '', bio_text: null })
      .eq('artist_id', artistId);
    if (error) throw error;
    return ok();
  } catch (e) { return fail(e); }
}

// ── Writes — wantlist ────────────────────────────────────────

// Mirrors PHP save_wantlist: upsert all + delete records not in the new set.
// Empty records array clears the table.
async function saveWantlist(records) {
  try {
    if (!records?.length) {
      const { error } = await supabase.from('vinyl_wantlist').delete().neq('release_id', '');
      if (error) throw error;
      return ok({ message: 'Wantlist cleared' });
    }
    const rows = [];
    const idSet = new Set();
    for (const r of records) {
      const rid = r.releaseId || r.id;
      if (!rid) continue;
      rows.push({ release_id: String(rid), data: r });
      idSet.add(String(rid));
    }
    const { error: upErr } = await supabase.from('vinyl_wantlist').upsert(rows);
    if (upErr) throw upErr;
    // Drop any rows that aren't in the new set. Two-step (fetch existing, diff,
    // delete the leftovers) is clearer and faster than a NOT IN over a long list.
    const { data: existing, error: readErr } = await supabase
      .from('vinyl_wantlist').select('release_id');
    if (readErr) throw readErr;
    const toDelete = (existing || [])
      .map(r => r.release_id)
      .filter(id => !idSet.has(id));
    if (toDelete.length) {
      const { error: delErr } = await supabase
        .from('vinyl_wantlist').delete().in('release_id', toDelete);
      if (delErr) throw delErr;
    }
    return ok({ message: `Saved ${rows.length} wantlist records` });
  } catch (e) { return fail(e); }
}

// ── Auth ──────────────────────────────────────────────────────

async function signInWithGoogle() {
  try {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + window.location.pathname },
    });
    if (error) throw error;
    return ok();
  } catch (e) { return fail(e); }
}

async function signOut() {
  try {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
    return ok();
  } catch (e) { return fail(e); }
}

async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session || null;
}

function onAuthChange(cb) {
  return supabase.auth.onAuthStateChange((_event, session) => cb(session));
}

// ── Play events (Multi-User v1 / Step 5; jsonb mood_active per v1.1 §9 Step 1) ─
// Per-play row in vinyl_play_events. Captures the moment, the mood(s) that
// were active per PRD §9.2, and where the play originated. Fire-and-forget —
// failure to insert does not block the play UI.
//
// Contract:
//   opts.mood_active — array of mood slugs (1..N) or null. Never a bare string.
//   opts.source      — one of: manual / mood_filter / shuffle / shuffle_by_mood.
async function recordPlayEvent(releaseId, opts = {}) {
  if (!releaseId) return fail('release_id required');
  try {
    const mood = opts.mood_active ?? null;
    const source = opts.source || 'manual';
    const { error } = await supabase
      .from('vinyl_play_events')
      .insert({ release_id: releaseId, played_at: new Date().toISOString(), mood_active: mood, source });
    if (error) return fail(error);
    return ok();
  } catch (e) { return fail(e); }
}

// Load recent play events for the current user. Joins client-side against
// the in-memory collection for art / title / artist (no schema join needed).
async function loadRecentPlays(limit = 50, offset = 0) {
  try {
    const { data, error } = await supabase
      .from('vinyl_play_events')
      .select('id, release_id, played_at, mood_active, source')
      .order('played_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) return fail(error);
    return ok({ data: data || [] });
  } catch (e) { return fail(e); }
}

// ── Moods CRUD (Multi-User v1 / Step 4) ──────────────────────
// vinyl_user_moods rows are owned by the current user via RLS.
// The slug column bridges the legacy string ids in vinyl_meta.moods arrays
// with the new UUID-keyed table. All app code refers to moods by slug.

async function loadMoods() {
  try {
    const { data, error } = await supabase
      .from('vinyl_user_moods')
      .select('id, slug, mood_name, color_key, sort_order, keywords, description')
      .order('sort_order', { ascending: true });
    if (error) return fail(error);
    return ok({ data: data || [] });
  } catch (e) { return fail(e); }
}

// Create a new mood. Slug is derived from mood_name (lowercase, alphanumeric only).
// keywords is an array of Discogs genre/style strings used by the sync-time
// heuristic. description is the user's own explanation of what the mood means —
// feeds the Claude prompt in /api/suggest-moods so the LLM has user intent
// context beyond the bare label (PRD v1.1 §9.3).
async function createMood({ mood_name, color_key, keywords, description }) {
  try {
    const slug = (mood_name || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40) || 'mood';
    const { data: existing } = await supabase
      .from('vinyl_user_moods')
      .select('sort_order')
      .order('sort_order', { ascending: false })
      .limit(1);
    const next = (existing && existing[0]) ? (existing[0].sort_order + 1) : 1;
    const payload = { slug, mood_name, color_key, sort_order: next };
    if (Array.isArray(keywords)) payload.keywords = keywords;
    if (typeof description === 'string') payload.description = description.trim() || null;
    const { data, error } = await supabase
      .from('vinyl_user_moods')
      .insert(payload)
      .select()
      .single();
    if (error) return fail(error);
    return ok({ data });
  } catch (e) { return fail(e); }
}

async function updateMood(id, fields) {
  try {
    const { error } = await supabase
      .from('vinyl_user_moods')
      .update(fields)
      .eq('id', id);
    if (error) return fail(error);
    return ok();
  } catch (e) { return fail(e); }
}

async function deleteMood(id) {
  try {
    const { error } = await supabase
      .from('vinyl_user_moods')
      .delete()
      .eq('id', id);
    if (error) return fail(error);
    return ok();
  } catch (e) { return fail(e); }
}

// reorderMoods takes an array of { id, sort_order } and writes them in one
// batch. Used after drag-reorder in the Moods subpanel.
async function reorderMoods(orderedIds) {
  try {
    const updates = orderedIds.map((id, idx) =>
      supabase.from('vinyl_user_moods').update({ sort_order: idx + 1 }).eq('id', id)
    );
    const results = await Promise.all(updates);
    const firstErr = results.find(r => r.error);
    if (firstErr) return fail(firstErr.error);
    return ok();
  } catch (e) { return fail(e); }
}

// ── User profile (Multi-User v1 / Step 4) ────────────────────
async function loadProfile() {
  try {
    const { data, error } = await supabase
      .from('vinyl_user_profile')
      .select('crate_name, share_enabled, share_slug, telemetry_consent, onboarding_completed_at')
      .maybeSingle();
    if (error) return fail(error);
    return ok({ data: data || null });
  } catch (e) { return fail(e); }
}

async function updateProfile(fields) {
  try {
    const session = await getSession();
    if (!session) return fail(new Error('no session'));
    const { error } = await supabase
      .from('vinyl_user_profile')
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq('user_id', session.user.id);
    if (error) return fail(error);
    return ok();
  } catch (e) { return fail(e); }
}

// ensureProfile — guarantees a vinyl_user_profile row exists for the signed-in
// user. Returns the profile (loading existing or creating a default). Idempotent.
//
// Default crate_name derived from Google identity: split full_name on space,
// take first word, append "'s Crate". Falls back to "My Crate" if no name
// available. User can rename via Settings → Account at any time.
//
// Why this lives here (not as a Supabase trigger): Supabase Free tier doesn't
// reliably allow triggers on auth.users; this client-side path runs on every
// init so it covers both new sign-ins AND legacy users whose user row pre-dates
// the auto-create wiring. Idempotent via SELECT-then-INSERT (the UNIQUE
// constraint on user_id would also catch races, but the check-first path
// avoids a noisy 23505 in the common case).
async function ensureProfile() {
  try {
    const session = await getSession();
    if (!session) return fail(new Error('no session'));
    const userId = session.user.id;

    // Try to load first — covers the common case (existing user).
    const existing = await loadProfile();
    if (existing.success && existing.data) return existing;

    // No row. Derive a sensible default crate_name from Google identity.
    const meta = session.user.user_metadata || {};
    const fullName = (meta.full_name || meta.name || '').trim();
    const firstWord = fullName.split(/\s+/)[0] || 'My';
    const crateName = `${firstWord}'s Crate`;

    // Insert. Don't pass share_enabled / telemetry_consent — table defaults
    // (false on both per v1 schema) carry the privacy-first stance.
    const { error: insErr } = await supabase
      .from('vinyl_user_profile')
      .insert({ user_id: userId, crate_name: crateName });
    if (insErr) {
      // 23505 = unique_violation — race with a concurrent ensureProfile call.
      // Just re-read whatever landed.
      if (insErr.code === '23505') return await loadProfile();
      return fail(insErr);
    }
    // Read back so the caller gets the canonical row (with server timestamps).
    return await loadProfile();
  } catch (e) { return fail(e); }
}

// ── Share pages (v1.1 / Sprint 1 item 2) ─────────────────────
//
// loadProfileBySlug — anon-safe slug → {user_id, share_slug, crate_name}
// lookup via the public_profiles view (created v1.1 migration). Returns
// data: null if no row matches (slug doesn't exist or share is off).
async function loadProfileBySlug(slug) {
  if (!slug) return ok({ data: null });
  try {
    const { data, error } = await supabase
      .from('public_profiles')
      .select('user_id, share_slug, crate_name')
      .eq('share_slug', slug)
      .maybeSingle();
    if (error) return fail(error);
    return ok({ data: data || null });
  } catch (e) { return fail(e); }
}

// Convert a crate_name into a URL slug per PRD v1.1 §3.2. Strip "'s Crate"
// suffix, lowercase, collapse non-alphanumerics to hyphens, trim length.
// Empty result returns null — caller decides what to do (typically falls
// back to crate-<random6> via the slug generator below).
function slugifyCrateName(crateName) {
  if (!crateName) return null;
  let s = String(crateName).trim();
  // Strip possessive-crate suffix in any common form.
  s = s.replace(/['’]s\s+crate\s*$/i, '');
  s = s.toLowerCase()
       .replace(/[‘’ʼ']/g, '')   // smart + straight apostrophes
       .replace(/[^a-z0-9]+/g, '-')
       .replace(/^-+|-+$/g, '')
       .slice(0, 24)
       .replace(/-+$/, '');
  return s || null;
}

// Generate a unique slug. Tries the base, then -2, -3, ... until UNIQUE.
// Up to 20 attempts before falling back to crate-<random6>.
async function generateUniqueSlug(crateName) {
  const base = slugifyCrateName(crateName);
  if (!base) {
    // Empty result: fall back to crate-<random6>. random6 generated
    // browser-side via crypto.getRandomValues for collision-resistance.
    const bytes = new Uint8Array(3);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    return `crate-${hex}`;
  }
  // Probe the public_profiles view (anon-readable) for in-use slugs.
  // Read once, decide locally — avoids N round-trips.
  const { data, error } = await supabase
    .from('public_profiles')
    .select('share_slug')
    .ilike('share_slug', `${base}%`);
  if (error) {
    // If lookup fails, optimistically return the base and let the
    // UNIQUE constraint catch any collision on insert.
    return base;
  }
  const taken = new Set((data || []).map(r => r.share_slug));
  if (!taken.has(base)) return base;
  for (let i = 2; i <= 20; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Edge: more than 20 collisions — fall back to random suffix.
  const bytes = new Uint8Array(3);
  (window.crypto || window.msCrypto).getRandomValues(bytes);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${base}-${hex}`;
}

// Flip share_enabled. When turning ON the first time, generate a slug from
// crate_name and write it alongside. When turning ON with an existing slug,
// just flip the flag — preserves stable URLs across off->on cycles per §3.3.
// Returns the resulting { share_enabled, share_slug } on success.
async function setShareEnabled({ enabled }) {
  try {
    const session = await getSession();
    if (!session) return fail(new Error('no session'));
    const userId = session.user.id;

    // Always re-read current profile state to make the right decision.
    const { data: profile, error: readErr } = await supabase
      .from('vinyl_user_profile')
      .select('crate_name, share_enabled, share_slug')
      .eq('user_id', userId)
      .maybeSingle();
    if (readErr) return fail(readErr);
    // Defensive: ensureProfile runs at init so we should always find a row
    // here, but a stale tab that pre-dates the ensureProfile deploy could hit
    // this. Create the row on the fly and re-read rather than failing the toggle.
    if (!profile) {
      const created = await ensureProfile();
      if (!created.success || !created.data) return fail(new Error('profile not found and ensureProfile failed'));
      return await setShareEnabled({ enabled });
    }

    if (!enabled) {
      // Turning OFF — preserve slug so re-enabling restores same URL.
      const { error } = await supabase
        .from('vinyl_user_profile')
        .update({ share_enabled: false, updated_at: new Date().toISOString() })
        .eq('user_id', userId);
      if (error) return fail(error);
      return ok({ data: { share_enabled: false, share_slug: profile.share_slug || null } });
    }

    // Turning ON. If a slug already exists, just flip the flag.
    if (profile.share_slug) {
      const { error } = await supabase
        .from('vinyl_user_profile')
        .update({ share_enabled: true, updated_at: new Date().toISOString() })
        .eq('user_id', userId);
      if (error) return fail(error);
      return ok({ data: { share_enabled: true, share_slug: profile.share_slug } });
    }

    // No slug yet — generate, then write. Retry on UNIQUE conflict by
    // appending a higher numeric suffix; protects against the rare race
    // where another user grabs the same slug between our SELECT and UPDATE.
    let slug = await generateUniqueSlug(profile.crate_name);
    for (let attempt = 0; attempt < 5; attempt++) {
      const { error } = await supabase
        .from('vinyl_user_profile')
        .update({
          share_enabled: true,
          share_slug: slug,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', userId);
      if (!error) {
        return ok({ data: { share_enabled: true, share_slug: slug } });
      }
      // 23505 = unique_violation. Anything else, bail.
      if (error.code !== '23505') return fail(error);
      // Append a higher suffix and retry.
      slug = await generateUniqueSlug(profile.crate_name + ' ' + (attempt + 2));
    }
    return fail(new Error('could not allocate unique slug after retries'));
  } catch (e) { return fail(e); }
}

// ── Feedback (Multi-User v1 / Step 6) ────────────────────────
// vinyl_feedback rows are owner-insert / owner-or-admin-select via RLS.
// is_admin is read from the JWT app_metadata — no DB call needed.

async function submitFeedback({ sentiment, category, body, app_version }) {
  if (!category) return fail('category required');
  try {
    const payload = trim({
      sentiment: sentiment || null,
      category,
      body: (body || '').trim() || null,
      app_version: app_version || null,
    });
    const { error } = await supabase.from('vinyl_feedback').insert(payload);
    if (error) return fail(error);
    return ok();
  } catch (e) { return fail(e); }
}

// Admin-only — RLS owner_or_admin_select gates this to is_admin() callers.
// Non-admin callers get only their own rows (which is still useful for v1.1
// "Your past feedback" but no surface for it yet in v1).
async function loadAllFeedback({ limit = 200, offset = 0 } = {}) {
  try {
    const { data, error } = await supabase
      .from('vinyl_feedback')
      .select('id, user_id, sentiment, category, body, app_version, created_at')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) return fail(error);
    return ok({ data: data || [] });
  } catch (e) { return fail(e); }
}

// Reads is_admin from the JWT (raw_app_meta_data.is_admin). No DB call.
// Returns true / false synchronously once a session is in hand.
function isAdmin(session) {
  return !!(session && session.user && session.user.app_metadata && session.user.app_metadata.is_admin === true);
}

// Resolve { user_id: email } for the given UIDs. Admin-only — requires
// a service-role helper (deferred) or, for v1, falls back to the caller's
// own email (since regular users can't read auth.users). For the admin
// route, we read the email map via a small RPC defined in Step 6.
async function loadUserEmails(userIds) {
  try {
    if (!userIds?.length) return ok({ data: {} });
    const { data, error } = await supabase.rpc('admin_user_emails', { user_ids: userIds });
    if (error) return fail(error, { data: {} });
    const map = {};
    for (const row of (data || [])) map[row.user_id] = row.email;
    return ok({ data: map });
  } catch (e) { return fail(e, { data: {} }); }
}

// ── Invite gate (Multi-User v1 / Step 3) ─────────────────────
// Call after Google sign-in succeeds. Returns one of:
//   { status: 'accepted',  firstTime: false }  — user is in good standing
//   { status: 'accepted',  firstTime: true  }  — pending row was just flipped to accepted (run onboarding)
//   { status: 'revoked' }                       — Todd pulled access, bounce out
//   { status: 'none' }                          — email not on allowlist, bounce out
//   { status: 'error', error }                  — query failed, sign in not complete
// RLS self_read + self_accept policies on vinyl_invites mean a user can only
// see/touch their own row.
async function checkInvite(email, userId) {
  if (!email) return { status: 'error', error: new Error('checkInvite: no email') };
  const { data, error } = await supabase
    .from('vinyl_invites')
    .select('id, status, user_id')
    .eq('email', email)
    .maybeSingle();
  if (error) return { status: 'error', error };
  if (!data) return { status: 'none' };
  if (data.status === 'revoked') return { status: 'revoked' };
  if (data.status === 'pending') {
    const { error: upErr } = await supabase
      .from('vinyl_invites')
      .update({ status: 'accepted', accepted_at: new Date().toISOString(), user_id: userId })
      .eq('id', data.id);
    if (upErr) return { status: 'error', error: upErr };
    return { status: 'accepted', firstTime: true };
  }
  return { status: 'accepted', firstTime: false };
}

// ── Suggest moods (Multi-User v1 / Step 7b) ──────────────────
// POSTs to /api/suggest-moods with the user's session JWT. The Vercel function
// calls Claude Haiku, validates the response against the user's mood list, and
// caches the result. Returns slugs (matching vinyl_meta.moods array entries).
async function suggestMoods({ release_id, artist, title, year, genres, styles }) {
  if (!release_id) return fail('release_id required');
  try {
    const session = await getSession();
    if (!session || !session.access_token) return fail('not signed in');
    const url = buildApiUrl('suggest-moods');
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        release_id: String(release_id),
        artist: artist || null,
        title: title || '',
        year: year || null,
        genres: genres || [],
        styles: styles || [],
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = json?.error || `HTTP ${res.status}`;
      const out = fail(new Error(msg));
      if (res.status === 429) out.rateLimited = true;
      return out;
    }
    return ok({ data: { moods: json.moods || [], reasoning: json.reasoning || null, cached: !!json.cached } });
  } catch (e) { return fail(e); }
}

// ── Discogs OAuth + proxy (Multi-User v1 / Step 8) ───────────
// startDiscogsOAuth kicks off the OAuth 1.0a handshake. Server returns an
// authorize_url; the browser opens it in a popup. The popup completes the
// flow (server callback exchanges the verifier for access tokens, popup
// page writes them to vinyl_settings using the user's own session) and
// postMessages the opener with { source: 'discogs-oauth', status, username }.
async function startDiscogsOAuth() {
  try {
    const session = await getSession();
    if (!session || !session.access_token) return fail('not signed in');
    const url = buildApiUrl('discogs-oauth/request');
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${session.access_token}` },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return fail(new Error(json?.error || `HTTP ${res.status}`));
    return ok({ authorize_url: json.authorize_url });
  } catch (e) { return fail(e); }
}

// discogsApiCall proxies a Discogs API request through the server, which signs
// it with the user's stored credentials (OAuth or PAT). Returns the raw fetch
// Response so callers can use .ok / .status / .json() the same way they did
// when calling api.discogs.com directly.
async function discogsApiCall(endpoint) {
  const session = await getSession();
  if (!session || !session.access_token) throw new Error('not signed in');
  const url = buildApiUrl('discogs-proxy');
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ endpoint }),
  });
}

// ── Account deletion (Multi-User v1 / Step 9) ────────────────
// Posts to /api/delete-account with the user's JWT. Server runs the
// last-admin guard, writes a final audit event, and calls
// auth.admin.deleteUser via service_role. FK cascade on user_id wipes
// the user's owned rows across 12 tables; vinyl_invites.user_id is
// SET NULL so the invite record is preserved.
async function deleteAccount() {
  try {
    const session = await getSession();
    if (!session || !session.access_token) return fail('not signed in');
    const url = buildApiUrl('delete-account');
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ confirm: 'DELETE' }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const out = fail(new Error(json?.error || `HTTP ${res.status}`));
      out.status = res.status;
      return out;
    }
    return ok({ data: json });
  } catch (e) { return fail(e); }
}

// Mirrors proxyImage's host-aware URL detection so the /api/* path resolves
// the same way (direct on the Vercel preview, prefixed on the hub).
function buildApiUrl(endpoint) {
  const onHub = location.host === 'elbrink.com' || location.host === 'www.elbrink.com';
  if (onHub) {
    const prefix = location.pathname.startsWith('/crate') ? '/crate' : '/vinyl';
    return `${prefix}/api/${endpoint}`;
  }
  return `/api/${endpoint}`;
}

// ── Proxy image URL builder ──────────────────────────────────
// During the InMotion era, images flowed through /vinyl/api.php?action=proxy_image.
// Post-cutover via the elbrink.com hub:
//   /vinyl/api/proxy-image  → vercel.app/api/proxy-image (hub passes :path* through)
//   /crate/api/proxy-image  → vercel.app/share/api/proxy-image → /api/proxy-image
//                             (the share→root rewrite is in this project's vercel.json)
// Direct on the Vercel preview, neither prefix is in use — call /api/proxy-image directly.
function proxyImage(url) {
  if (!url || !url.startsWith('https://i.discogs.com/')) return url;
  const onHub = location.host === 'elbrink.com' || location.host === 'www.elbrink.com';
  if (onHub) {
    const prefix = location.pathname.startsWith('/crate') ? '/crate' : '/vinyl';
    return `${prefix}/api/proxy-image?url=${encodeURIComponent(url)}`;
  }
  return `/api/proxy-image?url=${encodeURIComponent(url)}`;
}

// ── Expose ────────────────────────────────────────────────────

window.crate = {
  supabase,
  // reads
  loadPlays, loadMeta, loadCollection, loadArtists, loadWantlist,
  loadSettings, loadPublicSettings,
  // writes
  saveSetting,
  saveCollection,
  saveMeta, bulkMeta, clearMeta,
  recordPlay, setPlayCount, resetCycle, clearPlays, syncPlays,
  saveArtist, bulkArtists, saveArtistWiki,
  saveWantlist,
  // auth
  signInWithGoogle, signOut, getSession, onAuthChange, checkInvite,
  // moods + profile (v1 / Step 4)
  loadMoods, createMood, updateMood, deleteMood, reorderMoods,
  loadProfile, updateProfile, ensureProfile,
  // share pages (v1.1 / Sprint 1 item 2)
  loadProfileBySlug, setShareEnabled, slugifyCrateName,
  // play events (v1 / Step 5)
  recordPlayEvent, loadRecentPlays,
  // feedback (v1 / Step 6)
  submitFeedback, loadAllFeedback, isAdmin, loadUserEmails,
  // suggest moods (v1 / Step 7b)
  suggestMoods,
  // discogs OAuth + proxy (v1 / Step 8)
  startDiscogsOAuth, discogsApiCall,
  // account deletion (v1 / Step 9)
  deleteAccount,
  // util
  proxyImage,
};

if (typeof window._crateReadyResolve === 'function') {
  window._crateReadyResolve(window.crate);
}
