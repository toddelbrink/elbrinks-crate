// Vercel serverless function — §12 cycle recap: stats plus Claude's bridges.
//
// POST /api/cycle-recap
// Body: { cycle_number }  or  { closing: true }
// Header: Authorization: Bearer <supabase_access_token>
//
// A saved cycle's row comes from one of two places. { closing: true } is sent
// the moment the last unplayed record is played: it creates the row for the
// cycle that just finished (or finds it), because the recap shows before the
// listener resets. Otherwise the database creates it at reset (trigger
// save_closing_cycle), which also recognizes a row already created here and
// leaves it alone. Either way this function finishes the row, once, and every
// later call reads what it stored:
//   1. recap_data pending  -> compute from play events (lib/recap.js), store.
//   2. bridges null        -> one Claude call writes a short line per slide, store.
//   3. return recap_data + bridges (never the share image bytes).
// If Claude fails, the stats still come back with bridges null and the next
// open tries again (§12.13): the recap is never blocked on the API.
//
// Reachable at: https://elbrinks-crate.vercel.app/api/cycle-recap
// And via the hub rewrite at: https://elbrink.com/vinyl/api/cycle-recap

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { computeRecap, recapSlides, SYSTEM_PROMPT, bridgeSchema, bridgePrompt, RECAP_VERSION } from '../lib/recap.js';

// One Claude call at medium effort; 120 s is generous headroom.
export const config = { runtime: 'nodejs', maxDuration: 120 };

const SUPABASE_URL = 'https://cejdraimvieqjopiccpb.supabase.co';
const SUPABASE_KEY = 'sb_publishable_n63_gkGCZwL1DodV18o8kA_sJxUcrly';
const MODEL = 'claude-opus-5-5';

