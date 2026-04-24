// content-script.js
// Runs in Safari's isolated world.
// page-bridge.js (MAIN world) handles MusicKit access and communicates via postMessage.
// All API calls (Deezer, Apple Music catalog) happen directly here.

import { buildVibeProfile, scoreCandidate } from "../lib/matcher.js";

const PREFIX       = "AML_";
const VIBE_WINDOW  = 5;
const QUEUE_AHEAD  = 3;

let debugMode = false;
function log(...args) { if (debugMode) console.log(...args); }

let recentTracks    = [];
let alreadyQueued     = new Set(); // track IDs already queued this session
let queuedArtists     = new Set(); // primary artists already queued this session
let playedThisSession = new Set(); // track IDs that have actually played — never re-queued
let radioSeedQueue  = [];        // artist Deezer IDs to rotate through for radio calls
let upNextList      = [];        // ordered list of queued tracks for popup display
let intercepting    = true;
let currentProfile = null;
let userOverrides  = {};
let pageTokens     = null;
let working              = false; // prevent concurrent recommendation runs
let lastQueuedAt         = 0;    // timestamp of last successful playNext() — gates rapid re-fires
let enrichmentPending    = false; // true while Deezer + MusicBrainz calls are in-flight for current track
let enrichmentUntil      = 0;    // safety fallback — unblocks if APIs never respond
let enrichmentGeneration = 0;    // increments each track change; stale callbacks self-cancel
const QUEUE_COOLDOWN_MS      = 6000;
const ENRICHMENT_TIMEOUT_MS  = 10000; // max wait for enrichment before giving up

// Write the current vibe + up-next list to storage so the popup can poll it
// without relying on message-passing timing (chrome.runtime.sendMessage is unreliable in Safari).
function saveUpNext() {
  chrome.storage.local.set({ upNextList: upNextList.slice() })
    .catch(() => {}); // Safari dev-mode quota can be very small — fail silently
}

// When Deezer has no BPM data, use the midpoint of the genre's typical range as a display
// estimate. Not used for candidate fetching (that uses the full range); only for scoring
// and showing something useful in the popup instead of "—".
function genreEstimatedBPM(genre) {
  if (!genre) return null;
  const range = GENRE_BPM_RANGES[genre.toLowerCase()];
  return range ? Math.round((range[0] + range[1]) / 2) : null;
}

function buildProfile() {
  const raw = buildVibeProfile(recentTracks);
  const estimatedBPM = raw.avgBPM ? null : genreEstimatedBPM(raw.primaryGenre);
  return { ...raw, ...userOverrides, estimatedBPM };
}

function saveVibeProfile() {
  if (!currentProfile) return;
  chrome.storage.local.set({
    vibeProfile: {
      avgBPM:         currentProfile.avgBPM,
      estimatedBPM:   currentProfile.estimatedBPM ?? null,
      primaryGenre:   currentProfile.primaryGenre,
      dominantDecade: currentProfile.dominantDecade,
    },
  }).catch(() => {}); // Safari dev-mode quota can be very small — fail silently
}

// --- Deezer API (via background service worker — avoids CORS) ---

function getDeezerTrack(isrc) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: "GET_DEEZER_TRACK", isrc }, r => {
      resolve(r?.error ? null : r);
    });
  });
}

const _mbCache = new Map(); // isrc → date string (or null); avoids double-fetching queued tracks

function getMBFirstRelease(isrc) {
  if (_mbCache.has(isrc)) return Promise.resolve(_mbCache.get(isrc));
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: "GET_MB_FIRST_RELEASE", isrc }, r => {
      const date = r?.date ?? null;
      _mbCache.set(isrc, date);
      resolve(date);
    });
  });
}

function getDeezerRadio(artistDeezerId) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: "GET_RADIO", artistDeezerId }, r => {
      resolve(Array.isArray(r?.tracks) ? r.tracks : []);
    });
  });
}

function getDeezerSimilarArtistTracks(artistDeezerId, artistLimit = 3, tracksPerArtist = 8) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: "GET_SIMILAR_ARTIST_TRACKS", artistDeezerId, artistLimit, tracksPerArtist }, r => {
      resolve(Array.isArray(r) ? r : []);
    });
  });
}

function searchDeezerByBPM(bpmMin, bpmMax, genre = null) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: "GET_BPM_SEARCH", bpmMin, bpmMax, genre }, r => {
      resolve(Array.isArray(r) ? r : []);
    });
  });
}

function searchDeezerByBPMWide(bpmMin, bpmMax) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: "GET_BPM_SEARCH_WIDE", bpmMin, bpmMax }, r => {
      resolve(Array.isArray(r) ? r : []);
    });
  });
}

// --- Apple Music catalog (uses tokens from page bridge) ---

// Maps user-facing genre names to Apple Music genre IDs.
// Used to pull chart songs that are guaranteed to have correct Apple Music genre tags.
const AM_GENRE_IDS = {
  "blues":         2,
  "classical":     5,
  "country":       6,
  "electronic":    7,
  "house":         7,
  "techno":        7,
  "singer/songwriter": 10,
  "folk":          10,
  "jazz":          11,
  "latin":         12,
  "pop":           14,
  "k-pop":         51,
  "r&b/soul":      15,
  "funk":          15,
  "disco":         17,
  "dance":         17,
  "hip-hop/rap":   18,
  "alternative":   20,
  "indie":         20,
  "rock":          21,
  "reggae":        24,
  "metal":         1153,
};

// Typical BPM ranges per genre — used when avgBPM is null (Deezer couldn't find the playing tracks).
// Keeps the BPM search in the right tempo neighbourhood instead of defaulting to 60–190.
const GENRE_BPM_RANGES = {
  "techno":       [128, 150],
  "house":        [120, 135],
  "dance":        [118, 138],
  "electronic":   [110, 145],
  "disco":        [100, 130],
  "funk":         [90,  120],
  "hip-hop/rap":  [75,  105],
  "r&b/soul":     [65,  100],
  "pop":          [90,  130],
  "rock":         [110, 160],
  "metal":        [140, 220],
  "reggae":       [60,  90],
  "classical":    [60,  110],
  "jazz":         [90,  140],
  "blues":        [70,  110],
  "country":      [95,  135],
  "latin":        [90,  140],
  "alternative":  [110, 150],
  "indie":        [100, 140],
  "folk":         [80,  120],
  "singer/songwriter": [75, 115],
  "k-pop":        [110, 140],
  "techno":       [125, 150],
};

