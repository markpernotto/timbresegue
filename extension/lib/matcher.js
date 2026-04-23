// vibe-engine.js
// Builds a vibe profile from recent tracks and scores candidates against it.

const WEIGHTS = {
  bpm:    3,
  genre:  3,
  era:    2,
  vocal:  2,  // reserved for AcousticBrainz — future
};

const BPM_TOLERANCE = 15;

// Build a vibe profile from the last N tracks in the queue.
// profile is the source of truth for what we're trying to match.
function buildVibeProfile(tracks) {
  const withBPM = tracks.filter(t => t.bpm && t.bpm > 0);

  const avgBPM = withBPM.length > 0
    ? Math.round(withBPM.reduce((sum, t) => sum + t.bpm, 0) / withBPM.length)
    : null;

  // Collect all genres, count frequency, keep ordered by prevalence
  const genreCount = {};
  for (const t of tracks) {
    for (const g of (t.genreNames ?? [])) {
      if (g === "Music" || g === "Música") continue; // Apple always includes this, useless
      genreCount[g] = (genreCount[g] ?? 0) + 1;
    }
  }
  const genres = Object.entries(genreCount)
    .sort((a, b) => b[1] - a[1])
    .map(([g]) => g);

  // Decade bucketing for era matching
  const decades = tracks
    .filter(t => t.releaseDate)
    .map(t => Math.floor(new Date(t.releaseDate).getFullYear() / 10) * 10);
  const dominantDecade = decades.length > 0
    ? mode(decades)
    : null;

  // Primary artists only (first name before comma or "&") — avoid over-excluding features
  const recentArtists = new Set(
    tracks.map(t => t.artistName?.split(/[,&]/)[0].trim().toLowerCase()).filter(Boolean)
  );

  return {
    avgBPM,
    bpmMin: avgBPM ? avgBPM - BPM_TOLERANCE : null,
    bpmMax: avgBPM ? avgBPM + BPM_TOLERANCE : null,
    genres,
    primaryGenre: genres[0] ?? null,
    dominantDecade,
    recentArtists,
    // The artist name of the most recent track — used to steer Deezer search
    seedArtist: tracks[tracks.length - 1]?.artistName ?? null,
  };
}

// Maps user-facing genre labels to the tags Apple Music actually uses
const GENRE_ALIASES = {
  "indie":        ["alternative", "indie rock", "indie pop", "indie folk", "alternative rock", "indie folk", "chamber pop"],
  "alternative":  ["alternative", "alternative rock", "indie rock", "indie pop", "post-punk", "new wave", "grunge"],
  "electronic":   ["electronic", "electronica", "dance", "house", "techno", "ambient", "synth-pop", "idm", "downtempo"],
  "dance":        ["dance", "electronic", "electronica", "house", "disco", "edm"],
  "house":        ["house", "dance", "electronic", "electronica", "deep house", "tech house"],
  "techno":       ["techno", "electronic", "electronica", "dance", "industrial"],
  "pop":          ["pop", "pop/rock", "synth-pop", "teen pop", "k-pop", "j-pop", "electropop"],
  "hip-hop/rap":  ["hip-hop/rap", "hip-hop", "rap", "old school rap", "gangsta rap", "west coast rap", "east coast rap", "underground rap", "trap", "conscious rap"],
  "r&b/soul":     ["r&b/soul", "r&b", "soul", "funk", "motown", "neo-soul", "contemporary r&b"],
  "rock":         ["rock", "alternative rock", "hard rock", "classic rock", "arena rock", "pop/rock", "psychedelic", "progressive rock", "punk"],
  "country":      ["country", "country & folk", "americana", "bluegrass", "folk", "singer/songwriter", "country pop"],
  "jazz":         ["jazz", "contemporary jazz", "smooth jazz", "jazz/blues", "big band", "bebop", "fusion", "blues"],
  "classical":    ["classical", "orchestral", "chamber music", "opera", "contemporary classical", "soundtrack"],
  "reggae":       ["reggae", "dancehall", "ska", "dub"],
  "latin":        ["latin", "urbano latino", "reggaeton", "latin pop", "salsa", "bachata", "cumbia", "bossa nova"],
  "metal":        ["metal", "heavy metal", "hard rock", "alternative metal", "death metal", "black metal", "thrash metal", "rock"],
  "blues":        ["blues", "jazz/blues", "rhythm and blues", "soul", "r&b/soul", "country & folk"],
  "folk":         ["folk", "contemporary folk", "folk-rock", "singer/songwriter", "country & folk", "americana", "country"],
  "singer/songwriter": ["singer/songwriter", "folk", "contemporary folk", "acoustic", "adult contemporary", "americana"],
  "funk":         ["funk", "r&b/soul", "soul", "disco", "neo-soul", "contemporary r&b"],
  "k-pop":        ["k-pop", "korean pop", "pop", "j-pop", "electropop"],
  "disco":        ["disco", "dance", "electronic", "funk", "soul", "electronica"],
};

