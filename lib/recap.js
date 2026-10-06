// §12 step 4: the cycle recap, computed from play events.
//
// Pure: no database, no network. api/cycle-recap.js loads the rows and calls
// computeRecap; test/cycle-recap.test.mjs runs it against fixtures. The result
// is stored as vinyl_cycle_recaps.recap_data and read back on every replay, so
// what a cycle "was" is frozen at the moment it is first opened.
//
// Slides (specs/v1_1.md §12.6) and what feeds them:
//   scale            days and plays, plus the months it ran
//   closer           the last record played in the cycle
//   most_played      the record played most often (ties: the more recent)
//   mood_mix         mood tags across the cycle's plays; a multi-mood play
//                    adds a tag to each mood, and share is of all tags, so
//                    the shares total 100% (v2; v1 used share of plays, which
//                    summed past 100% and read as broken on a chart)
//   returning        cycle 2+: records whose previous play was 6+ months
//                    before their first play this cycle (needs history)
//   cycle_over_cycle cycle 2+: deltas against the previous saved cycle
//
// The last two are null when the data does not exist, and the recap skips a
// null slide rather than showing a placeholder (§12.7).

const DAY = 86400000;
// Bump when the stats change shape or meaning. api/cycle-recap.js recomputes
// stored stats older than this and keeps the stored bridges.
export const RECAP_VERSION = 3;
const RETURN_GAP_DAYS = 182;
const MOSAIC_MIN = 9;    // 3x3
const MOSAIC_MAX = 40;   // spec §12.9 cap; the grid itself tops out at 6x6
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

function recordOf(id, records, art) {
  const r = records[id] || {};
  return { release_id: String(id), title: r.title || 'Unknown record', artist: r.artist || 'Unknown artist', art: art[id] || r.art || null };
}

/**
 * @param {object} p
 * @param {number} p.cycleNumber
 * @param {string} p.start           ISO, the cycle's start boundary
 * @param {string} p.end             ISO, the cycle's last play
 * @param {Array<{release_id:string, played_at:string, mood_active?:string[]|null}>} p.events   this cycle
 * @param {Array<{release_id:string, played_at:string}>} [p.priorEvents]   every play before p.start
 * @param {Object<string,{title:string, artist:string}>} p.records   release_id -> record
 * @param {Object<string,string>} [p.art]            release_id -> cover url
 * @param {Object<string,string>} [p.moodNames]      slug -> display name
 * @param {object|null} [p.previous]                 previous cycle's recap_data, if saved
 */
