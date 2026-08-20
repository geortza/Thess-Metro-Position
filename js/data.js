/**
 * Thessaloniki Metro — schedule model & station data.
 *
 * There is no official public API for live train positions, so this app
 * ESTIMATES where each train currently is by simulating the timetable:
 * known first/last departures + headway rules, replayed against the
 * current time in Athens. It is NOT real GPS tracking.
 *
 * Sources (checked Aug 2026): thessmetro.gr, Hellenic Metro (emetro.gr),
 * and Greek press coverage of the Kalamaria extension opening.
 */

// Hand-placed schematic coordinates (not geographic), viewBox 0 0 1200 640.
// The line is drawn as a smooth curve through these points, in service order
// from the western terminus (Railway Station) to the eastern one (Mikra).
const STATIONS = [
  { id: "nsс", name: "Νέος Σιδηροδρομικός Σταθμός", short: "Ν. Σιδηροδρομικός Σταθμός", x: 60,   y: 120, terminus: "west", interchange: "Τρένο / ΚΤΕΛ" },
  { id: "dim", name: "Δημοκρατίας",                   short: "Δημοκρατίας",                x: 175,  y: 180 },
  { id: "ven", name: "Βενιζέλου",                      short: "Βενιζέλου",                  x: 290,  y: 230 },
  { id: "ags", name: "Αγία Σοφία",                     short: "Αγία Σοφία",                 x: 400,  y: 265, labelPos: "above" },
  { id: "sin", name: "Σιντριβάνι",                     short: "Σιντριβάνι",                 x: 500,  y: 292, labelPos: "below" },
  { id: "pan", name: "Πανεπιστήμιο",                   short: "Πανεπιστήμιο",               x: 620,  y: 292, labelPos: "above" },
  { id: "pap", name: "Παπάφειο",                       short: "Παπάφειο",                   x: 715,  y: 268, labelPos: "below" },
  { id: "efk", name: "Ευκλείδης",                      short: "Ευκλείδης",                  x: 780,  y: 235 },
  { id: "fle", name: "Φλέμιγκ",                        short: "Φλέμιγκ",                    x: 850,  y: 190 },
  { id: "ana", name: "Ανάληψη",                        short: "Ανάληψη",                    x: 905,  y: 240 },
  { id: "mar", name: "25ης Μαρτίου",                   short: "25ης Μαρτίου",               x: 950,  y: 300 },
  { id: "vou", name: "Βούλγαρη",                       short: "Βούλγαρη",                   x: 985,  y: 365 },
  { id: "nel", name: "Νέα Ελβετία",                    short: "Νέα Ελβετία",                x: 1010, y: 435, terminus: "base-east" },
  // --- Kalamaria extension — opens 27/08/2026 ---
  { id: "nom", name: "Νομαρχία",                       short: "Νομαρχία",                   x: 1015, y: 505, extension: true },
  { id: "kal", name: "Καλαμαριά",                      short: "Καλαμαριά",                  x: 995,  y: 570, extension: true },
  { id: "are", name: "Αρετσού",                        short: "Αρετσού",                    x: 950,  y: 615, extension: true },
  { id: "nkr", name: "Νέα Κρήνη",                       short: "Νέα Κρήνη",                  x: 880,  y: 630, extension: true },
  { id: "mik", name: "Μίκρα",                          short: "Μίκρα",                      x: 800,  y: 615, terminus: "east", extension: true },
];

// Athens local calendar date/time the Kalamaria extension enters commercial service.
const EXTENSION_OPENING = { year: 2026, month: 8, day: 27, hour: 5, minute: 15 };

const SCHEDULE = {
  // First train leaves each terminus at this time, every day of the week.
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
  peakHeadwayMin: 3,
  offPeakHeadwayMin: 5,
  // Peak windows apply on weekdays only (Mon-Fri). Assumption, tune freely.
  peakWindowsWeekday: [
    [{ hour: 7, minute: 0 }, { hour: 9, minute: 30 }],
    [{ hour: 14, minute: 0 }, { hour: 16, minute: 30 }],
    [{ hour: 19, minute: 0 }, { hour: 21, minute: 0 }],
  ],
  // Approximate end-to-end running time. Longer once the extension is live.
  travelTimeMinBase: 19,
  travelTimeMinExtended: 27,
};