function expandGenre(genre) {
  const key = genre.toLowerCase();
  return GENRE_ALIASES[key] ?? [key];
}

// Tighter genre sets used only for hard-exclusion when the user has explicitly forced a genre.
// These omit broad crossover tags (e.g. "soul", "dance", "adult contemporary") that would let
// clearly wrong-genre tracks through while still catching genuine variants of that genre.
const GENRE_CORE = {
  "indie":        ["alternative", "indie rock", "indie pop", "indie folk", "alternative rock", "chamber pop"],
  "alternative":  ["alternative", "alternative rock", "indie rock", "post-punk", "new wave", "grunge"],
  "electronic":   ["electronic", "electronica", "synth-pop", "idm", "downtempo", "ambient"],
  "dance":        ["dance", "house", "edm", "electronic", "electronica"],
  "house":        ["house", "deep house", "tech house", "electronic", "dance"],
  "techno":       ["techno", "electronic", "electronica", "industrial", "dance", "house", "edm"],
  "pop":          ["pop", "pop/rock", "synth-pop", "teen pop", "k-pop", "j-pop", "electropop"],
  "hip-hop/rap":  ["hip-hop/rap", "hip-hop", "rap", "trap", "underground rap", "gangsta rap", "west coast rap", "east coast rap", "old school rap", "conscious rap", "hardcore rap", "southern rap", "crunk", "bounce"],
  "r&b/soul":     ["r&b/soul", "r&b", "soul", "neo-soul", "contemporary r&b", "motown"],
  "rock":         ["rock", "alternative rock", "hard rock", "classic rock", "punk", "pop/rock", "arena rock"],
  "country":      ["country", "country & folk", "americana", "bluegrass", "country pop", "urban cowboy", "outlaw country", "contemporary country"],
  "jazz":         ["jazz", "contemporary jazz", "smooth jazz", "jazz/blues", "big band", "bebop", "fusion"],
  "classical":    ["classical", "orchestral", "chamber music", "opera", "contemporary classical", "soundtrack"],
  "reggae":       ["reggae", "dancehall", "ska", "dub"],
  "latin":        ["latin", "urbano latino", "reggaeton", "latin pop", "salsa", "bachata", "cumbia"],
  "metal":        ["metal", "heavy metal", "alternative metal", "death metal", "black metal", "thrash metal"],
  "blues":        ["blues", "jazz/blues", "rhythm and blues"],
  "folk":         ["folk", "contemporary folk", "folk-rock", "singer/songwriter", "country & folk"],
  "singer/songwriter": ["singer/songwriter", "folk", "contemporary folk", "americana"],
  "funk":         ["funk", "r&b/soul", "soul", "disco"],
  "k-pop":        ["k-pop", "korean pop", "j-pop"],
  // Apple Music has no standalone Disco genre — disco tracks are tagged "Dance".
  // "funk" included because many classic disco tracks carry that tag too.
  "disco":        ["disco", "dance", "funk"],
};

function expandGenreCore(genre) {
  const key = genre.toLowerCase();
  return GENRE_CORE[key] ?? GENRE_ALIASES[key] ?? [key];
}