// Genre-specific Deezer search phrases — used when genre is forced to supplement the neutral
// BPM-wide search with genre-targeted candidates.
// Multi-word phrases ("deep house", "heavy metal") are much more genre-specific than bare
// genre names ("house", "metal"), which would match unrelated song titles.
// Genres where the name is too generic (pop, country) are omitted — the Apple Music chart
// and neutral BPM search already provide plenty of those candidates.
const GENRE_SEARCH_TERMS = {
  "house":        "deep house",
  "techno":       "techno",
  "electronic":   "electronic",
  "dance":        "dance music",
  "disco":        "disco",
  "funk":         "funk",
  "hip-hop/rap":  "hip hop",
  "r&b/soul":     "rnb soul",
  "rock":         "rock music",
  "metal":        "heavy metal",
  "jazz":         "jazz",
  "reggae":       "reggae",
  "alternative":  "alternative rock",
  "indie":        "indie music",
  "blues":        "blues music",
};

// Fetch Apple Music genre chart — songs are guaranteed to carry correct Apple Music genre tags.
// Cheaper than resolveISRC per-candidate: one call returns up to `limit` fully-attributed songs.
async function getAppleMusicGenreChart(genreId, limit = 25, offset = 0) {
  if (!pageTokens?.dev) return [];
  const storefront = pageTokens.storefront ?? "us";
  const url = `https://api.music.apple.com/v1/catalog/${storefront}/charts?types=songs&genre=${genreId}&limit=${limit}&offset=${offset}`;
  const res = await fetch(url, {
    headers: {
      "Authorization":    `Bearer ${pageTokens.dev}`,
      "Music-User-Token": pageTokens.user,
    }
  });
  const data = await res.json();
  return (data.results?.songs?.[0]?.data ?? []).map(song => ({
    id:          song.id,
    title:       song.attributes?.name,
    artistName:  song.attributes?.artistName,
    albumName:   song.attributes?.albumName,
    genreNames:  song.attributes?.genreNames ?? [],
    releaseDate: song.attributes?.releaseDate,
    isrc:        song.attributes?.isrc,
    bpm:         null,
    _raw:        song,   // raw API object — passed to page-bridge for queue insertion (avoids CORS)
  }));
}


async function resolveISRC(isrc) {
  if (!pageTokens?.dev) return null;
  const url = `https://api.music.apple.com/v1/catalog/${pageTokens.storefront ?? "us"}/songs?filter[isrc]=${isrc}`;
  const res = await fetch(url, {
    headers: {
      "Authorization":    `Bearer ${pageTokens.dev}`,
      "Music-User-Token": pageTokens.user,
    }
  });
  const data = await res.json();
  const song = data.data?.[0];
  if (!song) return null;
  return {
    id:          song.id,
    title:       song.attributes?.name,
    artistName:  song.attributes?.artistName,
    albumName:   song.attributes?.albumName,
    genreNames:  song.attributes?.genreNames ?? [],
    releaseDate: song.attributes?.releaseDate,
    isrc:        song.attributes?.isrc,
    _raw:        song,   // raw API object — passed to page-bridge for queue insertion (avoids CORS)
  };
}

// Apple Music catalog search — much broader variety than the top-25 chart,
// and returns real Apple-tagged tracks (no Deezer→Apple genre round-trip needed).
async function searchAppleMusicByTerm(term, limit = 25, offset = 0) {
  if (!pageTokens?.dev || !term) return [];
  const storefront = pageTokens.storefront ?? "us";
  const url = `https://api.music.apple.com/v1/catalog/${storefront}/search?types=songs&limit=${limit}&offset=${offset}&term=${encodeURIComponent(term)}`;
  const res = await fetch(url, {
    headers: { "Authorization": `Bearer ${pageTokens.dev}`, "Music-User-Token": pageTokens.user },
  });
  const data = await res.json();
  return (data.results?.songs?.data ?? []).map(song => ({
    id:          song.id,
    title:       song.attributes?.name,
    artistName:  song.attributes?.artistName,
    albumName:   song.attributes?.albumName,
    genreNames:  song.attributes?.genreNames ?? [],
    releaseDate: song.attributes?.releaseDate,
    isrc:        song.attributes?.isrc,
    bpm:         null,
    _raw:        song,
  }));
}

// Fallback enrichment when ISRC is missing — title+artist catalog search.
async function searchCatalog(term) {
  if (!pageTokens?.dev || !term) return [];
  const url = `https://api.music.apple.com/v1/catalog/${pageTokens.storefront ?? "us"}/search?types=songs&limit=5&term=${encodeURIComponent(term)}`;
  const res = await fetch(url, {
    headers: {
      "Authorization":    `Bearer ${pageTokens.dev}`,
      "Music-User-Token": pageTokens.user,
    }
  });
  const data = await res.json();
  return (data.results?.songs?.data ?? []).map(song => ({
    id:          song.id,
    title:       song.attributes?.name,
    artistName:  song.attributes?.artistName,
    genreNames:  song.attributes?.genreNames ?? [],
    releaseDate: song.attributes?.releaseDate,
    isrc:        song.attributes?.isrc,
  }));
}

// --- Core recommendation pipeline ---

