// service-worker.js
// Handles Deezer API calls (CORS-exempt in background context).

import { getDeezerTrackByISRC, getDeezerRadio, getDeezerSimilarArtistTracks, searchDeezerByBPM, searchDeezerByBPMWide, searchDeezerArtist, getMusicBrainzFirstRelease, debugDeezerFull, debugMusicBrainzFull } from "../lib/metadata-bridge.js";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", () => self.clients.claim());

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch(err => {
    console.error("[TS background]", err?.message ?? err);
    sendResponse({ error: err?.message ?? String(err) });
  });
  return true;
});

async function handleMessage(message) {
  switch (message.type) {
    case "GET_DEEZER_TRACK":
      return getDeezerTrackByISRC(message.isrc);

    case "GET_RADIO":
      return getDeezerRadio(message.artistDeezerId, message.limit ?? 25);

    case "GET_SIMILAR_ARTIST_TRACKS":
      return getDeezerSimilarArtistTracks(message.artistDeezerId, message.artistLimit ?? 3, message.tracksPerArtist ?? 8);

    case "GET_BPM_SEARCH":
      return searchDeezerByBPM(message.bpmMin, message.bpmMax, message.limit ?? 25, message.genre ?? null);

    case "GET_BPM_SEARCH_WIDE":
      return searchDeezerByBPMWide(message.bpmMin, message.bpmMax, message.limit ?? 25);

    case "SEARCH_DEEZER_ARTIST":
      return searchDeezerArtist(message.name);

    case "GET_MB_FIRST_RELEASE":
      return getMusicBrainzFirstRelease(message.isrc).then(date => ({ date }));

    case "DEBUG_DEEZER_FULL":
      return debugDeezerFull(message.isrc);

    case "DEBUG_MB_FULL":
      return debugMusicBrainzFull(message.isrc);

    default:
      return { ok: true };
  }
}
