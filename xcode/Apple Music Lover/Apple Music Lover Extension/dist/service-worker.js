(() => {
  // lib/metadata-bridge.js
  var DEEZER_BASE = "https://api.deezer.com";
  async function getDeezerTrackByISRC(isrc) {
    const res = await fetch(`${DEEZER_BASE}/track/isrc:${isrc}`);
    const data = await res.json();
    if (data.error)
      throw new Error(`Deezer: ${data.error.message}`);
    return {
      bpm: data.bpm ?? 0,
      duration: data.duration,
      albumId: data.album?.id,
      deezerId: data.id
    };
  }
  async function searchDeezerCandidates(artistQuery, bpmMin, bpmMax, limit = 20) {
    const url = `${DEEZER_BASE}/search/track?q=${encodeURIComponent(artistQuery)}&bpm_min=${bpmMin}&bpm_max=${bpmMax}&limit=${limit}`;
    const res = await fetch(url);
    const data = await res.json();
    return (data.data ?? []).filter((t) => t.isrc).map((t) => ({
      title: t.title,
      artist: t.artist?.name,
      isrc: t.isrc,
      id: t.id
    }));
  }
  async function searchDeezerByArtistTitle(artist, title) {
    const q = `artist:"${artist}" track:"${title}"`;
    const url = `${DEEZER_BASE}/search/track?q=${encodeURIComponent(q)}&limit=5`;
    const res = await fetch(url);
    const data = await res.json();
    const match = data.data?.[0];
    if (!match)
      return null;
    return {
      bpm: match.bpm ?? 0,
      duration: match.duration,
      albumId: match.album?.id,
      deezerId: match.id,
      isrc: match.isrc
    };
  }
  async function resolveTrackMetadata(track) {
    const { isrc, artistName, title } = track;
    let deezerData = null;
    if (isrc) {
      try {
        deezerData = await getDeezerTrackByISRC(isrc);
      } catch {
      }
    }
    if (!deezerData) {
      try {
        deezerData = await searchDeezerByArtistTitle(artistName, title);
      } catch {
      }
    }
    return {
      ...track,
      bpm: deezerData?.bpm ?? null,
      deezerId: deezerData?.deezerId ?? null
    };
  }

  // background/service-worker.js
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message, sender).then(sendResponse).catch((err) => {
      console.error("[AML background]", err);
      sendResponse({ error: err.message });
    });
    return true;
  });
  async function handleMessage(message, sender) {
    switch (message.type) {
      case "RESOLVE_TRACK":
        return resolveTrackMetadata(message.track);
      case "SEARCH_CANDIDATES":
        return searchDeezerCandidates(
          message.artistQuery,
          message.bpmMin,
          message.bpmMax,
          message.limit ?? 20
        );
      case "RESOLVE_ISRCS":
        return resolveISRCsInAppleMusic(message.isrcs, sender.tab?.id);
      case "NEXT_RECOMMENDATION":
      case "VIBE_PROFILE_UPDATED":
        chrome.tabs.query({ url: "https://music.apple.com/*" }, (tabs) => {
          for (const tab of tabs) {
            chrome.tabs.sendMessage(tab.id, message).catch(() => {
            });
          }
        });
        return { ok: true };
      default:
        throw new Error(`Unknown message type: ${message.type}`);
    }
  }
  async function resolveISRCsInAppleMusic(isrcs, tabId) {
    let tokens;
    try {
      const results2 = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const mk = MusicKit.getInstance();
          return { dev: mk.developerToken, user: mk.musicUserToken, storefront: mk.storefrontId ?? "us" };
        }
      });
      tokens = results2?.[0]?.result;
    } catch (e) {
      console.error("[AML] Could not get tokens from page:", e);
      return [];
    }
    if (!tokens?.dev)
      return [];
    const results = [];
    for (const isrc of isrcs) {
      try {
        const url = `https://api.music.apple.com/v1/catalog/${tokens.storefront}/songs?filter[isrc]=${isrc}`;
        const res = await fetch(url, {
          headers: {
            "Authorization": `Bearer ${tokens.dev}`,
            "Music-User-Token": tokens.user
          }
        });
        const data = await res.json();
        const song = data.data?.[0];
        if (song) {
          results.push({
            id: song.id,
            title: song.attributes?.name,
            artistName: song.attributes?.artistName,
            albumName: song.attributes?.albumName,
            genreNames: song.attributes?.genreNames ?? [],
            releaseDate: song.attributes?.releaseDate,
            isrc: song.attributes?.isrc
          });
        }
      } catch {
      }
    }
    return results;
  }
})();
