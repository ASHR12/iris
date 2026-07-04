// Generates demo-obsidian-vault/ — the "Constellation Field Guide".
//
// A fully fictional astronomy research vault used to demo and test the Neural
// Map, semantic search, and voice traversal WITHOUT any personal data. Safe to
// commit, screenshot, and ship in the open-source repo.
//
// ~176 notes across 11 folders, ~600 resolved wikilinks, zero broken links
// (the script validates itself with the same link-resolution rules the app's
// vault indexer uses and exits non-zero on any miss).
//
// Deterministic: a seeded PRNG drives all numbers, so re-running produces the
// exact same vault (git-friendly).
//
// Usage:  node scripts/generate-demo-vault.mjs   (or: npm run demo:vault)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const OUT = path.join(repoRoot, "demo-obsidian-vault");

// ---------- deterministic randomness ----------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260704);
const between = (lo, hi, dp = 0) => Number((lo + rand() * (hi - lo)).toFixed(dp));
const pickBy = (arr, key) => arr[[...key].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % arr.length];

function ra() {
  return `RA ${between(0, 23)}h ${String(between(0, 59)).padStart(2, "0")}m`;
}
function dec() {
  const sign = rand() > 0.5 ? "+" : "−";
  return `Dec ${sign}${between(0, 78)}° ${String(between(0, 59)).padStart(2, "0")}′`;
}

// ---------- universe data ----------

const REGIONS = {
  "Orion Belt": "The busiest training ground in the guide — bright, forgiving, and full of calibration-friendly targets.",
  "Cygnus Lane": "A dense transit-hunting corridor along the northern rift; most exoplanet candidates in this vault trace back here.",
  "Perseus Rim": "Deep-field territory. Long exposures, faint smudges, and the survey work that fills the archive.",
  "Lyra Arc": "Compact and elegant; home to the hottest close-in exoplanets we track.",
  "Vela Horizon": "Low southern sky from the observatory — a race against the horizon every session.",
  "Draco Crown": "Circumpolar and dependable; the fallback sector when weather cuts a night short.",
  "Carina Shelf": "Ring systems and bright moons; the showpiece sector for public nights.",
  "Aquarius Stream": "Ice-giant country. Slow movers, subtle colors, patient work.",
  "Pegasus Gate": "Where the interstellar visitors crossed. Sparse, but every signal here made history.",
  "Scorpius Deep": "The far, faint end of the survey — dwarf planets and their companions.",
  "Crux Meridian": "A narrow southern slice used for polarimetry and lensing baselines.",
  "Sagitta Spur": "The quiet sector. Mostly empty sky, which makes it perfect for dark-frame libraries.",
};

// body -> [class, region, one-line fact]
const BODIES = {
  Jupiter: ["gas giant", "Orion Belt", "Radio-loud and generous — its magnetosphere lights up the interferometer even on bad nights."],
  Io: ["volcanic moon", "Orion Belt", "Sulfur plumes change the surface between sessions; no two captures match."],
  Europa: ["ice moon", "Crux Meridian", "Chaos terrain and a buried ocean; the polarimeter sees the ice glint at high phase angles."],
  Enceladus: ["ice moon", "Perseus Rim", "South-pole geysers feed a faint E-ring; plume transits are the prize capture."],
  Titan: ["hazy moon", "Carina Shelf", "Methane weather under an orange veil — the spectrograph cuts straight through it."],
  Triton: ["retrograde moon", "Aquarius Stream", "Orbits backwards, vents nitrogen, and is almost certainly a captured dwarf."],
  Charon: ["binary companion", "Scorpius Deep", "Locked face-to-face with Pluto; together they form the guide's favorite binary."],
  Saturn: ["gas giant", "Carina Shelf", "Ring resonances telegraph the positions of moons too small to image directly."],
  Neptune: ["ice giant", "Aquarius Stream", "Supersonic winds and a storm cadence we still cannot predict."],
  Pluto: ["dwarf planet", "Scorpius Deep", "A heart-shaped glacier and a haze that scatters blue at twilight."],
  Vesta: ["asteroid", "Sagitta Spur", "Bright enough for binoculars; its meteor fragments land in our own collection drawer."],
  "Halley's Comet": ["periodic comet", "Perseus Rim", "The benchmark comet — every tail-ionization protocol was tuned on its archive."],
  Oumuamua: ["interstellar object", "Pegasus Gate", "First confirmed interstellar visitor; tumbling, elongated, and gone too fast."],
  Borisov: ["interstellar comet", "Pegasus Gate", "The second visitor — unmistakably a comet, chemically unlike anything local."],
  "Kepler-442b": ["super-Earth", "Cygnus Lane", "The vault's most-observed exoplanet: three separate signal campaigns and counting."],
  "TRAPPIST-1e": ["terrestrial exoplanet", "Cygnus Lane", "One of seven siblings; transit timing wobbles hint at the others."],
  "Proxima Centauri b": ["terrestrial exoplanet", "Vela Horizon", "The nearest exoplanet we track; flare weather from its star dominates the noise budget."],
  "Gliese 667Cc": ["super-Earth", "Vela Horizon", "Sits in a triple-star system — every measurement needs the extra light modeled out."],
  "LHS 1140b": ["super-Earth", "Draco Crown", "Dense, cool, and quiet; the cleanest radial-velocity target in the list."],
  "HD 189733b": ["hot Jupiter", "Draco Crown", "Cobalt-blue and violent — molten glass likely rains sideways in its winds."],
  "WASP-121b": ["ultra-hot Jupiter", "Lyra Arc", "So close to its star that metals boil off the day side into a comet-like tail."],
  "55 Cancri e": ["lava super-Earth", "Lyra Arc", "A permanent magma hemisphere; its heat signature flickers between passes."],
};

