// Vercel serverless function — Claude Haiku album liner notes generation
//
// POST /api/liner-notes
// Body: { release_id, artist, title, year, genres, styles }
// Header: Authorization: Bearer <supabase_access_token>
//
// Flow: verify session → cache check (vinyl_meta.liner_notes_status='generated')
//   → rate-limit gate (500/day from vinyl_liner_notes_calls)
//   → Anthropic Claude Haiku call with strict JSON schema (6-category enum +
//     per-note confidence float 0-1)
//   → server-side filter notes below 0.7 confidence floor
//   → UPDATE vinyl_meta.liner_notes + status + generated_at
//   → INSERT audit row into vinyl_liner_notes_calls
//   → return notes + status to caller
//
// Status enum (mirrors PRD §13.11 + DB CHECK on vinyl_meta.liner_notes_status):
//   pending        — not yet generated (default)
//   generated      — at least one note above 0.7 confidence floor
//   low_confidence — Claude returned content but everything below threshold
//                    (tab renders placeholder, not generated text)
//   failed         — API error or other generation failure
//
// Reachable at: https://elbrinks-crate.vercel.app/api/liner-notes
// And via the hub rewrite at: https://elbrink.com/vinyl/api/liner-notes

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

export const config = { runtime: 'nodejs' };

const SUPABASE_URL = 'https://cejdraimvieqjopiccpb.supabase.co';
const SUPABASE_KEY = 'sb_publishable_n63_gkGCZwL1DodV18o8kA_sJxUcrly';
const DAILY_LIMIT = 500;
const CONFIDENCE_FLOOR = 0.7;

// Six-category taxonomy enum per PRD §13.7. Enforced via Anthropic JSON
// schema; revalidated server-side as defense-in-depth.
const CATEGORIES = [
  'Recording',
  'History',
  'Catalog',
  'Personnel',
  'Trivia',
  'Cover Art',
];

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

  // 3. Cache check — if this user already has notes for this release with
  // status='generated' or status='low_confidence', return cached. Only
  // 'pending' or 'failed' triggers a fresh Anthropic call.
  const { data: cached } = await supabase
    .from('vinyl_meta')
    .select('liner_notes, liner_notes_status, liner_notes_generated_at')
    .eq('release_id', String(release_id))
    .maybeSingle();

  if (cached && (cached.liner_notes_status === 'generated' ||
                 cached.liner_notes_status === 'low_confidence')) {
    res.status(200).json({
      notes: cached.liner_notes || [],
      status: cached.liner_notes_status,
      generated_at: cached.liner_notes_generated_at,
      cached: true,
    });
    return;
  }

  // 4. Rate limit — count this user's calls in last 24h
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count, error: countError } = await supabase
    .from('vinyl_liner_notes_calls')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', dayAgo);
  if (countError) {
    res.status(500).json({ error: 'Rate limit check failed' });
    return;
  }
  if ((count || 0) >= DAILY_LIMIT) {
    res.setHeader('Retry-After', '3600');
    res.status(429).json({
      error: `Daily liner-notes limit reached (${DAILY_LIMIT}/day). Try again tomorrow.`,
    });
    return;
  }

  // 5. Anthropic call
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
    return;
  }

  const client = new Anthropic({ apiKey });

  // System prompt — voice rules + confidence rule + bad/good examples per
  // PRD §13.8 and §13.9. Crate's flavor lives here per
  // [[feedback-flavor-as-differentiator]] — factual, anchored, restrained.
  const systemPrompt =
`You write short liner notes for vinyl records. Your audience reads liner notes, watches Rick Beato videos, and goes down Wikipedia rabbit holes for production details. Write to that audience.

Pick 2 to 3 of the most interesting categories for this specific record from this fixed list:
- Recording: who, when, where, how (studio, producer, session timing, technical approach)
- History: release context, reception, cultural moment, chart performance, controversy
- Catalog: artist's wider work, sequence in discography, trilogy or series, collaborator threads
- Personnel: notable session players, guest appearances, conducting or arranging credits
- Trivia: lesser-known facts, naming origins, hidden references, sample sources
- Cover Art: artwork, photographer, designer, art direction story, original vs reissue differences

Voice rules:
- Factual. Anchored to specifics. Numbers, names, dates, places.
- 1 to 2 sentences per note. Max 3 sentences. Total 50 to 100 words across all notes.
- No flowery or hyperbolic language.
- No generic praise copy (banned words: influential, groundbreaking, iconic, legendary, seminal, masterpiece).
- No hedging (banned words: perhaps, some say, many consider, widely regarded). If uncertain, omit the note.
- No "did you know" or "fun fact" framing inside note bodies. The format itself signals the genre.
- Write as if you've actually heard the record and know it well.

Confidence rule:
- If you cannot recall specific facts about THIS record with high confidence, return an empty notes array. Better silence than wrong content.
- Return a per-note confidence value (0.0 to 1.0). 0.7 is the published-quality floor. Below 0.5 means you're guessing — return an empty array instead.

Bad example:
"Aja is widely regarded as one of the most influential records of its era, capturing a moment in music history that continues to resonate with listeners today."
This is generic, could apply to any album, has no texture.

Good example:
"Aja was recorded across seven studios in 1976 with 42 session musicians. Becker and Fagen booked players individually, often for a single track."
This is specific, named, anchored to numbers and behavior.

Bad example:
"Many critics consider Kind of Blue to be the greatest jazz album ever made."
Hedged, generic.

Good example:
"Kind of Blue was recorded in two sessions in March and April 1959. Most tracks are first takes. Coltrane and Cannonball Adderley had never heard the modal sketches Davis brought in until the tape was rolling."
Specific, anchored to dates, takes, names.

Respond in JSON only.`;

  const userPrompt =
