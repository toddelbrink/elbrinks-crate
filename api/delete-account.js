// Vercel serverless function — account deletion
//
// POST /api/delete-account
// Header: Authorization: Bearer <supabase_access_token>
// Body: { confirm: 'DELETE' }
//
// Flow:
//   1. Verify caller's session via JWT (RLS-scoped client).
//   2. Last-admin guard: if caller is is_admin and they're the only admin,
//      refuse with 403. Counted via service-role (authenticated role
//      cannot read auth.users — see supabase_patterns.md §2).
//   3. Write final 'account_deleted' event into vinyl_events for audit.
//   4. Service-role auth.admin.deleteUser(user.id) — FK cascade on user_id
//      handles all owned rows (12 tables). vinyl_invites.user_id is
//      SET NULL so the invite row is preserved.
//
// Reachable at: https://elbrinks-crate.vercel.app/api/delete-account
// And via hub rewrite: https://elbrink.com/vinyl/api/delete-account

import { createClient } from '@supabase/supabase-js';
import { getSupabaseForRequest } from '../lib/discogs-oauth-helpers.js';

export const config = { runtime: 'nodejs' };

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cejdraimvieqjopiccpb.supabase.co';
const SUPABASE_KEY = 'sb_publishable_n63_gkGCZwL1DodV18o8kA_sJxUcrly';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // 1. JWT-scoped client → verify caller is a real signed-in user
  const { supabase, user, error: authError } = await getSupabaseForRequest(
    req, createClient, SUPABASE_URL, SUPABASE_KEY
  );
  if (authError || !user) {
    res.status(401).json({ error: authError || 'Not authenticated' });
    return;
  }

  // Belt-and-suspenders: require an explicit confirm token in the body so
  // a stray POST to this endpoint can't nuke an account. UI also gates
  // this on the "type DELETE" input.
  const body = req.body || {};
  if (body.confirm !== 'DELETE') {
    res.status(400).json({ error: 'Confirmation token missing or incorrect' });
    return;
  }

  // 2. Service-role client for admin operations (auth.users reads + deleteUser)
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SERVICE_ROLE_KEY) {
    res.status(500).json({ error: 'Server not configured' });
    return;
  }
  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 3. Last-admin guard. If caller is admin, count other admins. Refuse if zero.
  const isAdmin = user.app_metadata?.is_admin === true;
  if (isAdmin) {
    const { count, error: countError } = await adminClient
      .schema('auth')
      .from('users')
      .select('id', { count: 'exact', head: true })
      .contains('raw_app_meta_data', { is_admin: true });
    if (countError) {
      res.status(500).json({ error: 'Admin count check failed: ' + countError.message });
      return;
    }
    if ((count || 0) <= 1) {
      res.status(403).json({
        error: 'Cannot delete the only admin account. Create or promote another admin first.',
      });
      return;
    }
  }

  // 4. Final telemetry event before deletion. Uses the user's own JWT so RLS
  //    accepts it (and so the event is correctly stamped as the user's).
  //    Best-effort — don't block deletion on this failing.
  try {
    await supabase.from('vinyl_events').insert({
      event_type: 'account_deleted',
      payload: { email: user.email || null },
    });
  } catch (e) {
    console.error('[delete-account] telemetry write failed', e?.message);
  }

  // 5. Delete the auth.users row. FK cascade on user_id handles all owned
  //    rows across 12 tables; vinyl_invites.user_id is SET NULL (preserves
  //    invite record).
  const { error: deleteError } = await adminClient.auth.admin.deleteUser(user.id);
  if (deleteError) {
    res.status(500).json({ error: deleteError.message || 'Deletion failed' });
    return;
  }

  res.status(200).json({ success: true });
}