async function queueNextVibeTrack() {
  if (!currentProfile || !pageTokens || working) {
    if (working)          log("[TS] Recommendation skipped — previous fetch still running");
    else if (!pageTokens) log("[TS] Recommendation skipped — no page tokens yet");
    else                  log("[TS] Recommendation skipped — no profile yet");
    return;
  }
  working = true;
  let queued = false;
  log("[TS] Recommendation starting...");
  lastQueuedAt = Date.now(); // stamp immediately — blocks rapid re-fires even if no winner found

  try {
    const seedTrack = recentTracks[recentTracks.length - 1];
    const fallbackSeedId = userOverrides.pinnedArtistDeezerId ?? seedTrack?.artistDeezerId;

    let scored = [];
    let verified = [];
    const bpmOffset = userOverrides.bpmOffset ?? 0;
    const fg = userOverrides.forcedGenre ?? null;
    const fd = userOverrides.forcedDecade ?? null;

    const profileForScoring = {
      ...currentProfile,
      recentArtists: new Set([...currentProfile.recentArtists, ...queuedArtists]),
      // Use real Deezer BPM when available; fall back to genre-estimated midpoint so
      // scoring can still award BPM points even when Deezer has no data for this track.
      avgBPM:  currentProfile.avgBPM != null
                 ? currentProfile.avgBPM + bpmOffset
                 : currentProfile.estimatedBPM != null
                   ? currentProfile.estimatedBPM + bpmOffset
                   : null,
      bpmMin:  currentProfile.bpmMin != null ? currentProfile.bpmMin + bpmOffset : null,
      bpmMax:  currentProfile.bpmMax != null ? currentProfile.bpmMax + bpmOffset : null,

      // When genre is forced, it IS the intent — ignore detected genres from recent tracks entirely.
      // When auto, use whatever the last N tracks suggest.
      primaryGenre: fg ?? currentProfile.primaryGenre,
      genres:       fg ? [fg] : currentProfile.genres,
      forcedGenre:  fg,

      // Era: explicit forced decade steers scoring toward that decade.
      // When genre is also forced, drop the hard era gate — the genre chart only returns
      // current songs, so hard era exclusion + forced genre = nothing ever queues.
      // Era still scores as a preference (dominantDecade) so 90s country scores higher than 2020s country.
      // When era is forced to pre1960 and genre is also forced (so era is soft-only),
      // use 1950 as the soft-scoring anchor so pre-1960 tracks score higher
      // than tracks from 2020. Without this, the anchor falls back to the detected
      // listening history decade (likely 2010s), which makes pre1960 preference invisible.
      dominantDecade: fd && fd !== "pre1960" ? fd : fd === "pre1960" ? 1950 : currentProfile.dominantDecade,
      forcedDecade:   fg ? null : fd,
    };
    const scoreThreshold = userOverrides.scoreThreshold ?? 3;

    // BPM search range: real BPM from profile first, then genre-typical range (forced or
    // auto-detected), then wide fallback. Genre-specific ranges prevent a 60–190 sweep
    // when Deezer has no BPM data for niche/new releases.
    const activeGenre   = fg ?? profileForScoring.primaryGenre ?? null;
    const genreBpmRange = activeGenre ? GENRE_BPM_RANGES[activeGenre.toLowerCase()] ?? null : null;
    const baseBpmMin = profileForScoring.bpmMin ?? (genreBpmRange?.[0] ?? 90);
    const baseBpmMax = profileForScoring.bpmMax ?? (genreBpmRange?.[1] ?? 160);
    const searchMin  = baseBpmMin;
    const searchMax  = baseBpmMax;

    // Apple Music chart + search — fire for the active genre (forced OR auto-detected).
    // Chart = top tracks in the genre; search = broader variety. Random offsets keep
    // successive sessions from returning the same 25 tracks over and over.
    const activeGenreId = activeGenre ? AM_GENRE_IDS[activeGenre.toLowerCase()] ?? null : null;
    const chartOffset   = Math.floor(Math.random() * 100);
    const searchOffset  = Math.floor(Math.random() * 100);
    // When era is forced, append the decade label to bias Apple Music search toward
    // era-authentic tracks — e.g. "disco 1970s" pulls classic disco, not modern dance.
    const decadeSuffix  = (fd && fd !== "pre1960") ? ` ${fd}s` : (fd === "pre1960" ? " classic" : "");
    const amSearchTerm  = activeGenre ? `${GENRE_SEARCH_TERMS[activeGenre.toLowerCase()] ?? activeGenre}${decadeSuffix}` : null;

    const [chartRaw, amSearchCandidates] = await Promise.all([
      activeGenreId ? getAppleMusicGenreChart(activeGenreId, 50, chartOffset).catch(e => { log("[TS] Chart fetch failed:", e?.message); return []; }) : Promise.resolve([]),
      amSearchTerm  ? searchAppleMusicByTerm(amSearchTerm, 25, searchOffset).catch(e => { log("[TS] AM search failed:", e?.message); return []; }) : Promise.resolve([]),
    ]);
    const chartCandidates = chartRaw.sort(() => Math.random() - 0.5);

    // Deezer fallback sources — kept as a safety net but now secondary to Apple Music.
    // Note: Deezer's /genre/{id}/radio endpoint was removed (returns 600 error for all IDs).
    const genreSearchTerm = activeGenre ? GENRE_SEARCH_TERMS[activeGenre.toLowerCase()] ?? null : null;
    const [bpmCandidates, genreCandidates] = await Promise.all([
      searchDeezerByBPMWide(searchMin, searchMax),
      genreSearchTerm ? searchDeezerByBPM(searchMin, searchMax, 50, genreSearchTerm) : Promise.resolve([]),
    ]);
    log(`[TS] Candidate pool — AM chart: ${chartCandidates.length}, AM search: ${amSearchCandidates.length}, Deezer genre: ${genreCandidates.length}, Deezer BPM: ${bpmCandidates.length}`);

    // When genre is forced, only exclude by track ID (not by artist) — the genre chart
    // has limited artists and artist-exclusion quickly starves the pool.
    const excludedArtists = profileForScoring.forcedGenre
      ? new Set([...currentProfile.recentArtists])
      : new Set([...currentProfile.recentArtists, ...queuedArtists]);

    profileForScoring.recentArtists = excludedArtists;

    // Up to 5 attempts. When genre is locked, skip artist radio — the current artist's
    // neighbours are unlikely to match a different genre.
    const useRadio = !userOverrides.forcedGenre;
    for (let attempt = 0; attempt < 5 && !scored.length; attempt++) {
      const seedArtistId = radioSeedQueue.length > 0 ? radioSeedQueue[0] : fallbackSeedId;

      let candidates = [...chartCandidates, ...amSearchCandidates, ...genreCandidates, ...bpmCandidates];
      if (useRadio && attempt === 0 && seedArtistId) {
        // Two parallel artist-seeded sources: radio (Deezer's curated mix) and similar-artists
        // top tracks (3 related artists × their top 8). Similar-artists gives much stronger
        // "new discovery within the genre" signal than radio, which tends to pull hits of the
        // seed artist themselves. Both still get filtered by BPM/era/genre below.
        const [radioTracks, similarTracks] = await Promise.all([
          getDeezerRadio(seedArtistId),
          getDeezerSimilarArtistTracks(seedArtistId, 3, 8),
        ]);
        log(`[TS] Artist-seeded — radio: ${radioTracks.length}, similar-artist top tracks: ${similarTracks.length}`);
        candidates = [...candidates, ...radioTracks, ...similarTracks];
      }

      if (!candidates.length) continue;

      // Deduplicate by id (chart songs) or ISRC (Deezer songs) before resolving
      const seenIds   = new Set();
      const seenISRCs = new Set();
      const unique = candidates.filter(c => {
        if (c.id  && seenIds.has(c.id))     return false;
        if (c.isrc && seenISRCs.has(c.isrc)) return false;
        if (c.id)   seenIds.add(c.id);
        if (c.isrc) seenISRCs.add(c.isrc);
        return true;
      });

      // Chart songs already have Apple Music attributes — no ISRC resolution needed.
      // Deezer-only candidates still need resolution to get Apple Music genre tags.
      // Each resolveISRC call is isolated — a single network blip skips that candidate
      // rather than aborting the whole recommendation attempt.
      verified = [];
      for (const c of unique.sort(() => Math.random() - 0.5).slice(0, 20)) {
        if (c.genreNames?.length) {
          verified.push(c);  // already resolved (chart song)
        } else if (c.isrc) {
          try {
            const track = await resolveISRC(c.isrc);
            if (track) verified.push({ ...track, artistDeezerId: c.artistDeezerId ?? null });
          } catch {
            // skip — transient network failure on this ISRC
          }
        }
      }

      const withScores = verified.map(t => ({ ...t, score: scoreCandidate(t, profileForScoring, alreadyQueued) }));
      if (debugMode && verified.length) {
        const dist = withScores.reduce((acc, t) => { acc[t.score] = (acc[t.score] || 0) + 1; return acc; }, {});
        log(`[TS] Score distribution (${verified.length} verified, threshold ${scoreThreshold}):`, JSON.stringify(dist));
      }
      scored = withScores.filter(t => t.score >= scoreThreshold).sort((a, b) => b.score - a.score);

      if (!scored.length && radioSeedQueue.length > 0) radioSeedQueue.shift();
    }

    // Pool exhaustion rescue — runs only when genre is forced and all scored candidates
    // were blocked by artist exclusion. Strip recentArtists (allow repeats) but keep
    // alreadyQueued so we never insert the same track ID twice in a session.
    if (!scored.length && profileForScoring.forcedGenre && verified.length > 0) {
      const rescueProfile = { ...profileForScoring, recentArtists: new Set() };
      scored = verified
        .map(t => ({ ...t, score: scoreCandidate(t, rescueProfile, alreadyQueued) }))
        .filter(t => t.score >= scoreThreshold)
        .sort((a, b) => b.score - a.score);
      if (scored.length) {
        log(`[TS] Pool exhaustion rescue — relaxing artist exclusion (${scored.length} candidates recovered)`);
      }
    }

    // Threshold fallback — step down by 1 until something passes.
    // In forced-genre mode: GENRE_CORE already hard-excludes wrong-genre tracks (-1),
    // so anything scoring ≥ 1 is genuinely the right genre, just imperfect era/BPM.
    // Floor is 1 in auto mode, 2 in forced mode (small extra safety margin).
    // effectiveThreshold tracks the actual floor used so the MB verification check below
    // uses the same bar (not the original, stricter scoreThreshold).
    let effectiveThreshold = scoreThreshold;
    if (!scored.length && verified.length > 0 && scoreThreshold > 1) {
      const floor = profileForScoring.forcedGenre ? 2 : 1;
      for (let fallback = scoreThreshold - 1; fallback >= floor && !scored.length; fallback--) {
        scored = verified
          .map(t => ({ ...t, score: scoreCandidate(t, profileForScoring, alreadyQueued) }))
          .filter(t => t.score >= fallback)
          .sort((a, b) => b.score - a.score);
        if (scored.length) {
          effectiveThreshold = fallback;
          log(`[TS] Threshold relaxed to ${fallback} — ${scored.length} candidate(s) recovered`);
        }
      }
    }

    // When genre is forced and threshold fallback also found nothing, skip the slot.
    if (!scored.length && profileForScoring.forcedGenre) {
      log(`[TS] No ${profileForScoring.forcedGenre} candidates — will retry on next track`);
      return;
    }

    // Last resort: drop era constraints, find something genre-adjacent
    if (!scored.length) {
      const open = { ...profileForScoring, primaryGenre: null, genres: [], dominantDecade: null, forcedDecade: null };
      scored = verified
        .map(t => ({ ...t, score: scoreCandidate(t, open, alreadyQueued) }))
        .filter(t => t.score >= 0)
        .sort((a, b) => b.score - a.score);
    }

    if (!scored.length) {
      log("[TS] No candidates at all — skipping this slot");
      return;
    }

    // Verify top candidates against MusicBrainz before committing.
    // Apple Music release dates are often remaster years that mislead era scoring —
    // fetch the real first-release-date for each top candidate in parallel, re-score,
    // and pick the first that still passes. Cache results so the second lookup when
    // the track actually plays is an instant hit.
    const TOP_VERIFY = Math.min(scored.length, effectiveThreshold * 5);
    const mbDates = await Promise.all(
      scored.slice(0, TOP_VERIFY).map(c =>
        c.isrc ? getMBFirstRelease(c.isrc).catch(() => null) : Promise.resolve(null)
      )
    );
    let winner = null;
    for (let i = 0; i < TOP_VERIFY; i++) {
      const c        = scored[i];
      const mbDate   = mbDates[i];
      const verified = mbDate ? { ...c, releaseDate: mbDate } : c;
      const vScore   = mbDate ? scoreCandidate(verified, profileForScoring, alreadyQueued) : c.score;
      if (vScore >= effectiveThreshold) {
        winner = { ...verified, score: vScore };
        if (mbDate && mbDate !== c.releaseDate) {
          log(`[TS] MB pre-verified "${c.title}": ${c.releaseDate} → ${mbDate}`);
        }
        break;
      }
      if (mbDate && vScore !== c.score) {
        log(`[TS] Skipping "${c.title}" — MB date ${mbDate} drops score from ${c.score} to ${vScore}`);
      }
    }
    if (!winner) {
      log("[TS] No candidates passed MB date verification — will retry");
      return;
    }

    const filterDesc = [
      profileForScoring.primaryGenre ?? "Auto",
      `${profileForScoring.dominantDecade ?? "Auto"}s`,
      profileForScoring.avgBPM ? `${Math.round(profileForScoring.avgBPM)} BPM` : null,
    ].filter(Boolean).join(" | ");
    log(`[TS] Queuing: "${winner.title}" by ${winner.artistName} (score: ${winner.score}) [${filterDesc}]`);
    queued = true;
    alreadyQueued.add(winner.id);
    const primaryArtist = winner.artistName?.split(/[,&]/)[0].trim().toLowerCase();
    if (primaryArtist) queuedArtists.add(primaryArtist);
    upNextList.push({
      id: winner.id, title: winner.title, artistName: winner.artistName, score: winner.score,
      genreNames: winner.genreNames ?? [], releaseDate: winner.releaseDate ?? null, bpm: winner.bpm ?? null,
    });
    saveUpNext();

    // Only use high-scoring winners as radio seeds — low scores indicate drift,
    // and propagating them as seeds compounds the problem.
    if (winner.artistDeezerId && winner.score >= 3) radioSeedQueue.push(winner.artistDeezerId);
    if (radioSeedQueue.length > 1) radioSeedQueue.shift(); // consume current seed

    // Tell page bridge to call MusicKit.playNext()
    // Pass the raw API song object so page-bridge can construct MusicKit.MediaItem
    // without calling mk.api.music() — which hits CORS on amp-api.music.apple.com.
    // afterIds: IDs of our tracks already sitting ahead in the queue.
    // page-bridge uses these to find the last one and insert AFTER it,
    // preserving FIFO order so earlier-queued tracks play before later ones.
    window.postMessage({
      type:     `${PREFIX}PLAY_NEXT`,
      id:       winner.id,
      rawSong:  winner._raw ?? null,
      afterIds: upNextList.map(t => t.id),  // tracks ahead of current position (not including winner)
    }, "*");

    // Notify popup
    chrome.runtime.sendMessage({
      type:    "NEXT_RECOMMENDATION",
      track:   winner,
      upNext:  upNextList.slice(),
      profile: {
        avgBPM:         currentProfile.avgBPM,
        primaryGenre:   currentProfile.primaryGenre,
        dominantDecade: currentProfile.dominantDecade,
      },
    });

  } catch (err) {
    console.error("[TS] Recommendation error:", err?.message ?? err);
  } finally {
    working = false;
    if (intercepting) {
      const ourAhead = upNextList.filter(t => alreadyQueued.has(t.id)).length;
      if (queued) {
        // Successfully queued — reset failure counter, fill remaining buffer slots immediately.
        queueNextVibeTrack._consecutiveFailures = 0;
        if (ourAhead < QUEUE_AHEAD) setTimeout(() => queueNextVibeTrack(), 300);
      } else if (ourAhead < QUEUE_AHEAD) {
        // Failed to queue — retry up to 2 times, then give up until the next track.
        const failures = (queueNextVibeTrack._consecutiveFailures ?? 0) + 1;
        queueNextVibeTrack._consecutiveFailures = failures;
        if (failures <= 2) {
          setTimeout(() => queueNextVibeTrack(), QUEUE_COOLDOWN_MS + 500);
        } else {
          log(`[TS] No candidates after ${failures} attempts — waiting for next track`);
          queueNextVibeTrack._consecutiveFailures = 0;
        }
      }
    }
  }
}

