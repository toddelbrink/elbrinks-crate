// Vercel serverless function — Claude album liner notes generation
//
// POST /api/liner-notes
// Body: { release_id, artist, title, year, genres, styles }
// Header: Authorization: Bearer <supabase_access_token>
//
// Flow: verify session → cache check (vinyl_meta.liner_notes_status='generated')
//   → rate-limit gate (500/day from vinyl_liner_notes_calls)
//   → Claude Opus 5 with web search (for records it doesn't know) and a strict
//     record_liner_notes tool (6-category enum + confidence 0-1 + source URLs)
//   → server-side selectNotes: confidence floor, self-referential filter,
//     sources limited to URLs that actually came back from search
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

// Web search plus thinking runs well past the old single-shot call: 72s for a
// record that needed three searches, and one timed out at the earlier 120s cap.
export const config = { runtime: 'nodejs', maxDuration: 300 };

const SUPABASE_URL = 'https://cejdraimvieqjopiccpb.supabase.co';
const SUPABASE_KEY = 'sb_publishable_n63_gkGCZwL1DodV18o8kA_sJxUcrly';
const DAILY_LIMIT = 500;
const CONFIDENCE_FLOOR = 0.7;
const MODEL = 'claude-opus-5';
const MAX_SEARCHES = 3;
// pause_turn continuations. Bounds cost if a search turn keeps pausing.
const MAX_TURNS = 4;
// Stop well inside maxDuration so a slow record is written as 'failed' by the
// catch below instead of the platform killing the function mid-request, which
// leaves the row 'pending' and re-bills it on every app open.
const DEADLINE_MS = 250_000;
const MIN_TURN_MS = 45_000;

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

// Web search always returns citations, and citations can't be combined with
// output_config.format, so the notes come back as a strict tool call instead.
const NOTES_TOOL = {
  name: 'record_liner_notes',
  description: 'Submit the finished liner notes for this record. Call it exactly once, after any research. Submit an empty notes array when neither your knowledge nor a search turned up anything specific about this record.',
  strict: true,
  input_schema: {
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
            sources: { type: 'array', items: { type: 'string' } },
          },
          required: ['category', 'body', 'confidence', 'sources'],
          additionalProperties: false,
        },
      },
    },
    required: ['notes'],
    additionalProperties: false,
  },
};

