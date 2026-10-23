/**
 * Thessaloniki Metro — schedule model & station data.
 *
 * There is no official public API for live train positions, so this app
 * ESTIMATES where each train currently is by simulating the timetable:
 * known first/last departures + headway rules, replayed against the
 * current time in Athens. It is NOT real GPS tracking.
 *
 * Topology: the line is a Y. A single trunk runs from the western terminus
 * (Railway Station) to "25ης Μαρτίου", where it forks into two branches:
 *   - Branch A, already in service: Βούλγαρη → Νέα Ελβετία.
 *   - Branch B, the Kalamaria extension (opens 27/08/2026): Νομαρχία →
 *     Καλαμαριά → Αρετσού → Νέα Κρήνη → Μίκρα.
 * The Kalamaria extension does NOT continue past Νέα Ελβετία — it forks
 * off earlier, at 25ης Μαρτίου.
 *
 * Sources (checked Aug 2026): thessmetro.gr, Hellenic Metro (emetro.gr),
 * and Greek press coverage of the Kalamaria extension opening. Station
 * coordinates are the published lat/lon of each station from its English
 * Wikipedia article infobox (real geographic positions, not schematic).
 */

const STATIONS = [
  // --- Trunk: western terminus -> fork at 25ης Μαρτίου ---
  { id: "nsс", name: "Νέος Σιδηροδρομικός Σταθμός", short: "Ν. Σιδηροδρομικός Σταθμός", lat: 40.64361, lng: 22.92917, branch: "trunk", terminus: "west" },
  { id: "dim", name: "Δημοκρατίας",                   short: "Δημοκρατίας",                lat: 40.64111, lng: 22.93417, branch: "trunk" },
  { id: "ven", name: "Βενιζέλου",                      short: "Βενιζέλου",                  lat: 40.63694, lng: 22.94194, branch: "trunk" },
  { id: "ags", name: "Αγία Σοφία",                     short: "Αγία Σοφία",                 lat: 40.63444, lng: 22.94639, branch: "trunk" },
  { id: "sin", name: "Σιντριβάνι",                     short: "Σιντριβάνι",                 lat: 40.63056, lng: 22.95417, branch: "trunk", labelPos: "below" },
  { id: "pan", name: "Πανεπιστήμιο",                   short: "Πανεπιστήμιο",               lat: 40.62611, lng: 22.96000, branch: "trunk" },
  { id: "pap", name: "Παπάφειο",                       short: "Παπάφειο",                   lat: 40.61972, lng: 22.96250, branch: "trunk" },
  { id: "efk", name: "Ευκλείδης",                      short: "Ευκλείδης",                  lat: 40.61611, lng: 22.96028, branch: "trunk", labelPos: "left" },
  { id: "fle", name: "Φλέμιγκ",                        short: "Φλέμιγκ",                    lat: 40.60917, lng: 22.95722, branch: "trunk", labelPos: "left" },
  { id: "ana", name: "Ανάληψη",                        short: "Ανάληψη",                    lat: 40.60556, lng: 22.95778, branch: "trunk", labelPos: "left" },
  { id: "mar", name: "25ης Μαρτίου",                   short: "25ης Μαρτίου",               lat: 40.60056, lng: 22.95833, branch: "trunk", junction: true, labelPos: "left" },

  // --- Branch A: fork -> Νέα Ελβετία (already in service) ---
  { id: "vou", name: "Βούλγαρη",    short: "Βούλγαρη",    lat: 40.59444, lng: 22.96083, branch: "A" },
  { id: "nel", name: "Νέα Ελβετία", short: "Νέα Ελβετία", lat: 40.59306, lng: 22.96861, branch: "A", terminus: "east-a" },

  // --- Branch B: fork -> Kalamaria extension (opens 27/08/2026) ---
  { id: "nom", name: "Νομαρχία",   short: "Νομαρχία",   lat: 40.59139, lng: 22.95694, branch: "B", extension: true, labelPos: "left" },
  { id: "kal", name: "Καλαμαριά",  short: "Καλαμαριά",  lat: 40.58472, lng: 22.95306, branch: "B", extension: true, labelPos: "left" },
  { id: "are", name: "Αρετσού",    short: "Αρετσού",    lat: 40.57861, lng: 22.95444, branch: "B", extension: true, labelPos: "left" },
  { id: "nkr", name: "Νέα Κρήνη",  short: "Νέα Κρήνη",  lat: 40.57250, lng: 22.96111, branch: "B", extension: true },
  { id: "mik", name: "Μίκρα",      short: "Μίκρα",      lat: 40.56833, lng: 22.96583, branch: "B", extension: true, terminus: "east-b" },
];