// signal type -> [phenomenon note, instrument note, one-line signature]
const SIGNALS = {
  Aurora: ["Aurora borealis spectrum", "Filter wheel LRGB-Ha", "oxygen-line emission ratios far above the seasonal baseline"],
  Roche: ["Roche lobe overflow", "SpectraGraph MK-III", "a mass-transfer stream signature bleeding into the continuum"],
  Redshift: ["Redshift drift", "SpectraGraph MK-III", "a systematic line displacement that survives barycentric correction"],
  Fast: ["Fast radio burst echo", "RadioLattice interferometer", "a millisecond burst followed by a fading echo train"],
  Supernova: ["Supernova remnant shell", "NebulaScope 24-inch", "an expanding shell edge brightening between epochs"],
  Solar: ["Solar corona mass ejection", "Polarimeter ring", "a polarization swing consistent with an outbound plasma front"],
  Nebula: ["Nebula ionization front", "Filter wheel LRGB-Ha", "an ionization edge advancing across the field"],
  Transit: ["Transit light curve", "PhotonDrift CCD array", "a clean box-shaped dip with matching ingress and egress"],
  Gravitational: ["Gravitational lensing arc", "PhotonDrift CCD array", "a faint arc whose curvature centers on the foreground mass"],
  Accretion: ["Accretion disk precession", "NebulaScope 24-inch", "a periodic brightness wobble tracing disk orientation"],
  Tidal: ["Tidal disruption flare", "NebulaScope 24-inch", "a smooth power-law decay after a sudden brightening"],
  Binary: ["Binary eclipse timing", "PhotonDrift CCD array", "primary and secondary minima drifting against the ephemeris"],
  Planetary: ["Planetary ring resonance", "NebulaScope 24-inch", "gap edges sharpening at the predicted resonance radii"],
  Meteor: ["Meteor shower peak", "StarTracker autoguider", "a radiant-aligned streak rate well above sporadic background"],
  Comet: ["Comet tail ionization", "NebulaScope 24-inch", "a disconnection event propagating down the ion tail"],
  Pulsar: ["Pulsar timing glitch", "RadioLattice interferometer", "a spin-up step followed by slow relaxation"],
  Magnetar: ["Magnetar burst", "RadioLattice interferometer", "a hard, brief burst with the characteristic double peak"],
  Doppler: ["Doppler broadening profile", "SpectraGraph MK-III", "line wings widening with temperature, exactly on model"],
  Cosmic: ["Cosmic microwave ripple", "RadioLattice interferometer", "a low-amplitude ripple persisting across calibration frames"],
  Interstellar: ["Interstellar absorption line", "SpectraGraph MK-III", "narrow absorption at a velocity no local cloud explains"],
};

const PHENOMENA_DETAIL = {
  "Aurora borealis spectrum": "Emission-line fingerprint of charged particles striking an atmosphere. The green 557.7 nm oxygen line dominates visually; ratios against the red doublet reveal precipitation energy.",
  "Roche lobe overflow": "When a star swells past its Roche lobe, matter streams to its companion. The stream glows in emission lines and modulates the light curve at the orbital period.",
  "Redshift drift": "The slow change of a source's redshift over years — a direct probe of cosmic acceleration, demanding wavelength calibration at the edge of what hardware allows.",
  "Fast radio burst echo": "Millisecond radio flashes of extreme brightness. Echo structure, when present, hints at reflection off nearby plasma shells.",
  "Supernova remnant shell": "The expanding debris sphere of a stellar explosion, visible for millennia as it sweeps up interstellar gas.",
  "Solar corona mass ejection": "A billion tons of magnetized plasma launched from a stellar corona. Polarimetry catches the front long before it arrives anywhere.",
  "Nebula ionization front": "The advancing boundary where hot-star ultraviolet eats into cold gas, lighting it up shell by shell.",
  "Transit light curve": "The photometric dip of a planet crossing its star. Depth gives radius; timing wobbles betray unseen siblings.",
  "Gravitational lensing arc": "Background light bent around a foreground mass into arcs. Geometry maps the invisible.",
  "Accretion disk precession": "A tilted accretion disk wobbles like a coin settling; its brightness wobble encodes the tilt and the feeding rate.",
  "Tidal disruption flare": "A star wandering too close to a compact mass is shredded; the debris fall-back glows with a tell-tale power-law decay.",
  "Binary eclipse timing": "Mutual eclipses of a stellar pair. Drift in the minima timing means a third body — or physics we have not modeled.",
  "Planetary ring resonance": "Ring particles herd into gaps and edges at radii resonant with moons; the rings are a seismograph for the system.",
  "Meteor shower peak": "Debris-stream crossings that turn the sky briefly generous. Radiant drift night-to-night confirms the parent body.",
  "Comet tail ionization": "The solar wind writes its weather into ion tails — kinks, rays, and outright disconnection events.",
  "Pulsar timing glitch": "Neutron stars spin like clocks, then abruptly spin up as their superfluid interior slips. The recovery curve probes matter at nuclear density.",
  "Magnetar burst": "Magnetically powered flashes from the most magnetized objects known — brief, hard, and unpredictable.",
  "Doppler broadening profile": "Thermal motion smears spectral lines into characteristic wings; width is temperature made visible.",
  "Cosmic microwave ripple": "Low-level structure in the microwave background — mostly calibration ghosts, occasionally not, always logged.",
  "Interstellar absorption line": "Cold clouds between us and a source subtract narrow slices of spectrum; each line is a cloud census entry.",
};

