(() => {
  // lib/vibe-engine.js
  var WEIGHTS = {
    bpm: 3,
    genre: 3,
    era: 2,
    vocal: 2
    // reserved for AcousticBrainz — future
  };
  var BPM_TOLERANCE = 15;
  function buildVibeProfile(tracks) {
    const withBPM = tracks.filter((t) => t.bpm && t.bpm > 0);
    const avgBPM = withBPM.length > 0 ? Math.round(withBPM.reduce((sum, t) => sum + t.bpm, 0) / withBPM.length) : null;
    const genreCount = {};
    for (const t of tracks) {
      for (const g of t.genreNames ?? []) {
        if (g === "Music")
          continue;
        genreCount[g] = (genreCount[g] ?? 0) + 1;
      }
    }
    const genres = Object.entries(genreCount).sort((a, b) => b[1] - a[1]).map(([g]) => g);
    const decades = tracks.filter((t) => t.releaseDate).map((t) => Math.floor(new Date(t.releaseDate).getFullYear() / 10) * 10);
    const dominantDecade = decades.length > 0 ? mode(decades) : null;
    const recentArtists = new Set(tracks.map((t) => t.artistName?.toLowerCase()).filter(Boolean));
    return {
      avgBPM,
      bpmMin: avgBPM ? avgBPM - BPM_TOLERANCE : null,
      bpmMax: avgBPM ? avgBPM + BPM_TOLERANCE : null,
      genres,
      primaryGenre: genres[0] ?? null,
      dominantDecade,
      recentArtists,
      // The artist name of the most recent track — used to steer Deezer search
      seedArtist: tracks[tracks.length - 1]?.artistName ?? null
    };
  }
  function scoreCandidate(candidate, profile, alreadyQueued2 = /* @__PURE__ */ new Set()) {
    if (alreadyQueued2.has(candidate.id))
      return -1;
    if (profile.recentArtists.has(candidate.artistName?.toLowerCase()))
      return -1;
    let score = 0;
    if (profile.avgBPM && candidate.bpm && candidate.bpm > 0) {
      const bpmDelta = Math.abs(candidate.bpm - profile.avgBPM);
      if (bpmDelta <= BPM_TOLERANCE) {
        score += WEIGHTS.bpm * (1 - bpmDelta / BPM_TOLERANCE);
      } else {
        score -= 1;
      }
    }
    const candidateGenres = (candidate.genreNames ?? []).map((g) => g.toLowerCase());
    const profileGenres = profile.genres.map((g) => g.toLowerCase());
    const overlap = candidateGenres.filter((g) => profileGenres.includes(g)).length;
    score += overlap * WEIGHTS.genre;
    if (profile.dominantDecade && candidate.releaseDate) {
      const candidateDecade = Math.floor(new Date(candidate.releaseDate).getFullYear() / 10) * 10;
      if (candidateDecade === profile.dominantDecade)
        score += WEIGHTS.era;
      else if (Math.abs(candidateDecade - profile.dominantDecade) === 10)
        score += 1;
    }
    return score;
  }
  function mode(arr) {
    const count = {};
    for (const v of arr)
      count[v] = (count[v] ?? 0) + 1;
    return Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }

  // content/content-script.js
  var PREFIX = "AML_";
  var VIBE_WINDOW = 5;
  var QUEUE_AHEAD = 2;
  var recentTracks = [];
  var alreadyQueued = /* @__PURE__ */ new Set();
  var intercepting = true;
  var currentProfile = null;
  var userOverrides = {};
  function injectBridge() {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("content/page-bridge.js");
    script.onload = () => script.remove();
    (document.head ?? document.documentElement).appendChild(script);
  }
  function toPage(type, data = {}) {
    window.postMessage({ type: `${PREFIX}${type}`, ...data }, "*");
  }
  function enrichWithBPM(track) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "RESOLVE_TRACK", track },
        (result) => resolve(result?.error ? track : { ...track, ...result })
      );
    });
  }
  function fetchCandidates(profile) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: "SEARCH_CANDIDATES",
          artistQuery: profile.seedArtist,
          bpmMin: profile.bpmMin ?? 90,
          bpmMax: profile.bpmMax ?? 160
        },
        (result) => resolve(Array.isArray(result) ? result : [])
      );
    });
  }
  async function resolveISRCsInAppleMusic(isrcs) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "RESOLVE_ISRCS", isrcs },
        (result) => resolve(Array.isArray(result) ? result : [])
      );
    });
  }
  async function queueNextVibeTrack() {
    if (!currentProfile)
      return;
    console.log("[AML] Building next recommendation...");
    const candidates = await fetchCandidates(currentProfile);
    if (!candidates.length) {
      console.log("[AML] No Deezer candidates \u2014 falling back to Apple autoplay");
      return;
    }
    const isrcs = candidates.map((c) => c.isrc).filter(Boolean);
    const appleMatches = await resolveISRCsInAppleMusic(isrcs);
    if (!appleMatches.length) {
      console.log("[AML] No candidates in Apple Music catalog");
      return;
    }
    const scored = appleMatches.map((t) => ({ ...t, score: scoreCandidate(t, currentProfile, alreadyQueued) })).filter((t) => t.score >= 0).sort((a, b) => b.score - a.score);
    if (!scored.length) {
      console.log("[AML] All candidates excluded");
      return;
    }
    const winner = scored[0];
    console.log(`[AML] Queuing: "${winner.title}" by ${winner.artistName} (score: ${winner.score})`);
    alreadyQueued.add(winner.id);
    toPage("PLAY_NEXT", { id: winner.id });
    chrome.runtime.sendMessage({
      type: "NEXT_RECOMMENDATION",
      track: winner,
      profile: {
        avgBPM: currentProfile.avgBPM,
        primaryGenre: currentProfile.primaryGenre,
        dominantDecade: currentProfile.dominantDecade
      }
    });
  }
  async function onNowPlayingChanged(track) {
    if (!track)
      return;
    console.log(`[AML] Now playing: "${track.title}" \u2014 ${track.artistName}  ISRC: ${track.isrc}`);
    const enriched = await enrichWithBPM(track);
    recentTracks.push(enriched);
    if (recentTracks.length > VIBE_WINDOW)
      recentTracks.shift();
    currentProfile = { ...buildVibeProfile(recentTracks), ...userOverrides };
    console.log("[AML] Vibe profile:", {
      avgBPM: currentProfile.avgBPM,
      primaryGenre: currentProfile.primaryGenre,
      decade: currentProfile.dominantDecade
    });
    chrome.runtime.sendMessage({ type: "VIBE_PROFILE_UPDATED", profile: currentProfile });
  }
  async function onQueueChanged(items, position) {
    if (!intercepting)
      return;
    if (items.length > position + QUEUE_AHEAD) {
      console.log("[AML] Autoplay queue injection detected \u2014 intercepting");
      await queueNextVibeTrack();
    }
  }
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data?.type?.startsWith(PREFIX))
      return;
    switch (e.data.type) {
      case `${PREFIX}NOW_PLAYING_CHANGED`:
        if (e.data.track)
          onNowPlayingChanged(e.data.track);
        break;
      case `${PREFIX}QUEUE_CHANGED`:
        onQueueChanged(e.data.items ?? [], e.data.position ?? 0);
        break;
    }
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "OVERRIDES_UPDATED") {
      userOverrides = message.overrides;
      if (recentTracks.length > 0) {
        currentProfile = { ...buildVibeProfile(recentTracks), ...userOverrides };
      }
    }
    if (message.type === "TOGGLE_INTERCEPT") {
      intercepting = message.enabled;
      console.log(`[AML] Interception ${intercepting ? "enabled" : "disabled"}`);
    }
    if (message.type === "GET_PROFILE") {
      sendResponse({ profile: currentProfile });
    }
    return true;
  });
  chrome.storage.local.get("overrides", (data) => {
    userOverrides = data.overrides ?? {};
  });
  injectBridge();
  console.log("[AML] Content script loaded");
})();