`Album: ${artist || 'Unknown'} — ${title}${year ? ' (' + year + ')' : ''}
Genres: ${(genres || []).join(', ') || 'unknown'}
Styles: ${(styles || []).join(', ') || 'unknown'}

Write 2 to 3 notes for this record. If you do not have high-confidence knowledge of this specific album, return an empty notes array.`;

  let claudeNotes;
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 600,
      temperature: 0,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              notes: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    category: { type: 'string', enum: CATEGORIES },
                    body: { type: 'string' },
                    confidence: { type: 'number', minimum: 0, maximum: 1 },
                  },
                  required: ['category', 'body', 'confidence'],
                  additionalProperties: false,
                },
              },
            },
            required: ['notes'],
            additionalProperties: false,
          },
        },
      },
    });

    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock) throw new Error('No text block in LLM response');
    const parsed = JSON.parse(textBlock.text);
    if (!Array.isArray(parsed.notes)) throw new Error('LLM response missing notes array');
    // Defensive clip to 3 — prompt asks for 2-3 but Anthropic's JSON schema
    // does not enforce maxItems on arrays, so we clip here.
    claudeNotes = parsed.notes.slice(0, 3);
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) {
      res.setHeader('Retry-After', '60');
      // Log the call as 'failed' so the audit + rate-limit history is honest
      await supabase.from('vinyl_liner_notes_calls').insert({
        release_id: String(release_id), outcome: 'failed', notes_count: 0,
      }).then(() => {}, () => {});
      res.status(429).json({ error: 'Anthropic rate limited, try again shortly' });
      return;
    }
    if (e instanceof Anthropic.AuthenticationError) {
      res.status(500).json({ error: 'Anthropic auth failed — check ANTHROPIC_API_KEY' });
      return;
    }
    console.error('[liner-notes] LLM call failed', e?.message || e);
    // Mark vinyl_meta as failed so the worker retries on next sweep
    await supabase.from('vinyl_meta').update({
      liner_notes_status: 'failed',
      liner_notes_generated_at: new Date().toISOString(),
    }).eq('release_id', String(release_id));
    await supabase.from('vinyl_liner_notes_calls').insert({
      release_id: String(release_id), outcome: 'failed', notes_count: 0,
    }).then(() => {}, () => {});
    res.status(502).json({ error: 'LLM call failed: ' + (e?.message || 'unknown') });
    return;
  }

  // 6. Validate categories server-side (defense-in-depth — should be enum-enforced)
  const categorySet = new Set(CATEGORIES);
  const validShape = claudeNotes.filter(n =>
    n && typeof n.body === 'string' && n.body.trim().length > 0 &&
    typeof n.confidence === 'number' && categorySet.has(n.category)
  );

  // 7. Apply confidence floor — drop notes below 0.7
  const survivors = validShape.filter(n => n.confidence >= CONFIDENCE_FLOOR);

  // 8. Determine outcome
  let outcome, finalNotes;
  if (survivors.length > 0) {
    outcome = 'generated';
    finalNotes = survivors;
  } else {
    // Claude returned content but everything was below the floor — OR
    // Claude returned empty array because it self-rated low confidence.
    // Both land in low_confidence; tab renders placeholder copy per §13.14.
    outcome = 'low_confidence';
    finalNotes = [];
  }

  // 9. Persist to vinyl_meta (cache + status). Best-effort — log errors but
  // still return notes to caller so the user sees the just-generated content
  // even if the cache write blipped.
  const generatedAt = new Date().toISOString();
  const { error: metaError } = await supabase
    .from('vinyl_meta')
    .update({
      liner_notes: finalNotes,
      liner_notes_status: outcome,
      liner_notes_generated_at: generatedAt,
    })
    .eq('release_id', String(release_id));
  if (metaError) {
    console.error('[liner-notes] vinyl_meta update failed', metaError.message);
  }

  // 10. Audit log + rate-limit counter
  const { error: auditError } = await supabase
    .from('vinyl_liner_notes_calls')
    .insert({
      release_id: String(release_id),
      outcome,
      notes_count: finalNotes.length,
    });
  if (auditError) {
    console.error('[liner-notes] audit insert failed', auditError.message);
  }

  res.status(200).json({
    notes: finalNotes,
    status: outcome,
    generated_at: generatedAt,
    cached: false,
  });
}