// --- Queue cleanup ---

// Re-score every track in upNextList against the current profile.
// Removes any that score below 1 — catches tracks queued during a brief enrichment
// window when dates weren't corrected yet (e.g. "Feather" by Sabrina Carpenter
// slipping into a 1970s R&B session because it was queued before MusicBrainz returned).
function evictStaleQueuedTracks() {
  if (!currentProfile || !upNextList.length) return;

  const cleanupProfile = {
    ...currentProfile,
    primaryGenre:   userOverrides.forcedGenre ?? currentProfile.primaryGenre,
    genres:         userOverrides.forcedGenre ? [userOverrides.forcedGenre] : currentProfile.genres,
    forcedGenre:    userOverrides.forcedGenre ?? null,
    dominantDecade: userOverrides.forcedDecade && userOverrides.forcedDecade !== "pre1960"
      ? userOverrides.forcedDecade : currentProfile.dominantDecade,
    forcedDecade:   userOverrides.forcedGenre ? null : (userOverrides.forcedDecade ?? null),
    recentArtists:  new Set(), // don't penalise artists during cleanup scoring
    avgBPM:         currentProfile.avgBPM != null ? currentProfile.avgBPM + (userOverrides.bpmOffset ?? 0) : null,
  };

  const staleIds = upNextList
    .filter(t => scoreCandidate(t, cleanupProfile, new Set()) < 1)
    .map(t => t.id);

  if (!staleIds.length) return;

  const staleSet = new Set(staleIds);
  log(`[TS] Evicting ${staleIds.length} stale queued track(s) after profile update:`,
    upNextList.filter(t => staleSet.has(t.id)).map(t => t.title).join(", "));
  window.postMessage({ type: `${PREFIX}CLEAR_QUEUED`, ids: staleIds }, "*");
  staleIds.forEach(id => alreadyQueued.delete(id)); // allow re-queueing if a better slot opens
  upNextList = upNextList.filter(t => !staleSet.has(t.id));
  saveUpNext();
}