const INSTRUMENTS = {
  "NebulaScope 24-inch": ["Primary reflector", "0.61 m f/4.9 Newtonian on a fork mount; the workhorse optical tube for imaging campaigns."],
  "PhotonDrift CCD array": ["Imaging camera", "Back-illuminated 61-megapixel CCD mosaic, −80 °C operating point, 1.2 e⁻ read noise; every light curve in this vault runs through it."],
  "SpectraGraph MK-III": ["Echelle spectrograph", "R ≈ 42,000 fiber-fed echelle with simultaneous ThAr calibration; measures line positions to a few m/s."],
  "RadioLattice interferometer": ["Radio array", "Sixteen 3-meter dishes on a 400 m east-west baseline, 1.1–1.6 GHz; correlates in real time on the logger node."],
  "Polarimeter ring": ["Polarimeter", "Rotating half-wave plate assembly ahead of the CCD; 0.05 % polarization precision on bright targets."],
  "Filter wheel LRGB-Ha": ["Filter wheel", "Seven-position wheel: LRGB, Hα, OIII, SII. The narrowbands do the heavy lifting on emission phenomena."],
  "StarTracker autoguider": ["Autoguider", "Wide-field 200 mm guide scope with sub-arcsecond corrections; doubles as the meteor patrol camera."],
  "Adaptive mirror cell": ["Active optics", "18-point actuated primary cell; refigures the mirror as temperature drops through the night."],
  "Cryo dewar controller": ["Cryogenics", "Closed-cycle cooler holding detector stages at set-point within 0.1 K; alarms feed the abort criteria."],
  "Data logger node": ["Acquisition node", "Time-stamps every frame and telemetry channel against GPS; the single source of truth for session logs."],
};

const PROTOCOLS = {
  "Flat field calibration": "Even illumination frames taken at dusk against the twilight sky; divides out vignetting and dust shadows.",
  "Dark frame subtraction": "Matched-temperature dark exposures library, refreshed monthly; subtracts thermal signal before any measurement.",
  "Wavelength zero-point check": "ThAr lamp exposures bracketing every spectrograph run; drifts beyond 30 m/s trigger recalibration.",
  "Photometry standard stars": "Landolt-field standards observed at matching airmass; converts instrumental magnitudes to the standard system.",
  "Pointing model refresh": "A 25-star all-sky pointing run rebuilds the mount model whenever RMS exceeds 40 arcseconds.",
  "Weather abort criteria": "Hard limits: humidity 85 %, wind 45 km/h sustained, any precipitation. The dome closes first and asks questions later.",
  "Spectral line identification": "Line lists matched against rest wavelengths with velocity solutions; unidentified lines escalate to the atlas.",
  "Archive metadata tagging": "Every capture gets region, body, phenomenon, instrument, and mission tags before it enters the archive — future searches depend on it.",
};

const GLOSSARY = {
  Albedo: "Fraction of incident light a surface reflects. Fresh ice approaches 1; comet crust can sit below 0.05.",
  Conjunction: "Two bodies sharing the same apparent sky longitude — observation windows often close around solar conjunction.",
  Declination: "Celestial latitude, in degrees from the celestial equator. Pairs with right ascension to fix a sky position.",
  "Luminosity class": "Roman-numeral tag (I–V) separating giants from dwarfs among stars of the same temperature.",
  Magnitude: "Logarithmic brightness scale; five magnitudes equal a factor of one hundred, and smaller numbers are brighter.",
  Obliquity: "Tilt of a body's spin axis against its orbital plane — the reason seasons exist.",
  Opposition: "The moment a body sits opposite the Sun in our sky: closest, brightest, visible all night.",
  Parallax: "Apparent positional shift against distant background when viewed from two vantage points; the first rung of the distance ladder.",
  Photometry: "Measuring brightness and its changes precisely — the discipline behind every light curve in this vault.",
  "Proper motion": "A body's real angular drift across the sky per year, distinct from parallax's annual wobble.",
  "Radial velocity": "Line-of-sight speed measured from spectral line shifts; positive means receding.",
  Redshift: "Stretching of light toward longer wavelengths by recession or gravity; the raw measurement behind cosmic distance.",
  "Right ascension": "Celestial longitude, measured in hours eastward along the celestial equator.",
  Spectroscopy: "Splitting light into its component wavelengths to read composition, temperature, and motion from the lines.",
  "Synodic period": "Time between repeats of a configuration as seen from Earth — opposition to opposition.",
  Transit: "One body crossing the face of another. Depth, duration, and timing carry most of exoplanet science.",
};