// Score a candidate Apple Music track against a vibe profile.
// Higher is better. Returns -1 if candidate should be excluded.
function scoreCandidate(candidate, profile, alreadyQueued = new Set()) {
  // Hard exclusions
  if (alreadyQueued.has(candidate.id)) return -1;
  const candidateArtistLower = candidate.artistName?.toLowerCase() ?? "";
  const artistOverlap = [...profile.recentArtists].some(a => candidateArtistLower.includes(a));
  if (artistOverlap) return -1;

  let score = 0;

  // BPM match — only penalize if we have BPM data and it's out of range
  if (profile.avgBPM && candidate.bpm && candidate.bpm > 0) {
    const bpmDelta = Math.abs(candidate.bpm - profile.avgBPM);
    if (bpmDelta <= BPM_TOLERANCE) {
      score += WEIGHTS.bpm * (1 - bpmDelta / BPM_TOLERANCE);
    } else {
      score -= 1;
    }
  }

  // Genre overlap — expand profile genres to include Apple Music aliases.
  // Capped at WEIGHTS.genre: a genre match is a genre match, tracks with many tags
  // (e.g. Björk) shouldn't outscore tracks with fewer tags just because of tag count.
  const candidateGenres = (candidate.genreNames ?? []).map(g => g.toLowerCase());
  const profileExpanded = profile.genres.flatMap(g => expandGenre(g));
  const overlap = candidateGenres.filter(g => profileExpanded.includes(g)).length;
  score += overlap > 0 ? WEIGHTS.genre : 0;

  // When a genre is explicitly forced, require overlap with the *core* (tight) alias set —
  // not the full scoring aliases, which are too broad (e.g. "dance" matching non-disco tracks).
  if (profile.forcedGenre) {
    const coreAliases = expandGenreCore(profile.forcedGenre);
    const forcedOverlap = candidateGenres.filter(g => coreAliases.includes(g)).length;
    if (forcedOverlap === 0) return -1;

    // Ambient tracks are sleep/drone/nature sounds — never appropriate for rhythmic
    // dance genres even if they carry a broad "Electronic" tag (which is in the core
    // alias list for House, Techno, Dance, etc.).
    const RHYTHMIC_GENRES = new Set(["house", "techno", "dance", "disco", "electronic", "hip-hop/rap", "metal", "rock", "alternative", "indie", "pop", "funk", "latin", "reggae", "k-pop"]);
    if (RHYTHMIC_GENRES.has(profile.forcedGenre.toLowerCase()) && candidateGenres.includes("ambient")) {
      return -1;
    }
  }

  // Era match
  if (candidate.releaseDate) {
    const candidateYear    = new Date(candidate.releaseDate).getFullYear();
    const candidateDecade  = Math.floor(candidateYear / 10) * 10;

    if (profile.forcedDecade === "pre1960") {
      // Special sentinel: accept any track before 1960, no specific decade required
      if (candidateYear >= 1960) return -1;
      score += WEIGHTS.era;
    } else if (profile.forcedDecade && profile.dominantDecade) {
      // Locked to a specific decade — hard-exclude anything else
      if (candidateDecade !== profile.dominantDecade) return -1;
      score += WEIGHTS.era;
    } else if (profile.dominantDecade) {
      // Auto era — reward proximity, penalise large gaps.
      // Without a penalty, genre alone (3 pts) passes the threshold even for tracks
      // that are 40 years off. "Bad" (1980s) shouldn't queue during a 2020s session.
      const eraDiff = Math.abs(candidateDecade - profile.dominantDecade);
      if      (eraDiff === 0)  score += WEIGHTS.era;  // +2 same decade
      else if (eraDiff === 10) score += 1;             // +1 adjacent decade
      else if (eraDiff >= 40)  score -= 2;             // −2 four+ decades off
      else if (eraDiff >= 30)  score -= 1;             // −1 three decades off
    }
  }

  return score;
}

function mode(arr) {
  const count = {};
  for (const v of arr) count[v] = (count[v] ?? 0) + 1;
  return Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

export { buildVibeProfile, scoreCandidate, expandGenreCore };