// --- Event handlers ---

async function onNowPlayingChanged(track) {
  if (!track) return;

  // New track = fresh start for the retry counter.
  queueNextVibeTrack._consecutiveFailures = 0;

  // Look up catalog metadata from Apple Music — MusicKit doesn't expose ISRC or genres
  // for library-owned tracks (id starts with "i."), which kills Deezer/MusicBrainz lookups
  // for the now-playing song. Fall back to title+artist search and pull BOTH genres AND
  // ISRC from the catalog match.
  let genres = track.genreNames ?? [];
  let resolvedISRC = track.isrc ?? null;
  if ((!genres.length || genres.every(g => g === "Music") || !resolvedISRC) && pageTokens) {
    let catalogTrack = null;
    if (resolvedISRC) catalogTrack = await resolveISRC(resolvedISRC);
    if (!catalogTrack && track.title && track.artistName) {
      const hits = await searchCatalog(`${track.title} ${track.artistName}`);
      catalogTrack = hits.find(h => h.artistName?.toLowerCase() === track.artistName.toLowerCase()) ?? hits[0] ?? null;
    }
    if (catalogTrack?.genreNames?.length) genres = catalogTrack.genreNames;
    if (catalogTrack?.isrc && !resolvedISRC) resolvedISRC = catalogTrack.isrc;
  }

  const enriched = { ...track, isrc: resolvedISRC, genreNames: genres, bpm: null };
  log(`[TS] Now playing: "${track.title}" — ${track.artistName}  ISRC: ${resolvedISRC ?? "—"}  Genres: ${genres.join(", ")}`);

  if (track.id) playedThisSession.add(track.id);
  recentTracks.push(enriched);
  if (recentTracks.length > VIBE_WINDOW) recentTracks.shift();

  // Grab the pre-verified MB date (if AML queued this track) before removing from upNextList.
  // Avoids a redundant MusicBrainz round-trip for tracks we already looked up as candidates.
  const queuedEntry  = upNextList.find(t => t.id === track.id);
  const knownMBDate  = queuedEntry?.releaseDate ?? null;

  // Remove this track from the up-next list if it just started playing
  upNextList = upNextList.filter(t => t.id !== track.id);
  saveUpNext();

  currentProfile = buildProfile();
  saveVibeProfile();

  // Block recommendations until both Deezer (BPM) and MusicBrainz (original release year)
  // have responded. enrichmentPending is the primary gate — cleared only when both APIs
  // return (or fail). enrichmentUntil is a safety fallback so a hung API can't block forever.
  // enrichmentGeneration prevents a stale callback from a previous track from clearing the
  // pending flag mid-enrichment of the current track (race condition when tracks change fast).
  const myGeneration = ++enrichmentGeneration;
  enrichmentPending  = true;
  enrichmentUntil    = Date.now() + ENRICHMENT_TIMEOUT_MS;
  if (resolvedISRC) {
    // If AML queued this track, knownMBDate is already the pre-verified first-release-date.
    // Skip the MB network call; only call for tracks Apple Music inserted (manual plays, etc.).
    const mbPromise = knownMBDate
      ? Promise.resolve(knownMBDate)
      : getMBFirstRelease(resolvedISRC);
    Promise.all([
      getDeezerTrack(resolvedISRC),
      mbPromise,
    ]).then(([deezer, mbDate]) => {
      // A newer track started while we were waiting — don't touch shared state.
      if (myGeneration !== enrichmentGeneration) return;

      if (deezer?.bpm) {
        enriched.bpm            = deezer.bpm;
        enriched.deezerId       = deezer.deezerId;
        enriched.artistDeezerId = deezer.artistDeezerId;
      }
      // MusicBrainz first-release-date overrides Apple Music's releaseDate, which
      // returns the remaster year for catalog reissues and poisons era detection.
      // e.g. "Bad" (1987) has ISRC USSM11204980 (2012 remaster) → AM says 2012,
      // MusicBrainz says 1987. We always prefer MB when available.
      if (mbDate && mbDate !== track.releaseDate) {
        enriched.releaseDate = mbDate;
        // (silent — profile correction, no need to surface this to console)
      } else if (mbDate) {
        enriched.releaseDate = mbDate;
      }
      currentProfile = buildProfile();
      saveVibeProfile();

      // Re-score queued tracks against the updated profile — remove any that no longer fit.
      // Catches tracks queued during a brief enrichment window before dates were corrected.
      evictStaleQueuedTracks();

      enrichmentPending = false;
      enrichmentUntil   = 0;
      // QUEUE_CHANGED may have fired during the enrichment window and been suppressed.
      // Only kick off a recommendation if nothing is already running — if working is true,
      // the in-flight call's finally block will handle filling remaining slots.
      const ourAhead = upNextList.filter(t => alreadyQueued.has(t.id)).length;
      log(`[TS] Enrichment complete for "${track.title}" — BPM: ${deezer?.bpm ?? "—"} | ${ourAhead}/${QUEUE_AHEAD} TS tracks ahead`);
      if (intercepting && ourAhead < QUEUE_AHEAD && !working) queueNextVibeTrack();
    });
  } else {
    enrichmentPending = false;
    enrichmentUntil   = 0;
    const ourAhead = upNextList.filter(t => alreadyQueued.has(t.id)).length;
    if (intercepting && ourAhead < QUEUE_AHEAD) queueNextVibeTrack();
  }

  // Push updated vibe + up-next to popup (covers track-changed and back-navigation cases)
  chrome.runtime.sendMessage({
    type:       "VIBE_PROFILE_UPDATED",
    profile: {
      avgBPM:         currentProfile.avgBPM,
      estimatedBPM:   currentProfile.estimatedBPM ?? null,
      primaryGenre:   currentProfile.primaryGenre,
      dominantDecade: currentProfile.dominantDecade,
    },
    seedArtist: userOverrides.pinnedArtist ?? track.artistName,
    upNext:     upNextList.slice(),
  });
}