// mission -> [season, region, instruments[], blurb]
const MISSIONS = {
  "Aurora Watch 2025": ["2025-winter", "Orion Belt", ["Filter wheel LRGB-Ha", "PhotonDrift CCD array"], "Nightly narrowband patrol for auroral emission across the bright winter targets."],
  "Comet Tail Survey": ["2025-winter", "Perseus Rim", ["NebulaScope 24-inch", "StarTracker autoguider"], "Wide-field monitoring of active comet tails for disconnection events."],
  "Deep Field Perseus": ["2025-winter", "Perseus Rim", ["NebulaScope 24-inch", "PhotonDrift CCD array"], "Stacked long exposures of one Perseus Rim field — the archive's deepest image."],
  "Ice Moon Spectroscopy": ["2025-winter", "Carina Shelf", ["SpectraGraph MK-III", "Cryo dewar controller"], "Surface-ice spectra of the bright moons, hunting plume signatures."],
  "Magnetar Monitor": ["2025-winter", "Draco Crown", ["RadioLattice interferometer", "Data logger node"], "Standing radio watch on known magnetar positions; triggers within seconds of a burst."],
  "Aurora Watch 2026": ["2026-spring", "Vela Horizon", ["Filter wheel LRGB-Ha", "Polarimeter ring"], "Second-season aurora patrol, now with simultaneous polarimetry."],
  "Carina Shelf sweep": ["2026-spring", "Carina Shelf", ["NebulaScope 24-inch", "Filter wheel LRGB-Ha"], "Systematic imaging sweep of the shelf's ring systems and moons."],
  "Cygnus Transit Hunt": ["2026-spring", "Cygnus Lane", ["PhotonDrift CCD array", "StarTracker autoguider"], "High-cadence photometry through the transit corridor; the vault's exoplanet engine."],
  "Draco dwarf study": ["2026-spring", "Draco Crown", ["SpectraGraph MK-III", "PhotonDrift CCD array"], "Radial-velocity series on the quiet Draco Crown super-Earths."],
  "Interstellar visitor watch": ["2026-spring", "Pegasus Gate", ["NebulaScope 24-inch", "SpectraGraph MK-III"], "Rapid-response astrometry and spectra for anything on a hyperbolic orbit."],
  "Vela exoplanet week": ["2026-spring", "Vela Horizon", ["PhotonDrift CCD array", "SpectraGraph MK-III"], "Seven consecutive nights on the Vela Horizon planet hosts."],
  "Archive cross-match": ["2026-summer", "Sagitta Spur", ["Data logger node"], "No dome time — a pure archive campaign matching old plates against new signal positions."],
  "Binary eclipse series": ["2026-summer", "Scorpius Deep", ["PhotonDrift CCD array"], "Timing series on eclipsing pairs; hunting third bodies through minima drift."],
  "Fast radio follow-up": ["2026-summer", "Crux Meridian", ["RadioLattice interferometer", "Data logger node"], "Chasing burst repeats at the positions of past fast radio detections."],
  "Meteor storm campaign": ["2026-summer", "Sagitta Spur", ["StarTracker autoguider"], "All-sky patrol through the season's stream crossings; every streak time-stamped."],
  "Nebula ionization survey": ["2026-summer", "Perseus Rim", ["Filter wheel LRGB-Ha", "NebulaScope 24-inch"], "Narrowband mapping of ionization fronts across three emission fields."],
  "Pulsar timing run": ["2026-summer", "Draco Crown", ["RadioLattice interferometer"], "Weekly timing points on the monitored pulsars; glitch alerts feed straight to the log."],
  "Ring resonance study": ["2026-summer", "Carina Shelf", ["NebulaScope 24-inch", "PhotonDrift CCD array"], "Edge-on season geometry — measuring gap edges against resonance predictions."],
  "Solar limb mapping": ["2026-summer", "Orion Belt", ["Polarimeter ring", "Cryo dewar controller"], "Daytime program tracing coronal structure by polarization at the limb."],
  "Spectral library build": ["2026-summer", "Lyra Arc", ["SpectraGraph MK-III", "Data logger node"], "Reference spectra for every bright target — the calibration bedrock for next season."],
};

// Themed mission routing: signal type -> preferred mission per season.
const MISSION_BY_TYPE = {
  "2025-winter": { Aurora: "Aurora Watch 2025", Comet: "Comet Tail Survey", Magnetar: "Magnetar Monitor", Supernova: "Deep Field Perseus", Nebula: "Deep Field Perseus", Gravitational: "Deep Field Perseus", Cosmic: "Magnetar Monitor", Fast: "Magnetar Monitor", Pulsar: "Magnetar Monitor", Roche: "Ice Moon Spectroscopy", Doppler: "Ice Moon Spectroscopy", Redshift: "Ice Moon Spectroscopy", Interstellar: "Ice Moon Spectroscopy", Transit: "Deep Field Perseus", Solar: "Aurora Watch 2025", Binary: "Deep Field Perseus", Tidal: "Deep Field Perseus", Meteor: "Comet Tail Survey", Accretion: "Deep Field Perseus", Planetary: "Ice Moon Spectroscopy" },
  "2026-spring": { Aurora: "Aurora Watch 2026", Transit: "Cygnus Transit Hunt", Interstellar: "Interstellar visitor watch", Comet: "Interstellar visitor watch", Redshift: "Draco dwarf study", Doppler: "Draco dwarf study", Solar: "Aurora Watch 2026", Supernova: "Carina Shelf sweep", Nebula: "Carina Shelf sweep", Planetary: "Carina Shelf sweep", Magnetar: "Draco dwarf study", Fast: "Draco dwarf study", Pulsar: "Draco dwarf study", Gravitational: "Cygnus Transit Hunt", Binary: "Cygnus Transit Hunt", Tidal: "Vela exoplanet week", Meteor: "Vela exoplanet week", Roche: "Vela exoplanet week", Cosmic: "Draco dwarf study", Accretion: "Carina Shelf sweep" },
  "2026-summer": { Meteor: "Meteor storm campaign", Pulsar: "Pulsar timing run", Fast: "Fast radio follow-up", Binary: "Binary eclipse series", Nebula: "Nebula ionization survey", Supernova: "Nebula ionization survey", Planetary: "Ring resonance study", Accretion: "Ring resonance study", Solar: "Solar limb mapping", Interstellar: "Spectral library build", Redshift: "Spectral library build", Doppler: "Spectral library build", Roche: "Spectral library build", Gravitational: "Archive cross-match", Cosmic: "Fast radio follow-up", Magnetar: "Fast radio follow-up", Transit: "Binary eclipse series", Aurora: "Solar limb mapping", Comet: "Archive cross-match", Tidal: "Archive cross-match" },
};

