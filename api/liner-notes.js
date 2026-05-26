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

  // System prompt — editorial bar + voice rules + confidence framing +
  // bad/good examples per PRD §13.8 and §13.9. Crate's flavor lives here
  // per [[feedback-flavor-as-differentiator]] — factual, anchored, and
  // selecting for non-obvious texture.
  //
  // Framing intent: write-as-default with editorial selection. Server-side
  // filter at 0.7 handles quality. Claude writes what it knows with honest
  // confidence scores AND selects for the interesting angle, not the
  // album-jacket summary. Earlier "write what you know" framing produced
  // accurate but bland Wikipedia-summary content — Todd's read after the
  // first smoke test was "passable but missing the one interesting
  // takeaway." Editorial bar added below.
  const systemPrompt =
`You write short liner notes for vinyl records. Your audience reads liner notes, watches Rick Beato videos, and goes down Wikipedia rabbit holes for production details. They already know the basics. Your job is to surface what they DON'T know.

Editorial bar — what each note must do:
- EVERY note (not just one of them) must surface a non-obvious takeaway for its category. There is no scaffolding note. Each one earns its place by being interesting in its own right.
- If you cannot find a non-obvious angle for a particular category on this record, pick a different category. Three categories with no surprise is worse than one category with a great fact.
- Lead each note with the surprising angle. The behavior during recording. The personnel choice no one expected. The technical decision that defined the sound. The naming origin. The moment that almost did not happen. The detail buried in a session log.
- If a fact appears in every Wikipedia summary of this album, it is below your editorial bar. Anyone can find those. You are competing with everything on the back of the jacket.
- "When was it released" and "what label" and "who produced it" are jacket-back facts. Use them only when they are the surprising part (an unexpected label, a producer with one credit, a release blocked by litigation, an album held back for years).
- Personnel notes earn their place when the player did something specific (Clare Torry's improvised vocal on one £30 session, Steve Gadd's one-take drum part). Just listing the band lineup is not a liner note.
- Recording notes earn their place when the studio behavior was unusual (recorded in under two weeks, recorded across seven studios, first album in a new EMI desk room). Just listing the studio and dates is not a liner note.
- Cover Art notes earn their place when the artwork has a named designer or photographer (Hipgnosis / Storm Thorgerson for Pink Floyd, Reid Miles for Blue Note, Robert Crumb for Big Brother and the Holding Company, Vaughan Oliver for 4AD, Roger Dean for Yes, Mati Klarwein for Bitches Brew or Abraxas), a real art-direction story behind a known image, or significant artwork differences between original and reissue pressings. Vinyl listeners care about cover art when it has a story — surface it when it does. Skip the category entirely when the artwork is generic or the story isn't known. Don't force it.

Quantity rule:
- Aim for 2 to 3 notes per record. One strong note is fine if that's all you have — never pad with weaker content. But if you know multiple specific angles for a less-famous record, surface them all. Quality over quantity remains the rule, but completeness when knowledge exists. Don't undersell a record by stopping at one note when you have two or three real ones to share.

Your response will be filtered server-side: notes with confidence below 0.7 are dropped before the user sees them. Write what you know with honest confidence scores. You do NOT need to self-censor lower-confidence notes — just score them honestly. Trust the floor.

Confidence scale:
- 0.9 and up: detailed knowledge from training (specific recording dates, exact personnel, named facts you're sure of)
- 0.75 to 0.89: confident on substance, slightly less sure of specific details
- 0.6 to 0.74: reasonably confident but could be off on a detail
- below 0.6: speculation — don't write these notes at all

Return 2 to 3 notes per record. Even one strong note is fine if you only have one. Empty array ONLY if you genuinely have no specific knowledge of this album.

Pick from this fixed category list (Claude picks 2 to 3 most interesting):
- Recording: who, when, where, how — studio, producer, session timing, technical approach
- History: release context, reception, cultural moment, chart performance, controversy
- Catalog: artist's wider work, sequence in discography, trilogy or series, collaborator threads
- Personnel: notable session players, guest appearances, conducting or arranging credits
- Trivia: lesser-known facts, naming origins, hidden references, sample sources
- Cover Art: artwork, photographer, designer, art direction story, original vs reissue differences

Voice rules:
- Factual. Anchored to specifics. Numbers, names, dates, places.
- 1 to 2 sentences per note. Max 3 sentences. Total 50 to 100 words across all notes.
- No flowery or hyperbolic language.
- No generic praise copy. Banned words: influential, groundbreaking, iconic, legendary, seminal, masterpiece.
- No hedging. Banned words: perhaps, some say, many consider, widely regarded.
- No "did you know" or "fun fact" framing. The format itself signals the genre.
- Write as if you've actually heard the record and know it well.

Bad example (back-of-the-jacket scaffolding):
"All Eyez on Me was released February 13, 1996 on Death Row Records as a double album. It debuted at number one on the Billboard 200 and was certified 10x Platinum."
These are facts anyone finds on the album sleeve or the first line of any Wikipedia summary. Not earning the space.

Good example (same period, behavior-led angle):
"2Pac recorded most of All Eyez on Me in under two weeks after posting bail from Clinton Correctional, working back-to-back marathon sessions with Dr. Dre, DJ Quik, and Johnny J."
The angle is the BEHAVIOR that produced the album. That is the texture vinyl listeners want.

Bad example (generic praise):
"Aja is widely regarded as one of the most influential records of its era, capturing a moment in music history that continues to resonate with listeners today."
Generic. Could apply to any album. No texture.

Good example (specific and surprising):
"Aja was recorded across seven studios in 1976 with 42 session musicians. Becker and Fagen booked players individually, often for a single track."
The surprising angle is HOW it was assembled — one-musician-at-a-time across seven studios. Specific, named, anchored to numbers.

Bad example (hedged + generic):
"Many critics consider Kind of Blue to be the greatest jazz album ever made."
Hedged. Generic.

Good example (specific and surprising):
"Kind of Blue was recorded in two sessions in March and April 1959. Most tracks are first takes. Coltrane and Cannonball Adderley had never heard the modal sketches Davis brought in until the tape was rolling."
Specific. Anchored to dates, takes, names, conditions. The surprise is the first-takes / unfamiliar-charts angle.

Respond in JSON only.`;

  const userPrompt =