async function onQueueChanged(items, position) {
  if (!intercepting) return;

  // Always sync the popup display to what's actually coming up in the real queue.
  // This runs before any early-return so the display is accurate even when we're
  // not about to queue anything (e.g. queue is full, or user went back a track and
  // a non-TS track is now sitting between the current position and our queued tracks).
  const realAhead = (items ?? []).slice(position + 1, position + 1 + 5).filter(t => t?.id);
  chrome.storage.local.set({
    upNextList: realAhead.map(t => ({ id: t.id, title: t.title, artistName: t.artistName })),
  }).catch(() => {});

  // Heads-up when Apple Music's AutoPlay has inserted its own picks ahead of ours.
  // Signature: we have TS tracks in the queue (alreadyQueued non-empty) but the next
  // track ahead isn't one of them. That's Apple's `∞` AutoPlay squeezing in.
  const firstAhead = (items ?? [])[position + 1];
  if (firstAhead?.id && alreadyQueued.size > 0 && !alreadyQueued.has(firstAhead.id)) {
    const tsTracksBehind = (items ?? []).slice(position + 1).filter(t => t?.id && alreadyQueued.has(t.id)).length;
    if (tsTracksBehind > 0) {
      log(`[TS] Apple AutoPlay is inserting tracks ahead of your TS queue — disable the ∞ AutoPlay toggle to keep Timbre Segue in control`);
    }
  }

  // Evict already-played tracks that are still sitting in the real queue ahead of us.
  // Happens when the user hits back: the track we were on stays in the forward queue and
  // plays again after the back-navigated track finishes. Filter those out so the session
  // moves forward instead of replaying.
  const stalePlayedIds = (items ?? [])
    .slice(position + 1)
    .filter(t => t?.id && playedThisSession.has(t.id))
    .map(t => t.id);
  if (stalePlayedIds.length) {
    log(`[TS] Evicting ${stalePlayedIds.length} already-played track(s) from real queue:`,
      (items ?? []).filter(t => stalePlayedIds.includes(t?.id)).map(t => t.title).join(", "));
    window.postMessage({ type: `${PREFIX}CLEAR_QUEUED`, ids: stalePlayedIds }, "*");
    stalePlayedIds.forEach(id => alreadyQueued.delete(id));
    upNextList = upNextList.filter(t => !stalePlayedIds.includes(t.id));
    saveUpNext();
    return; // The CLEAR triggers another queue-changed — let that pass be the real recommend pass.
  }

  if (items.length <= position + QUEUE_AHEAD) {
    log(`[TS] Queue changed — only ${items.length - position - 1} tracks ahead, waiting for queue to fill`);
    return;
  }

  // Count how many of our tracks are already sitting anywhere ahead in the queue.
  // playNext() appends near the end of Apple's preloaded batch, not at position+1,
  // so we must scan the full remaining queue — not just the next 2 slots.
  const remaining = items.slice(position + 1);
  const ourTracksAhead = remaining.filter(t => t?.id && alreadyQueued.has(t.id)).length;
  if (ourTracksAhead >= QUEUE_AHEAD) {
    log(`[TS] Queue full — ${ourTracksAhead} TS tracks already ahead`);
    return;
  }

  // Suppress rapid re-fires caused by our own playNext() call mutating the queue.
  // queueItemsDidChange fires multiple times per playNext(); the cooldown absorbs them.
  const cooldownRemaining = QUEUE_COOLDOWN_MS - (Date.now() - lastQueuedAt);
  if (cooldownRemaining > 0) {
    log(`[TS] Cooldown — ${Math.round(cooldownRemaining / 1000)}s remaining`);
    return;
  }

  // Wait for Deezer + MusicBrainz enrichment before recommending.
  // enrichmentPending is the primary gate; enrichmentUntil is a safety fallback.
  // If Safari suspended mid-enrichment and the promise never settled, auto-clear here.
  if (enrichmentPending && Date.now() > enrichmentUntil) {
    log("[TS] Enrichment timeout expired — unblocking");
    enrichmentPending = false;
    enrichmentUntil   = 0;
  }
  if (enrichmentPending || Date.now() < enrichmentUntil) {
    log("[TS] Waiting for track enrichment before recommending");
    return;
  }

  await queueNextVibeTrack();
}