// The discovery log: [date, body, signal type]. 45 entries, Jan–Jun 2026.
const DISCOVERIES = [
  ["2026-01-01", "Kepler-442b", "Aurora"], ["2026-01-03", "Jupiter", "Roche"],
  ["2026-01-07", "55 Cancri e", "Redshift"], ["2026-01-09", "Neptune", "Fast"],
  ["2026-01-13", "Enceladus", "Supernova"], ["2026-01-15", "Borisov", "Solar"],
  ["2026-01-19", "Halley's Comet", "Nebula"], ["2026-01-25", "Proxima Centauri b", "Transit"],
  ["2026-02-02", "HD 189733b", "Gravitational"], ["2026-02-04", "Saturn", "Accretion"],
  ["2026-02-08", "LHS 1140b", "Tidal"], ["2026-02-10", "Triton", "Binary"],
  ["2026-02-14", "Io", "Planetary"], ["2026-02-16", "Vesta", "Meteor"],
  ["2026-02-20", "Oumuamua", "Comet"], ["2026-02-26", "TRAPPIST-1e", "Pulsar"],
  ["2026-03-03", "Proxima Centauri b", "Solar"], ["2026-03-05", "Europa", "Supernova"],
  ["2026-03-09", "Jupiter", "Magnetar"], ["2026-03-11", "Pluto", "Nebula"],
  ["2026-03-15", "Neptune", "Doppler"], ["2026-03-17", "Kepler-442b", "Transit"],
  ["2026-03-21", "Borisov", "Aurora"], ["2026-03-27", "Gliese 667Cc", "Redshift"],
  ["2026-04-04", "TRAPPIST-1e", "Meteor"], ["2026-04-06", "Titan", "Planetary"],
  ["2026-04-10", "Saturn", "Interstellar"], ["2026-04-12", "Charon", "Comet"],
  ["2026-04-16", "Triton", "Cosmic"], ["2026-04-22", "Vesta", "Gravitational"],
  ["2026-04-28", "WASP-121b", "Tidal"], ["2026-05-01", "55 Cancri e", "Magnetar"],
  ["2026-05-05", "Gliese 667Cc", "Transit"], ["2026-05-07", "Enceladus", "Doppler"],
  ["2026-05-11", "Europa", "Roche"], ["2026-05-13", "Halley's Comet", "Aurora"],
  ["2026-05-17", "Pluto", "Fast"], ["2026-05-23", "Kepler-442b", "Solar"],
  ["2026-06-02", "LHS 1140b", "Interstellar"], ["2026-06-06", "WASP-121b", "Pulsar"],
  ["2026-06-08", "Io", "Cosmic"], ["2026-06-12", "Titan", "Accretion"],
  ["2026-06-14", "Oumuamua", "Gravitational"], ["2026-06-18", "Charon", "Binary"],
  ["2026-06-24", "HD 189733b", "Meteor"],
];

const ATLAS = {
  "Exoplanet atmospheres": {
    blurb: "What we can actually say about air we will never breathe: transit depths that change with wavelength, sodium wings, and heat maps from phase curves.",
    links: ["Transit light curve", "Doppler broadening profile", "Spectroscopy", "HD 189733b", "WASP-121b", "TRAPPIST-1e", "Kepler-442b", "SpectraGraph MK-III", "Cygnus Transit Hunt"],
  },
  "Radio astronomy primer": {
    blurb: "The sky below 2 GHz: bursts, pulsar clocks, and the discipline of interferometry with sixteen small dishes standing in for one large one.",
    links: ["Fast radio burst echo", "Pulsar timing glitch", "Magnetar burst", "Cosmic microwave ripple", "RadioLattice interferometer", "Data logger node", "Fast radio follow-up", "Pulsar timing run"],
  },
  "Interstellar chemistry": {
    blurb: "Molecules in the void: absorption-line censuses of cold clouds and the strange volatile mixes carried by interstellar visitors.",
    links: ["Interstellar absorption line", "Comet tail ionization", "Oumuamua", "Borisov", "Spectroscopy", "Interstellar visitor watch", "Pegasus Gate"],
  },
  "Stellar evolution tracks": {
    blurb: "From contraction to collapse — where giants, dwarfs, and remnants sit, and how the guide's targets map onto the diagram.",
    links: ["Luminosity class", "Supernova remnant shell", "Tidal disruption flare", "Roche lobe overflow", "Magnitude", "Deep Field Perseus"],
  },
  "Time-domain astronomy": {
    blurb: "Everything that changes: transits, eclipses, flares, glitches, and the cadence choices that decide what you are able to see.",
    links: ["Transit light curve", "Binary eclipse timing", "Tidal disruption flare", "Pulsar timing glitch", "Photometry", "Binary eclipse series", "Cygnus Transit Hunt"],
  },
  "Galactic structure overview": {
    blurb: "The vault's regions stitched into one map — lanes, rims, and streams as slices through the local spiral structure.",
    links: ["Orion Belt", "Cygnus Lane", "Perseus Rim", "Aquarius Stream", "Scorpius Deep", "Proper motion", "Parallax"],
  },
  "Observatory safety": {
    blurb: "The rules that keep glass, cryogenics, and people intact — and the abort thresholds nobody argues with at 3 a.m.",
    links: ["Weather abort criteria", "Cryo dewar controller", "Adaptive mirror cell", "Pointing model refresh"],
  },
  "Citizen science pipelines": {
    blurb: "How public volunteers double our eyes: transit vetting queues, meteor counting, and the tagging standards that make shared data usable.",
    links: ["Archive metadata tagging", "Meteor shower peak", "Transit light curve", "Meteor storm campaign", "Archive cross-match", "Photometry"],
  },
};

