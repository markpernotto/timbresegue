// content-script.js
// Runs in Safari's isolated world.
// page-bridge.js (MAIN world) handles MusicKit access and communicates via postMessage.
// All API calls (Deezer, Apple Music catalog) happen directly here.

import { buildVibeProfile, scoreCandidate } from "../lib/matcher.js";

const PREFIX       = "AML_";
const VIBE_WINDOW  = 5;
const QUEUE_AHEAD  = 2;

let debugMode = false;
function log(...args) { if (debugMode) console.log(...args); }

let recentTracks    = [];
let alreadyQueued   = new Set(); // track IDs already queued this session
let queuedArtists   = new Set(); // primary artists already queued this session
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
  chrome.storage.local.set({ upNextList: upNextList.slice() });
}

function saveVibeProfile() {
  if (!currentProfile) return;
  chrome.storage.local.set({
    vibeProfile: {
      avgBPM:         currentProfile.avgBPM,
      primaryGenre:   currentProfile.primaryGenre,
      dominantDecade: currentProfile.dominantDecade,
    },
  });
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

function searchDeezerByBPM(bpmMin, bpmMax, genre = null) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: "GET_BPM_SEARCH", bpmMin, bpmMax, genre }, r => {
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
  "k-pop":         14,
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

// Fetch Apple Music genre chart — songs are guaranteed to carry correct Apple Music genre tags.
// Cheaper than resolveISRC per-candidate: one call returns up to `limit` fully-attributed songs.
async function getAppleMusicGenreChart(genreId, limit = 25) {
  if (!pageTokens?.dev) return [];
  const storefront = pageTokens.storefront ?? "us";
  const url = `https://api.music.apple.com/v1/catalog/${storefront}/charts?types=songs&genre=${genreId}&limit=${limit}`;
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

// --- Core recommendation pipeline ---

async function queueNextVibeTrack() {
  if (!currentProfile || !pageTokens || working) return;
  working = true;
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
      avgBPM:  currentProfile.avgBPM != null ? currentProfile.avgBPM + bpmOffset : null,
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
      // When era is forced to pre1990 and genre is also forced (so era is soft-only),
      // use 1980 as the soft-scoring anchor so tracks from the 1970s–80s score higher
      // than tracks from 2020. Without this, the anchor falls back to the detected
      // listening history decade (likely 2010s), which makes pre1990 preference invisible.
      dominantDecade: fd && fd !== "pre1990" ? fd : fd === "pre1990" ? 1980 : currentProfile.dominantDecade,
      forcedDecade:   fg ? null : fd,
    };
    const scoreThreshold = userOverrides.scoreThreshold ?? 3;

    // When genre is forced, pull from Apple Music's genre chart first.
    // These songs carry correct Apple Music genre tags by definition — no ISRC resolution needed.
    // Deezer BPM search still runs in parallel for additional variety.
    const forcedGenreId = profileForScoring.forcedGenre
      ? AM_GENRE_IDS[profileForScoring.forcedGenre.toLowerCase()] ?? null
      : null;

    let chartCandidates = [];
    if (forcedGenreId) {
      // Always use the genre chart as the primary candidate source — songs here carry
      // correct Apple Music genre tags by definition, unlike keyword search which matches
      // song *titles* (e.g. "All That Jazz" is not a jazz track).
      // When era is also forced, era preference is handled by soft scoring (dominantDecade),
      // not by pre-filtering. This keeps the candidate pool full for niche genres like Jazz.
      try {
        const chart = await getAppleMusicGenreChart(forcedGenreId, 50);
        chartCandidates = chart.sort(() => Math.random() - 0.5);
      } catch (fetchErr) {
        log("[AML] Genre chart fetch failed, falling back to Deezer only:", fetchErr?.message);
      }
    }

    // When genre is forced, only exclude by track ID (not by artist) — the genre chart
    // has limited artists and artist-exclusion quickly starves the pool.
    const excludedArtists = profileForScoring.forcedGenre
      ? new Set([...currentProfile.recentArtists])  // only avoid what's currently playing
      : new Set([...currentProfile.recentArtists, ...queuedArtists]);

    // Patch the scoring profile with the right artist exclusion set
    profileForScoring.recentArtists = excludedArtists;

    // Up to 5 attempts — each gets a fresh random BPM query for variety.
    // When genre is locked, skip artist radio entirely — the current artist's neighbors
    // are unlikely to match a different genre, creating an unrecoverable death spiral.
    const useRadio = !userOverrides.forcedGenre;
    for (let attempt = 0; attempt < 5 && !scored.length; attempt++) {
      const seedArtistId = radioSeedQueue.length > 0 ? radioSeedQueue[0] : fallbackSeedId;

      let candidates = [...chartCandidates];  // always start with genre-chart songs if available
      if (useRadio && attempt === 0 && seedArtistId) {
        candidates = [...candidates, ...await getDeezerRadio(seedArtistId)];
      }

      // BPM search — neutral queries only (genre name matches song titles on Deezer, not genre).
      // Widen BPM range when genre is forced: genre chart does heavy filtering, tight BPM starves results.
      const baseBpmMin = profileForScoring.bpmMin ?? 90;
      const baseBpmMax = profileForScoring.bpmMax ?? 160;
      const searchMin = userOverrides.forcedGenre ? Math.max(60,  baseBpmMin - 30) : baseBpmMin;
      const searchMax = userOverrides.forcedGenre ? Math.min(220, baseBpmMax + 30) : baseBpmMax;
      candidates = [...candidates, ...await searchDeezerByBPM(searchMin, searchMax, null)];

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
      for (const c of unique.slice(0, 20)) {
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

      scored = verified
        .map(t => ({ ...t, score: scoreCandidate(t, profileForScoring, alreadyQueued) }))
        .filter(t => t.score >= scoreThreshold)
        .sort((a, b) => b.score - a.score);

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
        log(`[AML] Pool exhaustion rescue — relaxing artist exclusion (${scored.length} candidates recovered)`);
      }
    }

    // When genre is explicitly forced, don't degrade to wrong-genre tracks — skip the slot
    // and let the next track trigger a fresh attempt with different candidates.
    if (!scored.length && profileForScoring.forcedGenre) {
      log(`[AML] No ${profileForScoring.forcedGenre} candidates — will retry on next track`);
      return;
    }

    // Fallback: progressively lower the score threshold but keep genre/era preferences.
    // Only runs in auto-genre mode — forced-genre path exits above.
    // Steps down by 1 at a time (e.g. 3→2→1) so we don't jump straight from strict to anything-goes.
    if (!scored.length && scoreThreshold > 1) {
      for (let fallback = scoreThreshold - 1; fallback >= 1 && !scored.length; fallback--) {
        scored = verified
          .map(t => ({ ...t, score: scoreCandidate(t, profileForScoring, alreadyQueued) }))
          .filter(t => t.score >= fallback)
          .sort((a, b) => b.score - a.score);
      }
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
      log("[AML] No candidates at all — skipping this slot");
      return;
    }

    // Verify top candidates against MusicBrainz before committing.
    // Apple Music release dates are often remaster years that mislead era scoring —
    // fetch the real first-release-date for each top candidate in parallel, re-score,
    // and pick the first that still passes. Cache results so the second lookup when
    // the track actually plays is an instant hit.
    const TOP_VERIFY = Math.min(scored.length, 5);
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
      if (vScore >= scoreThreshold) {
        winner = { ...verified, score: vScore };
        if (mbDate && mbDate !== c.releaseDate) {
          log(`[AML] MB pre-verified "${c.title}": ${c.releaseDate} → ${mbDate}`);
        }
        break;
      }
      if (mbDate) {
        log(`[AML] Skipping "${c.title}" — MB date ${mbDate} drops score from ${c.score} to ${vScore}`);
      }
    }
    if (!winner) {
      log("[AML] No candidates passed MB date verification — skipping slot");
      return;
    }

    const filterDesc = [
      profileForScoring.primaryGenre ?? "Auto",
      `${profileForScoring.dominantDecade ?? "Auto"}s`,
      profileForScoring.avgBPM ? `${Math.round(profileForScoring.avgBPM)} BPM` : null,
      scoreThreshold !== 2 ? (scoreThreshold >= 4 ? "Strict" : "Loose") : null,
    ].filter(Boolean).join(" | ");
    log(`[AML] Queuing: "${winner.title}" by ${winner.artistName} (score: ${winner.score}) [${filterDesc}]`);
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
    console.error("[AML] Recommendation error:", err?.message ?? err);
  } finally {
    working = false;
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
    dominantDecade: userOverrides.forcedDecade && userOverrides.forcedDecade !== "pre1990"
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
  log(`[AML] Evicting ${staleIds.length} stale queued track(s) after profile update:`,
    upNextList.filter(t => staleSet.has(t.id)).map(t => t.title).join(", "));
  window.postMessage({ type: `${PREFIX}CLEAR_QUEUED`, ids: staleIds }, "*");
  staleIds.forEach(id => alreadyQueued.delete(id)); // allow re-queueing if a better slot opens
  upNextList = upNextList.filter(t => !staleSet.has(t.id));
  saveUpNext();
}

