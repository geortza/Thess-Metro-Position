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
 * and Greek press coverage of the Kalamaria extension opening.
 */

// Hand-placed schematic coordinates (not geographic), viewBox 0 0 1200 660.
const STATIONS = [
  // --- Trunk: western terminus -> fork at 25ης Μαρτίου ---
  { id: "nsс", name: "Νέος Σιδηροδρομικός Σταθμός", short: "Ν. Σιδηροδρομικός Σταθμός", x: 60,  y: 120, branch: "trunk", terminus: "west" },
  { id: "dim", name: "Δημοκρατίας",                   short: "Δημοκρατίας",                x: 175, y: 180, branch: "trunk" },
  { id: "ven", name: "Βενιζέλου",                      short: "Βενιζέλου",                  x: 290, y: 230, branch: "trunk" },
  { id: "ags", name: "Αγία Σοφία",                     short: "Αγία Σοφία",                 x: 400, y: 265, branch: "trunk", labelPos: "above" },
  { id: "sin", name: "Σιντριβάνι",                     short: "Σιντριβάνι",                 x: 500, y: 292, branch: "trunk", labelPos: "below" },
  { id: "pan", name: "Πανεπιστήμιο",                   short: "Πανεπιστήμιο",               x: 620, y: 292, branch: "trunk", labelPos: "above" },
  { id: "pap", name: "Παπάφειο",                       short: "Παπάφειο",                   x: 715, y: 268, branch: "trunk", labelPos: "below" },
  { id: "efk", name: "Ευκλείδης",                      short: "Ευκλείδης",                  x: 780, y: 235, branch: "trunk" },
  { id: "fle", name: "Φλέμιγκ",                        short: "Φλέμιγκ",                    x: 850, y: 190, branch: "trunk" },
  { id: "ana", name: "Ανάληψη",                        short: "Ανάληψη",                    x: 905, y: 240, branch: "trunk" },
  { id: "mar", name: "25ης Μαρτίου",                   short: "25ης Μαρτίου",               x: 955, y: 288, branch: "trunk", junction: true, labelPos: "above" },

  // --- Branch A: fork -> Νέα Ελβετία (already in service) ---
  { id: "vou", name: "Βούλγαρη",  short: "Βούλγαρη",   x: 1000, y: 340, branch: "A" },
  { id: "nel", name: "Νέα Ελβετία", short: "Νέα Ελβετία", x: 1040, y: 405, branch: "A", terminus: "east-a" },

  // --- Branch B: fork -> Kalamaria extension (opens 27/08/2026) ---
  { id: "nom", name: "Νομαρχία",   short: "Νομαρχία",   x: 900, y: 365, branch: "B", extension: true },
  { id: "kal", name: "Καλαμαριά",  short: "Καλαμαριά",  x: 850, y: 425, branch: "B", extension: true },
  { id: "are", name: "Αρετσού",    short: "Αρετσού",    x: 795, y: 470, branch: "B", extension: true },
  { id: "nkr", name: "Νέα Κρήνη",  short: "Νέα Κρήνη",  x: 725, y: 495, branch: "B", extension: true },
  { id: "mik", name: "Μίκρα",      short: "Μίκρα",      x: 650, y: 500, branch: "B", extension: true, terminus: "east-b" },
];

// Athens local calendar date/time the Kalamaria extension enters commercial service.
const EXTENSION_OPENING = { year: 2026, month: 8, day: 27, hour: 5, minute: 15 };

const SCHEDULE = {
  // First train leaves the western terminus at this time, every day of the week.
  openTime: { hour: 5, minute: 15 },
  // Last service of the day closes the network at this time (24h clock,
  // values >= 24:00 mean "the following calendar morning").
  closeTimeByWeekday: {
    // 0 = Sunday ... 6 = Saturday
    0: { hour: 24, minute: 30 }, // Sun -> 00:30 Mon
    1: { hour: 23, minute: 0 },
    2: { hour: 23, minute: 0 },
    3: { hour: 23, minute: 0 },
    4: { hour: 23, minute: 0 },
    5: { hour: 26, minute: 0 }, // Fri -> 02:00 Sat
    6: { hour: 26, minute: 0 }, // Sat -> 02:00 Sun
  },
  // Headway model, as described by the user: every 3' at peak, every 5' otherwise.
  // This is the frequency on the shared trunk. Once the Kalamaria extension is
  // live, departures alternate branch A / branch B, so each branch individually
  // sees half that frequency — the same way real Y-shaped metro branches split
  // a shared trunk service.
  peakHeadwayMin: 3,
  offPeakHeadwayMin: 5,
  // Peak windows apply on weekdays only (Mon-Fri). Assumption, tune freely.
  peakWindowsWeekday: [
    [{ hour: 7, minute: 0 }, { hour: 9, minute: 30 }],
    [{ hour: 14, minute: 0 }, { hour: 16, minute: 30 }],
    [{ hour: 19, minute: 0 }, { hour: 21, minute: 0 }],
  ],
  // Approximate running times (assumption, tune freely). Trunk = western
  // terminus -> 25ης Μαρτίου fork. Branch A/B = fork -> each branch terminus.
  // Trunk + branch A totals ~19' (matches the current 13-station line).
  // Trunk + branch B totals ~27' once the 5-station extension is live.
  trunkTimeMin: 16,
  branchTimeMin: { A: 3, B: 11 },
  // Layover at a terminus before a train turns around and heads back.
  turnaroundMin: 2,
};