// ---------- note assembly ----------

const files = new Map(); // rel path -> content

function fm(fields) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    lines.push(Array.isArray(value) ? `${key}: [${value.join(", ")}]` : `${key}: ${value}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

function note(rel, frontmatter, body) {
  files.set(rel, fm(frontmatter) + body.trim() + "\n");
}

const seasonOf = (date) => {
  const month = Number(date.slice(5, 7));
  if (month <= 2) return "2025-winter";
  if (month <= 5) return "2026-spring";
  return "2026-summer";
};
const missionOf = ([date, , type]) => MISSION_BY_TYPE[seasonOf(date)][type];
const discTitle = ([date, body, type]) => `${date} ${body} ${type} signal`;
const discRel = (d) => `discoveries/${discTitle(d)}.md`;

// Per-entity discovery lookups.
const discByBody = new Map();
const discByMission = new Map();
const discByRegion = new Map();
for (const d of DISCOVERIES) {
  const [, body] = d;
  const region = BODIES[body][1];
  (discByBody.get(body) ?? discByBody.set(body, []).get(body)).push(d);
  (discByMission.get(missionOf(d)) ?? discByMission.set(missionOf(d), []).get(missionOf(d))).push(d);
  (discByRegion.get(region) ?? discByRegion.set(region, []).get(region)).push(d);
}

const GLOSSARY_KEYS = Object.keys(GLOSSARY);
const PROTOCOL_KEYS = Object.keys(PROTOCOLS);

// --- discoveries (the dense layer) ---
for (const d of DISCOVERIES) {
  const [date, body, type] = d;
  const [phenomenon, instrument, signature] = SIGNALS[type];
  const region = BODIES[body][1];
  const mission = missionOf(d);
  const snr = between(4.2, 38.6, 1);
  const exposures = between(6, 84);
  const rich = date === "2026-06-24"; // one showcase note for the reader

  const bodyText = [
    `While [[${mission}]] was on target, the ${instrument.split(" ")[0]} pipeline flagged [[${body}]] in [[${region}]]: ${signature}. Classified as a **${phenomenon}** event after review.`,
    "",
    "## Readings",
    "",
    `- Position: ${ra()} · ${dec()}`,
    `- Detection: SNR ${snr} across ${exposures} frames`,
    `- Instrument: [[${instrument}]]`,
    `- Phenomenon: [[${phenomenon}]]`,
    `- Reduction: [[${pickBy(PROTOCOL_KEYS, body)}]] applied before measurement`,
    "",
    "## Assessment",
    "",
    `${PHENOMENA_DETAIL[phenomenon].split(". ")[0]}. ${rand() > 0.5 ? "Repeat coverage is scheduled within the same campaign." : "Archived for cross-match against earlier seasons."}`,
  ];

  if (rich) {
    bodyText.push(
      "",
      "<!-- demo-vault:showcase:begin -->",
      "## Capture notes",
      "",
      "| Frame set | Filter | Exposure | Streaks |",
      "| --- | --- | --- | --- |",
      `| A | L | 30 s × ${between(10, 20)} | ${between(3, 9)} |`,
      `| B | Hα | 120 s × ${between(4, 9)} | ${between(1, 4)} |`,
      "",
      '<video src="https://example.com/demo-vault/meteor-timelapse"></video>',
      "",
      "The timelapse above is a placeholder link — this vault is synthetic demo data.",
      "<!-- demo-vault:showcase:end -->",
    );
  }

  note(discRel(d), {
    type: "discovery", date, body: `"${body}"`, region: `"${region}"`,
    phenomenon: `"${phenomenon}"`, mission: `"${mission}"`, confidence: rand() > 0.3 ? "confirmed" : "provisional",
    tags: ["discovery", type.toLowerCase()],
  }, bodyText.join("\n"));
}

// --- bodies ---
for (const [body, [klass, region, fact]] of Object.entries(BODIES)) {
  const discs = discByBody.get(body) ?? [];
  const phen = [...new Set(discs.map(([, , t]) => SIGNALS[t][0]))];
  const terms = [pickBy(GLOSSARY_KEYS, body), pickBy(GLOSSARY_KEYS, body + "x")];
  note(`bodies/${body}.md`, {
    type: "body", class: `"${klass}"`, region: `"${region}"`, magnitude: between(-2.5, 14.8, 1),
    tags: ["body", klass.split(" ").pop()],
  }, [
    `A ${klass} in [[${region}]]. ${fact}`,
    "",
    `Key measures live under [[${terms[0]}]] and [[${terms[1]}]]; see [[${pickBy(Object.keys(ATLAS), body)}]] for the wider picture.`,
    "",
    "## Observed phenomena",
    "",
    ...phen.map((p) => `- [[${p}]]`),
    "",
    "## Signal log (auto)",
    "",
    `**${discs.length} signal(s)** on record`,
    "",
    ...discs.map((d) => `- [[${discTitle(d)}|${d[0]} · ${d[2]}]]`),
  ].join("\n"));
}

// --- regions ---
for (const [region, blurb] of Object.entries(REGIONS)) {
  const bodies = Object.entries(BODIES).filter(([, v]) => v[1] === region).map(([k]) => k);
  const missions = Object.entries(MISSIONS).filter(([, v]) => v[1] === region).map(([k]) => k);
  const signalCount = (discByRegion.get(region) ?? []).length;
  note(`regions/${region}.md`, {
    type: "region", bodies: bodies.length, signals: signalCount, tags: ["region"],
  }, [
    blurb,
    "",
    "## Resident bodies",
    "",
    ...(bodies.length ? bodies.map((b) => `- [[${b}]]`) : ["- (none tracked — dark-sky calibration sector)"]),
    "",
    "## Campaigns here",
    "",
    ...(missions.length ? missions.map((m) => `- [[${m}]]`) : [`- Covered opportunistically; see [[Archive cross-match]].`]),
  ].join("\n"));
}

// --- phenomena ---
for (const [name, detail] of Object.entries(PHENOMENA_DETAIL)) {
  const instrument = Object.values(SIGNALS).find(([p]) => p === name)[1];
  const terms = [pickBy(GLOSSARY_KEYS, name), pickBy(GLOSSARY_KEYS, name + "y")];
  note(`phenomena/${name}.md`, { type: "phenomenon", tags: ["phenomenon"] }, [
    detail,
    "",
    "## Observing it",
    "",
    `- Best instrument: [[${instrument}]]`,
    `- Foundations: [[${terms[0]}]], [[${terms[1]}]]`,
    `- Log every capture per [[Archive metadata tagging]]`,
  ].join("\n"));
}

// --- instruments ---
for (const [name, [kind, detail]] of Object.entries(INSTRUMENTS)) {
  const cal = [pickBy(PROTOCOL_KEYS, name), pickBy(PROTOCOL_KEYS, name + "z")];
  note(`instruments/${name}.md`, { type: "instrument", kind: `"${kind}"`, tags: ["instrument"] }, [
    detail,
    "",
    "## Calibration",
    "",
    `- [[${cal[0]}]]`,
    `- [[${cal[1]}]]`,
    "",
    `Telemetry is time-stamped by the [[Data logger node]].`,
  ].join("\n"));
}

// --- protocols ---
for (const [name, detail] of Object.entries(PROTOCOLS)) {
  const term = pickBy(GLOSSARY_KEYS, name);
  note(`protocols/${name}.md`, { type: "protocol", tags: ["protocol"] }, [
    detail,
    "",
    "## Steps",
    "",
    `1. Verify preconditions in the session checklist ([[conventions]]).`,
    `2. Execute and log against the [[Data logger node]] timeline.`,
    `3. Record outcomes; escalate anomalies via [[Archive metadata tagging]].`,
    "",
    `Background reading: [[${term}]].`,
  ].join("\n"));
}

// --- glossary ---
for (const [term, definition] of Object.entries(GLOSSARY)) {
  const others = GLOSSARY_KEYS.filter((t) => t !== term);
  const see = [pickBy(others, term), pickBy(others, term + "q")].filter((v, i, a) => a.indexOf(v) === i);
  note(`glossary/${term}.md`, { type: "term", tags: ["glossary"] }, [
    definition,
    "",
    `See also: ${see.map((s) => `[[${s}]]`).join(" · ")}.`,
  ].join("\n"));
}

// --- missions ---
for (const [name, [season, region, instruments, blurb]] of Object.entries(MISSIONS)) {
  const discs = discByMission.get(name) ?? [];
  note(`missions/${season}/${name}.md`, {
    type: "mission", season: `"${season}"`, region: `"${region}"`,
    status: season === "2026-summer" ? "active" : "complete", tags: ["mission"],
  }, [
    blurb,
    "",
    `Primary field: [[${region}]] · Weather rules: [[Weather abort criteria]]`,
    "",
    "## Instruments",
    "",
    ...instruments.map((i) => `- [[${i}]]`),
    "",
    "## Signal log (auto)",
    "",
    `**${discs.length} signal(s)** attributed to this campaign`,
    "",
    ...(discs.length
      ? discs.map((d) => `- [[${discTitle(d)}|${d[0]} · ${d[1]} · ${d[2]}]]`)
      : ["- None yet — survey and calibration output only."]),
  ].join("\n"));
}

// --- home, meta, readme ---
const atlasLinks = Object.keys(ATLAS).map((a) => `- [[${a}]]`);
const regionLine = Object.keys(REGIONS).map((r) => `[[${r}]]`).join(" · ");
const missionsBySeason = ["2025-winter", "2026-spring", "2026-summer"].map((season) => {
  const names = Object.entries(MISSIONS).filter(([, v]) => v[0] === season).map(([k]) => `[[${k}]]`);
  return `- **${season}** — ${names.join(" · ")}`;
});

note("Home.md", { type: "moc", tags: ["index"], created: "2026-07-04", updated: "2026-07-04" }, [
  "# Constellation Field Guide — Home",
  "",
  "Master index of a fictional observatory's research vault. Start here, follow links outward. Conventions live in [[conventions]]; what this demo is for lives in [[README]].",
  "",
  "## Atlas (deep dives)",
  "",
  ...atlasLinks,
  "",
  "## Sky regions",
  "",
  regionLine,
  "",
  "## Campaigns",
  "",
  ...missionsBySeason,
  "",
  "## Most-watched bodies",
  "",
  "- [[Kepler-442b]] — three signal campaigns and counting",
  "- [[Halley's Comet]] — the calibration benchmark",
  "- [[Oumuamua]] and [[Borisov]] — the interstellar visitors",
  "- [[Saturn]] — ring resonance showpiece",
  "",
  "## Ground rules",
  "",
  "- Every capture is tagged per [[Archive metadata tagging]]",
  "- The dome closes on [[Weather abort criteria]] — no exceptions",
  "- New observers start with [[Pointing model refresh]] and [[Flat field calibration]]",
].join("\n"));

note("_meta/conventions.md", { type: "meta", tags: ["meta"] }, [
  "# Vault conventions",
  "",
  "- **Folders**: `bodies/` (what we watch) · `regions/` (where) · `phenomena/` (what happens) · `instruments/` (with what) · `protocols/` (how) · `discoveries/` (what we found) · `missions/` (campaigns, by season) · `glossary/` (terms) · `atlas/` (deep dives).",
  "- **Naming**: discoveries are `YYYY-MM-DD <Body> <Type> signal`; missions live under their season folder.",
  "- **Frontmatter**: every note carries `type` and `tags`; discoveries add `body`, `region`, `phenomenon`, `mission`, `confidence`.",
  "- **Linking**: first mention of any entity gets a wikilink; auto sections (`Signal log`) are machine-style lists like a synced vault would maintain.",
  "- This is **synthetic demo data** — every object, reading, and result is fictional.",
].join("\n"));

note("README.md", { type: "meta", tags: ["meta"] }, [
  "# Demo vault — Constellation Field Guide",
  "",
  "A fictional astronomy research vault for testing and demoing Iris's **Neural Map** without exposing personal notes. ~176 notes, ~600 links, 11 folders — enough structure for constellations, semantic search, and voice traversal.",
  "",
  "## Use it with Iris",
  "",
  "1. Settings → Hermes → **Hermes brain vault** → set to this folder's absolute path",
  "2. (Optional) **Build index now** to enable semantic search — embeddings cache under `~/.iris/brain-index/`, never in this repo",
  "3. Enter HUD mode and say **“show your brain”**",
  "",
  "Try by voice: “focus on Kepler-442b” · “open the meteor signal from June” · “which notes mention gravitational lensing?”",
  "",
  "## Regenerate",
  "",
  "```bash",
  "npm run demo:vault",
  "```",
  "",
  "Deterministic — same output every run. Edit `scripts/generate-demo-vault.mjs` to reshape it. Everything here is fictional; see [[conventions]].",
].join("\n"));