// --- Event handlers ---

async function onNowPlayingChanged(track) {
  if (!track) return;

  // Look up genres from Apple Music catalog — MusicKit doesn't always expose them
  let genres = track.genreNames ?? [];
  if ((!genres.length || genres.every(g => g === "Music")) && track.isrc && pageTokens) {
    const catalogTrack = await resolveISRC(track.isrc);
    if (catalogTrack?.genreNames?.length) genres = catalogTrack.genreNames;
  }

  const enriched = { ...track, genreNames: genres, bpm: null };
  log(`[AML] Now playing: "${track.title}" — ${track.artistName}  ISRC: ${track.isrc}  Genres: ${genres.join(", ")}`);

  recentTracks.push(enriched);
  if (recentTracks.length > VIBE_WINDOW) recentTracks.shift();

  // Remove this track from the up-next list if it just started playing
  upNextList = upNextList.filter(t => t.id !== track.id);
  saveUpNext();

  currentProfile = { ...buildVibeProfile(recentTracks), ...userOverrides };
  saveVibeProfile();

  // Block recommendations until both Deezer (BPM) and MusicBrainz (original release year)
  // have responded. enrichmentPending is the primary gate — cleared only when both APIs
  // return (or fail). enrichmentUntil is a safety fallback so a hung API can't block forever.
  // enrichmentGeneration prevents a stale callback from a previous track from clearing the
  // pending flag mid-enrichment of the current track (race condition when tracks change fast).
  const myGeneration = ++enrichmentGeneration;
  enrichmentPending  = true;
  enrichmentUntil    = Date.now() + ENRICHMENT_TIMEOUT_MS;
  if (track.isrc) {
    Promise.all([
      getDeezerTrack(track.isrc),
      getMBFirstRelease(track.isrc),
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
      if (mbDate) {
        enriched.releaseDate = mbDate;
        log(`[AML] MusicBrainz corrected release date for "${track.title}": ${track.releaseDate} → ${mbDate}`);
      }
      currentProfile = { ...buildVibeProfile(recentTracks), ...userOverrides };
      saveVibeProfile();

      // Re-score queued tracks against the updated profile — remove any that no longer fit.
      // Catches tracks queued during a brief enrichment window before dates were corrected.
      evictStaleQueuedTracks();

      enrichmentPending = false;
      enrichmentUntil   = 0;
      // QUEUE_CHANGED may have fired during the enrichment window and been suppressed.
      // Kick off a recommendation now if we still need one.
      const ourAhead = upNextList.filter(t => alreadyQueued.has(t.id)).length;
      if (intercepting && ourAhead < QUEUE_AHEAD) queueNextVibeTrack();
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
      primaryGenre:   currentProfile.primaryGenre,
      dominantDecade: currentProfile.dominantDecade,
    },
    seedArtist: userOverrides.pinnedArtist ?? track.artistName,
    upNext:     upNextList.slice(),
  });
}