export function computeRecap(p) {
  const events = [...(p.events || [])].sort((a, b) => Date.parse(a.played_at) - Date.parse(b.played_at));
  const records = p.records || {};
  const art = p.art || {};
  const moodNames = p.moodNames || {};
  const startMs = Date.parse(p.start);
  const endMs = Date.parse(p.end);
  const days = Math.max(1, Math.ceil((endMs - startMs) / DAY));

  // Plays per record, and each record's last play this cycle (for tie-breaks).
  const count = {}, last = {}, first = {};
  for (const e of events) {
    const id = String(e.release_id);
    count[id] = (count[id] || 0) + 1;
    last[id] = Date.parse(e.played_at);
    if (!(id in first)) first[id] = Date.parse(e.played_at);
  }

  const closerEvent = events[events.length - 1] || null;
  const closer = closerEvent ? recordOf(closerEvent.release_id, records, art) : null;

  let topId = null;
  for (const id of Object.keys(count)) {
    if (topId === null || count[id] > count[topId] || (count[id] === count[topId] && last[id] > last[topId])) topId = id;
  }
  const most_played = topId ? { ...recordOf(topId, records, art), play_count: count[topId] } : null;

  const moodCount = {};
  let moodTags = 0;
  for (const e of events) {
    const m = Array.isArray(e.mood_active) ? e.mood_active.filter(Boolean) : [];
    for (const slug of m) { moodCount[slug] = (moodCount[slug] || 0) + 1; moodTags++; }
  }
  const mood_mix = Object.entries(moodCount)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([slug, n]) => ({ slug, name: moodNames[slug] || slug, count: n, share: moodTags ? n / moodTags : 0 }));

  // Returning records: only meaningful with history from before this cycle.
  let returning = null;
  if (p.cycleNumber > 1 && p.priorEvents && p.priorEvents.length) {
    const prevLast = {};
    for (const e of p.priorEvents) {
      const t = Date.parse(e.played_at), id = String(e.release_id);
      if (!(id in prevLast) || t > prevLast[id]) prevLast[id] = t;
    }
    const back = Object.keys(first)
      .filter((id) => id in prevLast && first[id] - prevLast[id] >= RETURN_GAP_DAYS * DAY)
      .sort((a, b) => (first[a] - prevLast[a]) - (first[b] - prevLast[b])).reverse()
      .slice(0, 3)
      .map((id) => ({ ...recordOf(id, records, art), gap_days: Math.round((first[id] - prevLast[id]) / DAY) }));
    returning = back.length ? back : null;
  }

  // Cycle over cycle: only against a saved previous recap.
  let cycle_over_cycle = null;
  const prev = p.previous;
  if (p.cycleNumber > 1 && prev && typeof prev === 'object' && prev.days && prev.plays) {
    const prevTop = prev.mood_mix && prev.mood_mix[0];
    const nowTop = mood_mix[0];
    cycle_over_cycle = {
      previous_cycle: p.cycleNumber - 1,
      days: { before: prev.days, now: days },
      plays: { before: prev.plays, now: events.length },
      top_mood: { before: prevTop ? prevTop.name : null, now: nowTop ? nowTop.name : null },
      most_played: { before: prev.most_played ? prev.most_played.title : null, now: most_played ? most_played.title : null },
    };
  }

  // Records played twice or more, heaviest first: the share mosaic (§12.9).
  const tile = (id) => ({ release_id: id, play_count: count[id], art: art[id] || (records[id] && records[id].art) || null });
  const repeats = Object.keys(count)
    .filter((id) => count[id] >= 2)
    .sort((a, b) => count[b] - count[a] || last[b] - last[a])
    .slice(0, MOSAIC_MAX)
    .map(tile);

  // The share mosaic: a full square grid, 3x3 up to 6x6. Repeats lead, as the
  // spec asks. When fewer than 9 records came back for a second play (Todd's
  // Cycle 2 had 3), the most recent plays fill the grid, newest first,
  // without repeating a cover (Todd, 2026-10-06). Only records with a cover
  // count, since an empty tile reads as a broken image.
  const withArt = (t) => !!t.art;
  const pool = repeats.filter(withArt);
  if (pool.length < MOSAIC_MIN) {
    const seen = new Set(pool.map((t) => t.release_id));
    for (const e of [...events].reverse()) {
      const id = String(e.release_id);
      if (seen.has(id)) continue;
      seen.add(id);
      const t = tile(id);
      if (withArt(t)) pool.push(t);
      if (pool.length >= MOSAIC_MIN) break;
    }
  }
  // Fewer than 9 covers in the whole cycle: one cover, full frame (§12.14).
  const side = [6, 5, 4, 3].find((n) => pool.length >= n * n) || (pool.length ? 1 : 0);
  const mosaic = {
    grid: side,
    filled_from_recent: pool.length > 0 && repeats.filter(withArt).length < MOSAIC_MIN,
    tiles: pool.slice(0, side * side),
  };

  const startDate = new Date(startMs), endDate = new Date(endMs);
  return {
    version: RECAP_VERSION,
    cycle_number: p.cycleNumber,
    days,
    plays: events.length,
    records_played: Object.keys(count).length,
    started: { iso: p.start, month: MONTHS[startDate.getUTCMonth()], year: startDate.getUTCFullYear() },
    ended: { iso: p.end, month: MONTHS[endDate.getUTCMonth()], year: endDate.getUTCFullYear() },
    closer,
    most_played,
    mood_mix,
    returning,
    cycle_over_cycle,
    repeats,
    mosaic,
  };
}

/** The slides a recap shows, in order. Null data means the slide is skipped. */
export function recapSlides(recap) {
  const s = ['scale'];
  if (recap.closer) s.push('closer');
  if (recap.most_played) s.push('most_played');
  if (recap.mood_mix && recap.mood_mix.length) s.push('mood_mix');
  if (recap.returning) s.push('returning');
  if (recap.cycle_over_cycle) s.push('cycle_over_cycle');
  return s;
}

