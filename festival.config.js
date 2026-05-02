// ════════════════════════════════════════════════════════════════════════
// Festival configuration. To deploy this app for a different festival:
//   1. Clone the repo
//   2. Edit this file (festival.config.js)
//   3. Replace assets/artists.json with the new festival's lineup
//   4. Replace assets/map.png with the new festival's map (optional)
//   5. Update manifest.json + index.html <title> if you want a different
//      home-screen name (otherwise just live with what's here)
//   6. Deploy to a new domain
//
// All dates, stages, time slots, and branding are driven by this object.
// The rest of the app code is festival-agnostic.
// ════════════════════════════════════════════════════════════════════════

window.FESTIVAL = {
  id: 'edc-vegas-2026',

  // ── Branding ─────────────────────────────────────────────────────────
  appName: 'My Raver Life',
  // Subtitle shown under the h1. HTML allowed.
  subtitle: 'EDC Las Vegas <span class="year-tag">2026</span> · May 15–17',
  // Tagline shown in places like Help page (plain text).
  tagline: 'play your EDC',

  // ── Time grid ────────────────────────────────────────────────────────
  // Festival hours are expressed as "minutes from a reference start time"
  // so overnight festivals (5pm → 6am next day) work cleanly.
  // Reference: 0 = `dayStartHour` o'clock; festival ends at `dayLengthMins`.
  dayStartHour: 17,        // 5pm — covers Friday's pre-show 5pm openers too
  dayLengthMins: 780,      // 13 hours: ends at 6am next day

  // ── Days ─────────────────────────────────────────────────────────────
  days: [
    { id: 1, name: 'Friday',   date: 'May 15', short: 'Fri', sub: 'May 15' },
    { id: 2, name: 'Saturday', date: 'May 16', short: 'Sat', sub: 'May 16' },
    { id: 3, name: 'Sunday',   date: 'May 17', short: 'Sun', sub: 'May 17' },
  ],

  // ── Stages ───────────────────────────────────────────────────────────
  // `id` matches strings used in artists.json's `stage` field.
  // `short` is the 2-3 keyword genre tag shown on the chip's second line.
  // `tier`: 'main' = the 9 big stages most people care about,
  //         'secondary' = art cars, sponsored areas, smaller pop-ups.
  stages: [
    // Main 9
    { id: 'kineticFIELD',     tier: 'main', color: '#ff5aa0', genre: 'Mainstage — house, EDM, big-room headliners', short: 'mainstage / edm' },
    { id: 'circuitGROUNDS',   tier: 'main', color: '#2cc8ff', genre: 'Techno + house · Fri d&b / bass burst',       short: 'techno / house / bass' },
    { id: 'cosmicMEADOW',     tier: 'main', color: '#d39bff', genre: 'Mixed: bass, alt, future, live sets',         short: 'bass / mixed / alt' },
    { id: 'neonGARDEN',       tier: 'main', color: '#5cff3a', genre: 'Techno (some house early)',                   short: 'techno / house' },
    { id: 'stereoBLOOM',      tier: 'main', color: '#ff95dd', genre: 'House + tech house, groove-leaning',          short: 'house / tech house' },
    { id: 'bionicJUNGLE',     tier: 'main', color: '#a3e635', genre: 'House + techno + disco / funk',               short: 'house / techno / disco' },
    { id: 'quantumVALLEY',    tier: 'main', color: '#8b8dff', genre: 'Trance + progressive + melodic',              short: 'trance / prog / melodic' },
    { id: 'bassPOD',          tier: 'main', color: '#2dd4c0', genre: 'Dubstep / d&b / riddim — pure bass',          short: 'dubstep / d&b / riddim' },
    { id: 'wasteLAND',        tier: 'main', color: '#ff5560', genre: 'Hardstyle / hardcore',                        short: 'hardstyle / hardcore' },
    // Secondary / pop-up / art-car stages
    { id: 'beatBoxCAR',       tier: 'secondary', color: '#ff9933', genre: 'BeatBox Art Car — roving bass / electro',     short: 'art car / bass' },
    { id: 'casaBACARDI',      tier: 'secondary', color: '#ddb060', genre: 'Casa Bacardí — lounge / house',               short: 'lounge / house' },
    { id: 'electrolitHOUSE',  tier: 'secondary', color: '#5fd4ce', genre: 'Electrolit Hydration House — chill / house',  short: 'chill / house' },
    { id: 'forestHOUSE',      tier: 'secondary', color: '#6b8e6b', genre: 'Forest House — house / groove',               short: 'house / groove' },
    { id: 'insomniacFRIDAYS', tier: 'secondary', color: '#b08cff', genre: 'Insomniac Fridays — house / techno',          short: 'house / techno' },
    { id: 'picnicCAR',        tier: 'secondary', color: '#ffaa80', genre: 'Picnic Playtime Art Car — playful / mixed',   short: 'art car / mixed' },
    { id: 'takisHANGAR',      tier: 'secondary', color: '#ff5722', genre: 'Takis Rave Hangar — bass / heavy',            short: 'bass / heavy' },
    { id: 'yeeDC',            tier: 'secondary', color: '#f5c842', genre: 'YeeDC! — fun themed mixed',                   short: 'mixed / fun' },
  ],

  // ── Time buckets (slots) ─────────────────────────────────────────────
  // Each bucket has a `range` [startMins, endMins] from festival start.
  // Buckets must cover the full day window without gaps for the
  // bucket-from-time mapping to work. Order = display order.
  buckets: [
    { id: 'opener',  name: 'Opener',  time: '5–9pm',     range: [0,   240] },
    { id: 'mid',     name: 'Mid',     time: '9–11pm',    range: [240, 360] },
    { id: 'peak',    name: 'Peak',    time: '11pm–2am',  range: [360, 540] },
    { id: 'late',    name: 'Late',    time: '2–4am',     range: [540, 660] },
    { id: 'sunrise', name: 'Sunrise', time: '4–6am',     range: [660, 780] },
  ],

  // ── Timeline hour labels ─────────────────────────────────────────────
  // Auto-generated below from dayStartHour + dayLengthMins so you don't
  // hand-maintain this list. Override here only for non-hourly festivals.
  hourLabels: null, // set by buildHourLabels() below
};

// ── Auto-generate hour labels every 60 min ──────────────────────────────
(function buildHourLabels() {
  const F = window.FESTIVAL;
  if (F.hourLabels) return; // pre-set in config; respect it
  const labels = [];
  for (let mins = 0; mins <= F.dayLengthMins; mins += 60) {
    const absMin = (mins + F.dayStartHour * 60) % (24 * 60);
    const h24 = Math.floor(absMin / 60);
    const m = absMin % 60;
    let label;
    if (h24 === 0)       label = `12${m ? ':' + String(m).padStart(2, '0') : ''} am`;
    else if (h24 < 12)   label = `${h24}${m ? ':' + String(m).padStart(2, '0') : ''} am`;
    else if (h24 === 12) label = `12${m ? ':' + String(m).padStart(2, '0') : ''} pm`;
    else                 label = `${h24 - 12}${m ? ':' + String(m).padStart(2, '0') : ''} pm`;
    labels.push({ mins, label });
  }
  F.hourLabels = labels;
})();