async function onQueueChanged(items, position) {
  if (!intercepting) return;
  if (items.length <= position + QUEUE_AHEAD) return;

  // Count how many of our tracks are already sitting anywhere ahead in the queue.
  // playNext() appends near the end of Apple's preloaded batch, not at position+1,
  // so we must scan the full remaining queue — not just the next 2 slots.
  const remaining = items.slice(position + 1);
  const ourTracksAhead = remaining.filter(t => t?.id && alreadyQueued.has(t.id)).length;
  if (ourTracksAhead >= QUEUE_AHEAD) return;

  // Suppress rapid re-fires caused by our own playNext() call mutating the queue.
  // queueItemsDidChange fires multiple times per playNext(); the cooldown absorbs them.
  if (Date.now() - lastQueuedAt < QUEUE_COOLDOWN_MS) return;

  // Wait for Deezer + MusicBrainz enrichment before recommending.
  // enrichmentPending is the primary gate; enrichmentUntil is a safety fallback.
  // If Safari suspended mid-enrichment and the promise never settled, auto-clear here.
  if (enrichmentPending && Date.now() > enrichmentUntil) {
    enrichmentPending = false;
    enrichmentUntil   = 0;
  }
  if (enrichmentPending || Date.now() < enrichmentUntil) return;

  await queueNextVibeTrack();
}