async function writeBridges(recap) {
  const slides = recapSlides(recap);
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    // Declined requests re-run on Anthropic's recommended fallback model.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema: bridgeSchema(slides) },
    },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: bridgePrompt(recap, slides) }],
  }, { timeout: 55000, maxRetries: 1 });   // two tries fit inside maxDuration
  if (response.stop_reason === 'refusal') throw new Error('declined');
  const text = response.content.find((b) => b.type === 'text');
  if (!text) throw new Error(`no text (stop_reason: ${response.stop_reason})`);
  const parsed = JSON.parse(text.text);
  // Defense in depth: keep only the requested slides, as trimmed strings.
  const out = {};
  for (const s of slides) {
    if (typeof parsed[s] !== 'string' || !parsed[s].trim()) throw new Error(`missing bridge: ${s}`);
    out[s] = parsed[s].trim();
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!jwt) { res.status(401).json({ error: 'Missing auth token' }); return; }
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) { res.status(401).json({ error: 'Invalid session' }); return; }
  const userId = userData.user.id;

  const body = req.body || {};
  let n = Number(body.cycle_number);
  if (body.closing === true) {
    // The cycle that just finished: from the current boundary (or the first
    // play, for a first cycle) to the last play.
    const [{ data: prof, error: pErr }, { data: lastRows, error: lErr }, { data: top, error: tErr }] = await Promise.all([
      supabase.from('vinyl_user_profile').select('cycle_started_at').eq('user_id', userId).maybeSingle(),
      supabase.from('vinyl_play_events').select('played_at').eq('user_id', userId).order('played_at', { ascending: false }).limit(1),
      supabase.from('vinyl_cycle_recaps').select('cycle_number, start_date').order('cycle_number', { ascending: false }).limit(1),
    ]);
    if (pErr || lErr || tErr) { res.status(500).json({ error: 'Could not load the cycle' }); return; }
    let start = prof && prof.cycle_started_at;
    if (!start) {
      const { data: firstRows } = await supabase.from('vinyl_play_events').select('played_at')
        .eq('user_id', userId).order('played_at', { ascending: true }).limit(1);
      start = firstRows && firstRows[0] && firstRows[0].played_at;
    }
    const end = lastRows && lastRows[0] && lastRows[0].played_at;
    if (!start || !end) { res.status(404).json({ error: 'No plays in this cycle' }); return; }
    const latest = top && top[0];
    if (latest && Date.parse(latest.start_date) === Date.parse(start)) {
      n = latest.cycle_number;                       // already saved, reuse it
    } else {
      n = (latest ? latest.cycle_number : 0) + 1;
      const { count } = await supabase.from('vinyl_play_events').select('id', { count: 'exact', head: true })
        .eq('user_id', userId).gte('played_at', start).lte('played_at', end);
      const { error: insErr } = await supabase.from('vinyl_cycle_recaps').insert({
        user_id: userId, cycle_number: n, start_date: start, end_date: end, total_plays: count || 0,
        recap_data: { status: 'pending', saved_at: new Date().toISOString() },
      });
      if (insErr && insErr.code !== '23505') { res.status(500).json({ error: 'Could not save the cycle' }); return; }
    }
  }
  if (!Number.isInteger(n) || n < 1) { res.status(400).json({ error: 'cycle_number or closing required' }); return; }

  const { data: row, error: rowErr } = await supabase
    .from('vinyl_cycle_recaps')
    .select('cycle_number, start_date, end_date, total_plays, recap_data, bridges, created_at')
    .eq('cycle_number', n)
    .maybeSingle();
  if (rowErr) { res.status(500).json({ error: 'Could not load the cycle' }); return; }
  if (!row) { res.status(404).json({ error: 'No saved cycle with that number' }); return; }

  // 1. Stats, once per RECAP_VERSION. They come only from stored plays, so a
  // recompute after a version bump gives the same facts in the new shape; the
  // stored bridges are kept.
  let recap = row.recap_data;
  if (!recap || recap.status === 'pending' || (recap.version || 0) < RECAP_VERSION) {
    const [ev, prior, coll, meta, moods, prev] = await Promise.all([
      supabase.from('vinyl_play_events').select('release_id, played_at, mood_active')
        .eq('user_id', userId).gte('played_at', row.start_date).lte('played_at', row.end_date),
      supabase.from('vinyl_play_events').select('release_id, played_at')
        .eq('user_id', userId).lt('played_at', row.start_date),
      supabase.from('vinyl_collection').select('release_id, data').eq('user_id', userId),
      supabase.from('vinyl_meta').select('release_id, art_url').eq('user_id', userId),
      supabase.from('vinyl_user_moods').select('slug, mood_name'),
      n > 1
        ? supabase.from('vinyl_cycle_recaps').select('recap_data').eq('cycle_number', n - 1).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    const failed = [ev, prior, coll, meta, moods, prev].find((r) => r.error);
    if (failed) { res.status(500).json({ error: 'Could not load the cycle data' }); return; }

    const records = {};
    for (const c of coll.data || []) {
      const d = c.data || {};
      records[String(c.release_id)] = { title: (d.title || '').trim(), artist: d.artist || '', art: d.coverImage || d.thumb || null };
    }
    const art = {};
    for (const m of meta.data || []) if (m.art_url) art[String(m.release_id)] = m.art_url;
    const moodNames = Object.fromEntries((moods.data || []).map((m) => [m.slug, m.mood_name]));
    const previous = prev.data && prev.data.recap_data && prev.data.recap_data.status !== 'pending' ? prev.data.recap_data : null;

    recap = computeRecap({
      cycleNumber: n, start: row.start_date, end: row.end_date,
      events: ev.data || [], priorEvents: prior.data || [],
      records, art, moodNames, previous,
    });
    const { error: upErr } = await supabase.from('vinyl_cycle_recaps')
      .update({ recap_data: recap }).eq('cycle_number', n);
    if (upErr) console.error('[cycle-recap] recap_data save failed', upErr.message);
  }

  // 2. Bridges, once. A failure returns the stats without them.
  let bridges = row.bridges || null;
  let bridgesError = null;
  if (!bridges) {
    if (!process.env.ANTHROPIC_API_KEY) {
      bridgesError = 'ANTHROPIC_API_KEY not configured';
    } else {
      try {
        bridges = await writeBridges(recap);
        const { error: bErr } = await supabase.from('vinyl_cycle_recaps')
          .update({ bridges }).eq('cycle_number', n);
        if (bErr) console.error('[cycle-recap] bridges save failed', bErr.message);
      } catch (e) {
        bridgesError = e?.message || 'unknown';
        console.error('[cycle-recap] bridges failed', bridgesError);
        bridges = null;
      }
    }
  }

  res.status(200).json({
    cycle_number: n,
    recap,
    slides: recapSlides(recap),
    bridges,
    bridges_error: bridgesError,
  });
}