// Athens local calendar date/time the Kalamaria extension enters commercial service.
const EXTENSION_OPENING = { year: 2026, month: 8, day: 27, hour: 5, minute: 15 };

const SCHEDULE = {
  // First train leaves the western terminus at this time, every day of the week.
  openTime: { hour: 5, minute: 15 },
  // Last service of the day closes the network at this time (24h clock,
  // values >= 24:00 mean "the following calendar morning"). Per THEMA's
  // published timetable.
  closeTimeByWeekday: {
    // 0 = Sunday ... 6 = Saturday
    0: { hour: 24, minute: 30 }, // Sun -> 00:30 Mon
    1: { hour: 24, minute: 30 }, // Mon -> 00:30 Tue
    2: { hour: 24, minute: 30 },
    3: { hour: 24, minute: 30 },
    4: { hour: 24, minute: 30 }, // Thu -> 00:30 Fri
    5: { hour: 26, minute: 0 },  // Fri -> 02:00 Sat
    6: { hour: 26, minute: 0 },  // Sat -> 02:00 Sun
  },
  // Official THEMA timetable (operator-published): trunk headway (Ν.Σ.Σ. <->
  // 25ης Μαρτίου), in minutes, by day type and time band. Every day has two
  // bands: "early" (05:15-07:30) and "main" (07:30 until close).
  //
  // The branch-specific headways THEMA publishes alongside these (Νέα
  // Ελβετία / Μίκρα) are NOT stored separately — they fall straight out of
  // the existing 2:1 branch-split pattern (branchForDeparture) applied to
  // the trunk headway below, and match THEMA's published numbers exactly
  // (e.g. main band weekday: trunk 2:55 -> branch A every 3x = 8:45, branch
  // B averaging 1.5x = 4:23 — exactly as published).
  //
  // NOTE: "Αργία" (public holidays) officially follow the Sunday timetable,
  // but this model has no holiday calendar, so only Κυριακή (dow 0) itself
  // gets the Sunday numbers — a public holiday falling on a weekday is not
  // currently detected and uses the weekday numbers instead.
  bandBoundaryHour: 7.5, // 07:30, same every day
  headwayBands: {
    weekday: { early: 5, main: 2 + 55 / 60 },   // Mon-Fri (closing time still differs Fri vs Mon-Thu)
    saturday: { early: 10, main: 2 + 55 / 60 },
    sunday: { early: 10, main: 3 + 25 / 60 },
  },
  // Per the operator: extra trains join service from the depot near Νέα
  // Ελβετία in the minutes before the 07:30 step-up, so the interval
  // tightens gradually rather than snapping instantly. Confirmed range was
  // 10-15'; using the midpoint. See buildRampInsertions() in app.js.
  rampMinutes: 12,
  // Approximate running times (assumption, tune freely). Trunk = western
  // terminus -> 25ης Μαρτίου fork. Branch A/B = fork -> each branch terminus.
  // Trunk + branch A totals ~19' (matches the current 13-station line).
  // Trunk + branch B totals ~27' once the 5-station extension is live.
  trunkTimeMin: 16,
  branchTimeMin: { A: 3, B: 11 },
  // Layover at a terminus before a train turns around and heads back.
  turnaroundMin: 2,
};

// Fleet size, as reported by the user: 18 trains serve the current network;
// 15 more join once the Kalamaria extension opens (33 total). Also used to
// cap the rendered/counted trains, since the headway math can otherwise
// imply more trains in the system than the real fleet has.
const FLEET = { base: 18, extensionExtra: 15 };