// --- postMessage bridge ---

// Guard against re-injection on SPA navigation (Safari re-runs content scripts on
// pushState/popstate without a full page reload). All side-effectful initialization
// (event listeners, intervals, storage writes) is skipped on the second injection.
if (!window.__AML_CS_INIT__) {
window.__AML_CS_INIT__ = true;

window.addEventListener("message", e => {
  if (e.source !== window || !e.data?.type?.startsWith(PREFIX)) return;

  switch (e.data.type) {
    case `${PREFIX}TOKENS`:
      pageTokens = { dev: e.data.dev, user: e.data.user, storefront: e.data.storefront };
      break;
    case `${PREFIX}NOW_PLAYING_CHANGED`:
      if (e.data.track) onNowPlayingChanged(e.data.track);
      break;
    case `${PREFIX}QUEUE_CHANGED`:
      onQueueChanged(e.data.items ?? [], e.data.position ?? 0);
      break;
    case `${PREFIX}PLAY_NEXT_OK`:
      break;
  }
});

// Safari suspends JS execution when the app is backgrounded. Promises in-flight at that
// moment may never settle, leaving enrichmentPending or working stuck. Reset them when
// the page becomes visible again and re-request tokens from the bridge in case they were lost.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;

  if (enrichmentPending) {
    log("[AML] Resetting stale enrichmentPending after visibility restore");
    enrichmentPending = false;
    enrichmentUntil   = 0;
  }
  if (working) {
    log("[AML] Resetting stale working flag after visibility restore");
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
    alreadyQueued.clear();
    for (const t of upNextList) alreadyQueued.add(t.id);
    queuedArtists.clear();
    radioSeedQueue.length = 0;
    // upNextList is intentionally left as-is — preserved tracks stay visible in popup.
    saveUpNext();
    lastQueuedAt = 0;
    const desc = [
      userOverrides.forcedGenre   ? `Genre: ${userOverrides.forcedGenre}` : "Genre: Auto",
      userOverrides.forcedDecade  ? `Era: ${userOverrides.forcedDecade}s` : "Era: Auto",
      userOverrides.bpmOffset     ? `BPM offset: ${userOverrides.bpmOffset > 0 ? "+" : ""}${userOverrides.bpmOffset}` : null,
      userOverrides.scoreThreshold >= 4 ? "Strict" : userOverrides.scoreThreshold <= 1 ? "Loose" : null,
      userOverrides.pinnedArtist  ? `Seed: ${userOverrides.pinnedArtist}` : null,
    ].filter(Boolean).join(" | ");
    log(`[AML] Filters → ${desc || "all Auto"}`);
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
          log("[AML] Pinned artist resolved:", userOverrides.pinnedArtist, "→ ID", r.artistDeezerId);
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

// --- Popup messages ---

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "TOGGLE_INTERCEPT") {
    intercepting = message.enabled;
    log(`[AML] Interception ${intercepting ? "on" : "off"}`);
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

log("[AML] Content script loaded");

} // end init guard