// --- postMessage bridge ---

// Guard against re-injection on SPA navigation (Safari re-runs content scripts on
// pushState/popstate without a full page reload). All side-effectful initialization
// (event listeners, intervals, storage writes) is skipped on the second injection.
if (!window.__AML_CS_INIT__) {
window.__AML_CS_INIT__ = true;

// Clear any stale auth status from a prior session so the popup shows a loading
// state rather than falsely reporting 'ok' before tokens arrive.
chrome.storage.local.remove("authStatus");

// If tokens never arrive within 10s, the user isn't signed in to Apple Music in Safari.
setTimeout(() => {
  if (!pageTokens) chrome.storage.local.set({ authStatus: "not_signed_in" });
}, 10000);

window.addEventListener("message", e => {
  if (e.source !== window || !e.data?.type?.startsWith(PREFIX)) return;

  switch (e.data.type) {
    case `${PREFIX}TOKENS`:
      pageTokens = { dev: e.data.dev, user: e.data.user, storefront: e.data.storefront };
      chrome.storage.local.set({
        authStatus: e.data.user        ? "ok"
                  : e.data.isAuthorized ? "no_subscription"
                  :                       "not_signed_in",
      });
      break;
    case `${PREFIX}NOW_PLAYING_CHANGED`:
      if (e.data.track) onNowPlayingChanged(e.data.track);
      break;
    case `${PREFIX}QUEUE_CHANGED`:
      onQueueChanged(e.data.items ?? [], e.data.position ?? 0);
      break;
    case `${PREFIX}PLAY_NEXT_OK`:
      break;
    case `${PREFIX}DEBUG_DUMP`: {
      const replyId = e.data.id;
      dumpNowPlayingFull().then(result => {
        window.postMessage({ type: `${PREFIX}DEBUG_DUMP_REPLY`, id: replyId, result }, "*");
      });
      break;
    }
  }
});

// Safari suspends JS execution when the app is backgrounded. Promises in-flight at that
// moment may never settle, leaving enrichmentPending or working stuck. Reset them when
// the page becomes visible again and re-request tokens from the bridge in case they were lost.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;

  if (enrichmentPending) {
    log("[TS] Resetting stale enrichmentPending after visibility restore");
    enrichmentPending = false;
    enrichmentUntil   = 0;
  }
  if (working) {
    log("[TS] Resetting stale working flag after visibility restore");
    working = false;
  }

  // Re-request tokens from the page bridge in case the connection was lost.
  window.postMessage({ type: `${PREFIX}GET_TOKENS` }, "*");

  // Give the bridge a moment to respond, then queue if we're short.
  setTimeout(() => {
    const ourAhead = upNextList.filter(t => alreadyQueued.has(t.id)).length;
    if (intercepting && currentProfile && pageTokens && ourAhead < QUEUE_AHEAD) {
      queueNextVibeTrack();
    }
  }, 500);
});

// --- Override handling ---

// Apply new overrides from storage. Called via chrome.storage.onChanged — more reliable
// in Safari than chrome.tabs.sendMessage, which silently drops messages to content scripts.
function applyOverrides(newOverrides) {
  // Normalize legacy sentinel value — pre1990 was renamed to pre1960 when earlier decades
  // were added. Old values persisted in storage would otherwise break era scoring.
  if (newOverrides.forcedDecade === "pre1990") newOverrides.forcedDecade = "pre1960";


  const prev    = userOverrides.pinnedArtist;
  const prevKey = `${userOverrides.bpmOffset}|${userOverrides.forcedDecade}|${userOverrides.forcedGenre}|${userOverrides.scoreThreshold}|${userOverrides.pinnedArtist}`;
  userOverrides = newOverrides;
  const nextKey = `${userOverrides.bpmOffset}|${userOverrides.forcedDecade}|${userOverrides.forcedGenre}|${userOverrides.scoreThreshold}|${userOverrides.pinnedArtist}`;

  if (prevKey !== nextKey) {
    // Preserve every track currently in upNextList — they're already inserted into
    // MusicKit's queue and the user expects them to play. Only clear IDs in alreadyQueued
    // that are NOT in upNextList (stale entries from a previous filter state).
    // New filters kick in after the buffered tracks finish — at most QUEUE_AHEAD songs of delay.
    const keptIds = new Set(upNextList.map(t => t.id));
    const idsToRemove = [...alreadyQueued].filter(id => !keptIds.has(id));
    if (idsToRemove.length > 0) {
      window.postMessage({ type: `${PREFIX}CLEAR_QUEUED`, ids: idsToRemove }, "*");
    }

    // Reset alreadyQueued to only the preserved tracks so we don't re-queue them.
    // Also restore all played-this-session IDs — settings changes shouldn't bring
    // songs back that the user has already heard.
    alreadyQueued.clear();
    for (const t of upNextList) alreadyQueued.add(t.id);
    for (const id of playedThisSession) alreadyQueued.add(id);
    queuedArtists.clear();
    radioSeedQueue.length = 0;
    // upNextList is intentionally left as-is — preserved tracks stay visible in popup.
    saveUpNext();
    lastQueuedAt = 0;
    const THRESHOLD_LABELS = { 1: "Very Loose", 2: "Loose", 3: "Balanced", 4: "Snug", 5: "Strict", 6: "Very Strict" };
    const threshold = userOverrides.scoreThreshold ?? 3;
    const desc = [
      userOverrides.forcedGenre  ? `Genre: ${userOverrides.forcedGenre}` : "Genre: Auto",
      userOverrides.forcedDecade ? `Era: ${userOverrides.forcedDecade}s` : "Era: Auto",
      userOverrides.bpmOffset    ? `BPM offset: ${userOverrides.bpmOffset > 0 ? "+" : ""}${userOverrides.bpmOffset}` : null,
      `Match: ${THRESHOLD_LABELS[threshold] ?? threshold}`,
      userOverrides.pinnedArtist ? `Seed: ${userOverrides.pinnedArtist}` : null,
    ].filter(Boolean).join(" | ");
    log(`[TS] Filters → ${desc}`);
  }

  if (recentTracks.length > 0) {
    currentProfile = { ...buildVibeProfile(recentTracks) };
  }

  if (userOverrides.pinnedArtist && userOverrides.pinnedArtist !== prev) {
    chrome.runtime.sendMessage(
      { type: "SEARCH_DEEZER_ARTIST", name: userOverrides.pinnedArtist },
      r => {
        if (r?.artistDeezerId) {
          userOverrides.pinnedArtistDeezerId = r.artistDeezerId;
          log("[TS] Pinned artist resolved:", userOverrides.pinnedArtist, "→ ID", r.artistDeezerId);
        }
      }
    );
  } else if (!userOverrides.pinnedArtist) {
    userOverrides.pinnedArtistDeezerId = null;
  }
}