// --- atlas (written after Home so counts are final) ---
for (const [name, { blurb, links }] of Object.entries(ATLAS)) {
  note(`atlas/${name}.md`, { type: "atlas", tags: ["atlas", "moc"] }, [
    blurb,
    "",
    "## Threads to pull",
    "",
    ...links.map((l) => `- [[${l}]]`),
  ].join("\n"));
}

// ---------- .obsidian (so the vault opens pretty in Obsidian itself) ----------

const PALETTE = {
  bodies: 0x22d3ee, regions: 0x5b8fe8, phenomena: 0xa78bfa, instruments: 0xf5b04a,
  discoveries: 0xf87171, missions: 0x2dd2af, protocols: 0xf472b6,
  glossary: 0x94a3b8, atlas: 0x34d399, _meta: 0xeab308,
};
const obsidian = {
  "app.json": {},
  "appearance.json": { accentColor: "#22d3ee" },
  "core-plugins.json": ["file-explorer", "global-search", "graph", "backlink", "outgoing-link", "page-preview", "command-palette"],
  "graph.json": {
    "collapse-filter": true, search: "", showTags: false, showAttachments: false, hideUnresolved: true,
    showOrphans: true, "collapse-color-groups": false,
    colorGroups: Object.entries(PALETTE).map(([folder, rgb]) => ({ query: `path:${folder}`, color: { a: 1, rgb } })),
    "collapse-display": true, showArrow: false, textFadeMultiplier: 0, nodeSizeMultiplier: 1, lineSizeMultiplier: 1,
    "collapse-forces": true, centerStrength: 0.5, repelStrength: 12, linkStrength: 1, linkDistance: 250, scale: 0.6,
  },
  "workspace.json": {
    main: { id: "root-split", type: "split", children: [{ id: "main-leaf", type: "leaf", state: { type: "markdown", state: { file: "Home.md", mode: "preview" } } }], direction: "vertical" },
    active: "main-leaf",
  },
};