// ── §12 step 5: what Claude is asked to write ─────────────────
// Kept here, pure, so the prompt can be tested without the SDK.

// What each slide's bridge is about. The model sees only the slides this
// recap actually has.
const SLIDE_BRIEF = {
  scale: 'How long the cycle ran and when, framed by season or month. Example: "You started this cycle in November. You closed it in May."',
  closer: 'The record that closed the cycle, and its character as a closer. Example: "Quiet finish. The kind of record that wants the room dim."',
  most_played: 'Why the most-played record may have kept pulling the listener back. Example: "You came back to this one whenever the room got quiet."',
  mood_mix: 'The dominant mood and what it suggests about the stretch. Example: "Mostly mellow. A cycle of long evenings."',
  returning: 'The records that came back after a long gap. Example: "Three records you had not reached for since last winter."',
  cycle_over_cycle: 'What shifted from the previous cycle. Example: "You leaned later this cycle. Mellow gave way to late-night through March."',
};

export const SYSTEM_PROMPT =
  'You write the quiet narration for a vinyl listening app\'s cycle recap. A cycle means the listener ' +
  'played every record they own at least once before repeating any, which takes months of dedicated listening ' +
  'at home. The recap honors that with restraint: earned recognition, not celebration.\n\n' +
  'For each slide you are given, write one or two short observational sentences that sit under the stat on screen. ' +
  'Rules:\n' +
  '- Anchor every line in the data provided. Never invent plays, dates, moods, or facts about the listener.\n' +
  '- You may draw on what you know about a record or artist to describe its character, but keep it brief and certain.\n' +
  '- Do not state running times, track counts, release years, chart positions or other specifics about a record unless you are certain of them. Describe its feel instead.\n' +
  '- Second person, plain words, present or past tense. Read like someone narrating quietly over the listener\'s shoulder.\n' +
  '- No congratulations, no exclamation marks, no "journey", "crushed it", "amazing", no emoji.\n' +
  '- Do not repeat the stat itself verbatim; the stat is already on screen above your line.\n' +
  '- If the data is thin (a short cycle, one record, an odd mood split), say so honestly and simply.\n' +
  '- Each line 25 words or fewer.';

export function bridgeSchema(slides) {
  const properties = {};
  for (const s of slides) properties[s] = { type: 'string', description: SLIDE_BRIEF[s] };
  return { type: 'object', properties, required: slides, additionalProperties: false };
}

export function bridgePrompt(recap, slides) {
  const lines = [`Cycle ${recap.cycle_number}.`];
  lines.push(`Ran ${recap.days} days, ${recap.started.month} ${recap.started.year} to ${recap.ended.month} ${recap.ended.year}. ${recap.plays} plays across ${recap.records_played} records.`);
  if (recap.closer) lines.push(`Closer (last record played): ${recap.closer.title} by ${recap.closer.artist}.`);
  if (recap.most_played) lines.push(`Most played: ${recap.most_played.title} by ${recap.most_played.artist}, ${recap.most_played.play_count} plays.`);
  if (recap.mood_mix && recap.mood_mix.length) {
    lines.push('Mood mix (share of all mood tags across the plays; a play can carry more than one mood): ' +
      recap.mood_mix.map((m) => `${m.name} ${Math.round(m.share * 100)}%`).join(', ') + '.');
  }
  if (recap.returning) lines.push('Came back after a long gap: ' + recap.returning.map((r) => `${r.title} by ${r.artist} (${r.gap_days} days)`).join('; ') + '.');
  if (recap.cycle_over_cycle) {
    const c = recap.cycle_over_cycle;
    lines.push(`Versus cycle ${c.previous_cycle}: ${c.days.before} days then, ${c.days.now} now; ${c.plays.before} plays then, ${c.plays.now} now; top mood ${c.top_mood.before} then, ${c.top_mood.now} now; most played ${c.most_played.before} then, ${c.most_played.now} now.`);
  }
  lines.push('', `Write one bridge for each of these slides: ${slides.join(', ')}.`);
  return lines.join('\n');
}