// Poll storage every 500ms for override changes from the popup.
// chrome.tabs.sendMessage and chrome.storage.onChanged are both unreliable in Safari
// content scripts. Polling chrome.storage.local.get is the only path that works.
let _lastOverridesKey = "";
setInterval(() => {
  chrome.storage.local.get(["overrides", "debugMode"], result => {
    if (result.debugMode !== undefined) debugMode = result.debugMode;
    if (!result.overrides) return;
    const o = result.overrides;
    const key = `${o.bpmOffset}|${o.forcedDecade}|${o.forcedGenre}|${o.scoreThreshold}|${o.pinnedArtist}`;
    if (key !== _lastOverridesKey) {
      _lastOverridesKey = key;
      applyOverrides(o);
    }
  });
}, 500);

// --- Debug: dump full raw API responses for the now-playing track ---
// Usage from Safari console:  window.tsDump()
async function dumpNowPlayingFull() {
  const nowPlaying = recentTracks[recentTracks.length - 1];
  if (!nowPlaying) { console.log("[TS DEBUG] Nothing playing yet"); return { error: "no track" }; }

  const { isrc, id, title, artistName } = nowPlaying;
  console.log("[TS DEBUG] ===== Dumping full metadata for:", title, "—", artistName, "=====");
  console.log("[TS DEBUG] MusicKit state:", nowPlaying);

  let appleFull = null;
  if (pageTokens?.dev) {
    // Library IDs (start with "i.") can't be queried via the catalog /songs endpoint.
    // Use search by title+artist instead — returns the catalog equivalent with full metadata.
    const isLibraryId = typeof id === "string" && id.startsWith("i.");
    try {
      if (!isLibraryId && id) {
        const url = `https://api.music.apple.com/v1/catalog/${pageTokens.storefront ?? "us"}/songs/${id}?include=albums,artists,composers&extend=artistUrl,editorialNotes`;
        const res = await fetch(url, {
          headers: { "Authorization": `Bearer ${pageTokens.dev}`, "Music-User-Token": pageTokens.user },
        });
        appleFull = await res.json();
      } else if (title && artistName) {
        const url = `https://api.music.apple.com/v1/catalog/${pageTokens.storefront ?? "us"}/search?types=songs&limit=3&include=albums,artists&term=${encodeURIComponent(`${title} ${artistName}`)}`;
        const res = await fetch(url, {
          headers: { "Authorization": `Bearer ${pageTokens.dev}`, "Music-User-Token": pageTokens.user },
        });
        appleFull = await res.json();
      }
    } catch (e) { appleFull = { error: e?.message }; }
  }
  console.log("[TS DEBUG] Apple Music Catalog (full):", appleFull);

  let deezerFull = null;
  if (isrc) {
    deezerFull = await new Promise(resolve => {
      chrome.runtime.sendMessage({ type: "DEBUG_DEEZER_FULL", isrc }, resolve);
    });
  }
  console.log("[TS DEBUG] Deezer (track + artist + artistTop + artistRelated + album):", deezerFull);

  let mbFull = null;
  if (isrc) {
    mbFull = await new Promise(resolve => {
      chrome.runtime.sendMessage({ type: "DEBUG_MB_FULL", isrc }, resolve);
    });
  }
  console.log("[TS DEBUG] MusicBrainz (full w/ genres+tags+releases):", mbFull);

  console.log("[TS DEBUG] ===== End dump — expand each object above to browse fields =====");
  return { apple: appleFull, deezer: deezerFull, musicbrainz: mbFull, musickit: nowPlaying };
}
window.tsDump = dumpNowPlayingFull;

// --- Popup messages ---

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "TOGGLE_INTERCEPT") {
    intercepting = message.enabled;
    log(`[TS] Interception ${intercepting ? "on" : "off"}`);
  }
  if (message.type === "DEBUG_DUMP_TRACK") {
    dumpNowPlayingFull().then(sendResponse);
    return true;
  }
  if (message.type === "GET_PROFILE") {
    const nowPlaying = recentTracks[recentTracks.length - 1];
    sendResponse({
      profile: currentProfile ? {
        avgBPM:         currentProfile.avgBPM,
        primaryGenre:   currentProfile.primaryGenre,
        dominantDecade: currentProfile.dominantDecade,
      } : null,
      upNext:     upNextList.slice(),
      seedArtist: userOverrides.pinnedArtist ?? nowPlaying?.artistName ?? null,
    });
  }
  return true;
});

// Clear persisted overrides on every page load — each session starts fresh.
// The popup restores its own UI from storage separately, but the engine starts clean.
chrome.storage.local.remove(["overrides", "vibeProfile", "upNextList"]);

log("[TS] Content script loaded");

} // end init guard