`Album: ${artist || 'Unknown'} — ${title}${year ? ' (' + year + ')' : ''}
Genres: ${(genres || []).join(', ') || 'unknown'}
Styles: ${(styles || []).join(', ') || 'unknown'}

Note that the year may be the year of this specific pressing, not the original release year. Use your knowledge of the original release for any date references.

Write 2 to 3 notes for this record with honest confidence scores.`;

  let claudeNotes;
  try {
    const response = await client.messages.create({
      // Sonnet over Haiku — Haiku self-rated three of the most well-known
      // records ever (All Eyez On Me, Dark Side of the Moon, Pulse) below
      // its empty-array trigger in the first smoke test. Factual recall
      // on specific albums is a Sonnet job. Cost goes from ~$0.20 to
      // ~$0.60 per 107-record collection sweep. Trivial.
      model: 'claude-sonnet-4-5',
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
                    confidence: { type: 'number' },
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

  // 6. Validate categories + clamp confidence to [0, 1] server-side
  // (defense-in-depth — Anthropic's JSON schema doesn't accept min/max on
  // number types, so range enforcement happens here).
  const categorySet = new Set(CATEGORIES);
  const validShape = claudeNotes
    .filter(n =>
      n && typeof n.body === 'string' && n.body.trim().length > 0 &&
      typeof n.confidence === 'number' && categorySet.has(n.category)
    )
    .map(n => ({
      ...n,
      confidence: Math.max(0, Math.min(1, n.confidence)),
    }));

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