// ---------- validate: every wikilink must resolve (same rules as the app) ----------

function validate() {
  const byTitle = new Map();
  for (const rel of files.keys()) byTitle.set(path.basename(rel, ".md").toLowerCase(), rel);
  const misses = [];
  let resolved = 0;
  const seen = new Set();
  for (const [rel, content] of files) {
    for (const match of content.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const target = match[1].split(/[|#]/)[0].trim().toLowerCase();
      const targetRel = byTitle.get(target);
      if (!targetRel) misses.push(`${rel} -> [[${match[1]}]]`);
      else if (targetRel !== rel) {
        const key = `${rel}->${targetRel}`;
        if (!seen.has(key)) { seen.add(key); resolved += 1; }
      }
    }
  }
  return { misses, resolved };
}

// ---------- write ----------

const { misses, resolved } = validate();
if (misses.length) {
  console.error(`BROKEN LINKS (${misses.length}):`);
  for (const miss of misses) console.error(`  ${miss}`);
  process.exit(1);
}

fs.rmSync(OUT, { recursive: true, force: true });
for (const [rel, content] of files) {
  const full = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}
for (const [name, data] of Object.entries(obsidian)) {
  const full = path.join(OUT, ".obsidian", name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, JSON.stringify(data, null, 2) + "\n");
}

const perFolder = new Map();
for (const rel of files.keys()) {
  const folder = rel.includes("/") ? rel.split("/")[0] : "root";
  perFolder.set(folder, (perFolder.get(folder) ?? 0) + 1);
}
console.log(`Constellation Field Guide -> ${OUT}`);
console.log(`  notes: ${files.size} · resolved links: ${resolved} · broken: 0`);
for (const [folder, count] of [...perFolder.entries()].sort()) console.log(`  ${folder}: ${count}`);
