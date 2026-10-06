// §12 steps 6 and 7: the recap slide and final-screen markup.
//
// Slices the slide builders out of index.html and runs them in a vm with the
// app's own escapeHTML. Guards: record titles are escaped (they come from
// Discogs), the stat and Claude's bridge both render, a missing bridge leaves
// the space empty rather than placeholder text (§12.13), mood bars use share
// of tags, and the final screen offers Start only at the live end of a cycle.

import { read, sliceTo, sliceBetween, mustContain, runIn, check, report } from './lib/slice.mjs';

const APP = read('index.html');
const esc = sliceTo(APP, /^function escapeHTML\(s\)\{/, '}');
const builders = sliceBetween(APP, /^const RECAP_HOLD_MS=/, /^function playRecap\(/);
mustContain(builders, /function recapSlideHTML\(/, 'recapSlideHTML');
mustContain(builders, /function recapFinalHTML\(/, 'recapFinalHTML');

const sb = runIn(esc + '\n' + builders, {
  artCache: { '1': 'https://img/one.jpg' },
  MOODS: [{ id: 'energy', color: '#f97316' }],
  crateName: "Todd's <Crate>",
});

const r = {
  cycle_number: 2, days: 141, plays: 131,
  started: { month: 'May' }, ended: { month: 'October' },
  closer: { release_id: '1', title: 'Lateralus <i>', artist: 'Tool', art: null },
  most_played: { release_id: '2', title: 'Currents', artist: 'Moontricks', art: null, play_count: 2 },
  mood_mix: [{ slug: 'energy', name: 'Move', share: 0.57 }, { slug: 'sunday', name: 'Sunday', share: 0.43 }],
  returning: null, cycle_over_cycle: null,
};

const scale = sb.recapSlideHTML('scale', r, 'You started in late spring.');
check('scale shows days, plays and the months', /141 days/.test(scale) && /131 plays/.test(scale) && /May to October/.test(scale));
check('the bridge renders under the stat', /class="cr-bridge">You started in late spring\.</.test(scale));

const closer = sb.recapSlideHTML('closer', r, null);
check('record titles are escaped', /Lateralus &lt;i&gt;/.test(closer) && !/Lateralus <i>/.test(closer));
check('cover comes from the app cache first', /src="https:\/\/img\/one\.jpg"/.test(closer));
check('a dead cover falls back to the placeholder', /onerror=/.test(closer));
check('a missing bridge leaves the space empty, no placeholder text', /class="cr-bridge"><\/p>/.test(closer));

const most = sb.recapSlideHTML('most_played', r, 'x');
check('most played shows the play count', /Moontricks &middot; 2 plays/.test(most));
check('no cover at all shows the quiet placeholder', /class="cr-cover ph"/.test(most));

const mood = sb.recapSlideHTML('mood_mix', r, 'x');
check('mood bars use share of tags', /--w:57\.0%/.test(mood) && /--w:43\.0%/.test(mood) && /57%/.test(mood));
check('the dominant mood is bold', /<b>Move<\/b>/.test(mood));
check('mood bar classes do not collide with the tracklist .track', !/class="track"/.test(mood) && /class="cr-track"/.test(mood));

const live = sb.recapFinalHTML(r, ['scale', 'closer', 'most_played', 'mood_mix'], true);
check('final screen leads with the cycle number', /<h2>Cycle 2 complete\.<\/h2>/.test(live));
check('the crate name is escaped', /Todd&#39;s &lt;Crate&gt;|Todd's &lt;Crate&gt;/.test(live), live.match(/cr-kicker">([^<]*)/)?.[1]);
check('live end offers Start Cycle 3 and Not yet', /id="crStart">Start Cycle 3</.test(live) && /id="crLater">Not yet</.test(live));
const replay = sb.recapFinalHTML(r, ['scale'], false);
check('a replay offers only Close', !/crStart/.test(replay) && /id="crLater">Close</.test(replay));
check('no tile for slides with no data', !/Came back/.test(live) && !/vs Cycle/.test(live));

// Negative case: the old preview printed a placeholder sentence when bridges
// were missing; the slides must not.
check('negative: no "unreachable" copy in the slides', !/unreachable/i.test(builders));

process.exit(report() ? 1 : 0);
