// Vercel serverless function — Claude Haiku mood suggestions
//
// POST /api/suggest-moods
// Body: { release_id, artist, title, year, genres, styles }
// Header: Authorization: Bearer <supabase_access_token>
//
// Flow: verify session → load user moods → cache hit? → rate-limit gate (500/day)
//   → call Anthropic Claude Haiku 4.5 with strict JSON schema → validate moods
//   against the user's available set → cache + return.
//
// Reachable at: https://elbrinks-crate.vercel.app/api/suggest-moods
// And via the hub rewrite at: https://elbrink.com/vinyl/api/suggest-moods

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

export const config = { runtime: 'nodejs' };

const SUPABASE_URL = 'https://cejdraimvieqjopiccpb.supabase.co';
const SUPABASE_KEY = 'sb_publishable_n63_gkGCZwL1DodV18o8kA_sJxUcrly';
const DAILY_LIMIT = 500;

// djb2 hash, returned as 8-char hex. Stable across runs, fine for cache keys.
function hashMoods(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) + str.charCodeAt(i);
    h = h | 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // 1. Auth — extract JWT from Authorization header
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!jwt) {
    res.status(401).json({ error: 'Missing auth token' });
    return;
  }

  // Supabase client scoped to this user via JWT (RLS enforced)
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    res.status(401).json({ error: 'Invalid session' });
    return;
  }

  // 2. Validate body
  const body = req.body || {};
  const { release_id, artist, title, year, genres, styles } = body;
  if (!release_id || !title) {
    res.status(400).json({ error: 'release_id and title required' });
    return;
  }

  // 3. Load user's moods (description + keywords feed the prompt per v1.1 §9.3)
  const { data: moods, error: moodsError } = await supabase
    .from('vinyl_user_moods')
    .select('slug, mood_name, description, keywords')
    .order('sort_order', { ascending: true });
  if (moodsError) {
    res.status(500).json({ error: 'Failed to load user moods' });
    return;
  }
  if (!moods?.length) {
    res.status(400).json({ error: 'No moods configured for this user' });
    return;
  }

  const availableNames = moods.map(m => m.mood_name);
  const nameToSlug = Object.fromEntries(moods.map(m => [m.mood_name, m.slug]));
  // Hash includes description + keywords so cache invalidates when the user
  // edits either — otherwise stale suggestions persist across mood-edits.
  const moodKey = moods.map(m =>
    `${m.slug}:${m.mood_name}:${m.description || ''}:${(m.keywords || []).join(',')}`
  ).sort().join('|');
  const user_moods_hash = hashMoods(moodKey);

  // 4. Cache check
  const { data: cached } = await supabase
    .from('vinyl_mood_suggestions')
    .select('suggested_moods, reasoning, created_at')
    .eq('release_id', String(release_id))
    .eq('user_moods_hash', user_moods_hash)
    .maybeSingle();

  if (cached) {
    res.status(200).json({
      moods: cached.suggested_moods || [],
      reasoning: cached.reasoning || null,
      cached: true,
    });
    return;
  }

  // 5. Rate limit (DAILY_LIMIT calls / 24h per user; cache hits don't count)
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count, error: countError } = await supabase
    .from('vinyl_mood_suggestions')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', dayAgo);
  if (countError) {
    res.status(500).json({ error: 'Rate limit check failed' });
    return;
  }
  if ((count || 0) >= DAILY_LIMIT) {
    res.setHeader('Retry-After', '3600');
    res.status(429).json({
      error: `Daily suggest limit reached (${DAILY_LIMIT}/day). Try again tomorrow.`,
    });
    return;
  }

  // 6. Anthropic call
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
    return;
  }

  const client = new Anthropic({ apiKey });

  const systemPrompt =
    'You assign moods to vinyl records based on metadata. Pick 1-3 moods from the user\'s available list that best fit the album. ' +
    'Each mood has a name, an optional description, and optional keywords. ' +
    'When a description is present, treat it as the user\'s own explanation of what the mood means to them — trust it as the authority on intent over your interpretation of the bare label. ' +
    'Keywords are sample genres or styles the user associates with the mood; treat them as hints, not requirements. ' +
    'Only use moods from the provided list — never invent new ones. Respond in JSON only.';

  const moodBlocks = moods.map(m => {
    const lines = [`- Mood name: "${m.mood_name}"`];
    if (m.description) lines.push(`  Description: "${m.description}"`);
    if (Array.isArray(m.keywords) && m.keywords.length) lines.push(`  Keywords: ${m.keywords.join(', ')}`);
    return lines.join('\n');
  }).join('\n');

  const userPrompt =
    `Album: ${artist || 'Unknown'} — ${title}${year ? ' (' + year + ')' : ''}\n` +
    `Genres: ${(genres || []).join(', ') || 'unknown'}\n` +
    `Styles: ${(styles || []).join(', ') || 'unknown'}\n\n` +
    `Available moods:\n${moodBlocks}\n\n` +
    `Pick 1-3 moods that best fit this album.`;

  let suggestedNames;
  let reasoning = null;
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 256,
      temperature: 0,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              moods: {
                type: 'array',
                items: { type: 'string', enum: availableNames },
                description: '1-3 moods from the available list',
              },
              reasoning: {
                type: 'string',
                description: 'One short sentence on the choice',
              },
            },
            required: ['moods'],
            additionalProperties: false,
          },
        },
      },
    });

    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock) throw new Error('No text block in LLM response');
    const parsed = JSON.parse(textBlock.text);
    if (!Array.isArray(parsed.moods)) throw new Error('LLM response missing moods array');
    suggestedNames = parsed.moods;
    reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : null;
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) {
      res.setHeader('Retry-After', '60');
      res.status(429).json({ error: 'Anthropic rate limited, try again shortly' });
      return;
    }
    if (e instanceof Anthropic.AuthenticationError) {
      res.status(500).json({ error: 'Anthropic auth failed — check ANTHROPIC_API_KEY' });
      return;
    }
    console.error('[suggest-moods] LLM call failed', e?.message || e);
    res.status(502).json({ error: 'LLM call failed: ' + (e?.message || 'unknown') });
    return;
  }

  // 7. Validate + convert names back to slugs (the client uses slugs)
  const availableSet = new Set(availableNames);
  const validNames = suggestedNames.filter(n => availableSet.has(n));
  if (!validNames.length) {
    res.status(502).json({ error: 'LLM returned no valid moods from the available list' });
    return;
  }
  const slugs = validNames.map(n => nameToSlug[n]).filter(Boolean);

  // 8. Cache (best-effort — log failures, don't block the response)
  const { error: cacheError } = await supabase
    .from('vinyl_mood_suggestions')
    .insert({
      release_id: String(release_id),
      user_moods_hash,
      suggested_moods: slugs,
      reasoning,
    });
  if (cacheError) {
    console.error('[suggest-moods] cache insert failed', cacheError.message);
  }

  res.status(200).json({ moods: slugs, reasoning, cached: false });
}