// Notes about the model instead of the record ("The Great Divide does not
// exist in my training data...") once shipped at 0.95 confidence. The prompt
// forbids them; this is the backstop. Quoted lyrics and interview lines are
// stripped first so "I don't know," Kahan said doesn't trip it.
const SELF_REFERENCE = [
  /\b(my|our) (training|knowledge|information|data)\b/i,
  /\btraining (data|cut-?off|set)\b/i,
  /\bknowledge cut-?off\b/i,
  /\b(as an ai|language model)\b/i,
  /\bI (do not|don't|cannot|can't|could not|couldn't|am not|have no|am unable)\b/i,
  /\bnot (aware of|familiar with)\b/i,
  /\bsearch results?\b/i,
];

function isSelfReferential(body) {
  const unquoted = String(body || '').replace(/["\u201c][^"\u201d]*["\u201d]/g, '');
  return SELF_REFERENCE.some(re => re.test(unquoted));
}

// Every URL the search tool returned or cited in this request, walked
// recursively because dynamic filtering nests results under code execution.
function collectSearchUrls(node, out) {
  if (Array.isArray(node)) { node.forEach(n => collectSearchUrls(n, out)); return; }
  if (!node || typeof node !== 'object') return;
  if ((node.type === 'web_search_result' || node.type === 'web_search_result_location') &&
      typeof node.url === 'string') {
    out.add(node.url);
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') collectSearchUrls(v, out);
  }
}

// Validate, filter, and cap what the model submitted. Sources survive only if
// the search tool actually returned them, so a note can't cite a made-up link.
function selectNotes(rawNotes, searchedUrls) {
  const categorySet = new Set(CATEGORIES);
  return (Array.isArray(rawNotes) ? rawNotes : [])
    .filter(n =>
      n && typeof n.body === 'string' && n.body.trim().length > 0 &&
      typeof n.confidence === 'number' && categorySet.has(n.category)
    )
    .map(n => ({
      category: n.category,
      body: n.body.trim(),
      confidence: Math.max(0, Math.min(1, n.confidence)),
      sources: [...new Set((Array.isArray(n.sources) ? n.sources : [])
        .filter(u => typeof u === 'string' && searchedUrls.has(u)))].slice(0, 3),
    }))
    .filter(n => n.confidence >= CONFIDENCE_FLOOR && !isSelfReferential(n.body))
    .slice(0, 3);
}

export default async function handler(req, res) {
  const startedAt = Date.now();
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

Research:
- You have a web_search tool. If you don't have specific knowledge of this exact record (common for recent releases, reissues, and regional pressings), search before writing, up to ${MAX_SEARCHES} searches. Don't search for records you already know well.
- Notes built from search results list the result URLs they rely on in "sources". Notes from your own knowledge use an empty "sources" array.

Every note is about the record. Never write about yourself, your knowledge, your training, or what you could or couldn't find. If you have nothing specific, submit an empty notes array. That is the correct result, and the page shows a placeholder instead.

Your notes will be filtered server-side: notes with confidence below 0.7 are dropped before the user sees them. Score confidence honestly. You do NOT need to self-censor lower-confidence notes. Trust the floor.

Confidence scale:
- 0.9 and up: specific facts you're sure of (recording dates, exact personnel, named facts), from your own knowledge or a reliable source you found
- 0.75 to 0.89: confident on substance, slightly less sure of specific details
- 0.6 to 0.74: reasonably confident but could be off on a detail
- below 0.6: speculation — don't write these notes at all

Return 2 to 3 notes per record. Even one strong note is fine if you only have one. Empty array ONLY if neither your knowledge nor a search turns up anything specific about this record.

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

When you're done, call record_liner_notes exactly once with your notes.`;

  const userPrompt =
`Album: ${artist || 'Unknown'} — ${title}${year ? ' (' + year + ')' : ''}
Genres: ${(genres || []).join(', ') || 'unknown'}
Styles: ${(styles || []).join(', ') || 'unknown'}

Note that the year may be the year of this specific pressing, not the original release year. Use the original release for any date references.

Write 2 to 3 notes for this record with honest confidence scores.`;

  let claudeNotes = null;
  let searchedUrls = new Set();
  let modelStop = null;
  try {
    const messages = [{ role: 'user', content: userPrompt }];
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const remaining = DEADLINE_MS - (Date.now() - startedAt);
      if (remaining < MIN_TURN_MS) throw new Error('liner notes timed out before finishing research');
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        // Declined requests re-run on Anthropic's recommended fallback model
        // instead of coming back as a refusal.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        // Medium is strong on Opus 5 and the main latency lever for a
        // background job; high ran long enough on search-heavy records to time out.
        output_config: { effort: 'medium' },
        system: systemPrompt,
        tools: [
          { type: 'web_search_20260209', name: 'web_search', max_uses: MAX_SEARCHES },
          NOTES_TOOL,
        ],
        messages,
      }, { timeout: remaining, maxRetries: 0 });
      collectSearchUrls(response.content, searchedUrls);
      modelStop = response.stop_reason;
      const call = response.content.find(b => b.type === 'tool_use' && b.name === NOTES_TOOL.name);
      if (call) { claudeNotes = call.input?.notes || []; break; }
      if (response.stop_reason !== 'pause_turn') break;
      // A long search turn paused server-side; send it back unchanged to resume.
      messages.push({ role: 'assistant', content: response.content });
    }
    // Finished (or refused) without submitting: nothing to say about this
    // record. Truncated or still paused after MAX_TURNS: a real failure, retry later.
    if (claudeNotes === null) {
      if (modelStop === 'end_turn' || modelStop === 'refusal') claudeNotes = [];
      else throw new Error(`no liner notes submitted (stop_reason: ${modelStop})`);
    }
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

  // 6. Validate shape, clamp confidence, drop notes below the 0.7 floor or
  // about the model itself, and keep only sources the search actually returned.
  const survivors = selectNotes(claudeNotes, searchedUrls);

  // 7. Determine outcome
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

  // 8. Persist to vinyl_meta (cache + status). Best-effort — log errors but
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

  // 9. Audit log + rate-limit counter
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
