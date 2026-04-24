// metadata-bridge.js
// Deezer + MusicBrainz API calls — runs in background service worker (CORS-exempt).

const DEEZER_BASE = "https://api.deezer.com";

// In-memory caches keyed by ISRC — persist for the service worker's lifetime (the session).
// Eliminates redundant network calls when the same track is looked up twice
// (e.g. pre-verified as a candidate, then looked up again when it starts playing).
const _deezerCache = new Map();
const _mbCache     = new Map();

// Look up a track by ISRC — returns BPM, Deezer track ID, and artist Deezer ID
async function getDeezerTrackByISRC(isrc) {
  if (_deezerCache.has(isrc)) return _deezerCache.get(isrc);
  const res = await fetch(`${DEEZER_BASE}/track/isrc:${isrc}`);
  const data = await res.json();
  if (data.error) return null;
  const result = {
    bpm:            data.bpm ?? 0,
    duration:       data.duration,
    deezerId:       data.id,
    artistDeezerId: data.artist?.id ?? null,
    isrc:           data.isrc,
  };
  _deezerCache.set(isrc, result);
  return result;
}

// Get similar tracks via Deezer's artist radio endpoint.
// /track/{id}/radio was removed — /artist/{id}/radio is the live equivalent.
async function getDeezerRadio(artistDeezerId, limit = 25) {
  const res  = await fetch(`${DEEZER_BASE}/artist/${artistDeezerId}/radio?limit=${limit}`);
  const data = await res.json();
  const raw  = data.data ?? [];

  // Fetch full track details for tracks missing ISRC (cap at 8 to limit requests)
  const enriched = await Promise.all(
    raw.slice(0, 8).map(async t => {
      if (t.isrc) return t;
      try {
        const r = await fetch(`${DEEZER_BASE}/track/${t.id}`);
        const d = await r.json();
        if (d.error) { console.log("[TS metadata] Track enrich error for", t.id, d.error); return null; }
        return { ...t, isrc: d.isrc, bpm: d.bpm ?? t.bpm };
      } catch (e) { console.log("[TS metadata] Track enrich fetch failed:", e?.message); return null; }
    })
  );

  const result = enriched.filter(t => t?.isrc);
  return {
    tracks: result.map(t => ({
      title:          t.title,
      artist:         t.artist?.name,
      artistDeezerId: t.artist?.id ?? null,
      isrc:           t.isrc,
      deezerId:       t.id,
      bpm:            t.bpm ?? null,
      duration:       t.duration,
    })),
    _debug: { raw: raw.length, enriched: result.length, error: data.error ?? null },
  };
}

// Fallback: BPM-range search when artist radio isn't available yet.
const BPM_FALLBACK_QUERIES = ["remix", "club mix", "feat", "remaster", "radio edit"];
const BEAT_PATTERN = /\b(instrumental|beat mix|rap beat|hip hop beat|trap beat|beatmaker|type beat|backing track|karaoke)\b/i;

async function searchDeezerByBPM(bpmMin, bpmMax, limit = 25, genre = null) {
  const q   = encodeURIComponent(genre ?? BPM_FALLBACK_QUERIES[Math.floor(Math.random() * BPM_FALLBACK_QUERIES.length)]);
  const url = `${DEEZER_BASE}/search/track?q=${q}&bpm_min=${bpmMin}&bpm_max=${bpmMax}&limit=${limit}`;
  const res  = await fetch(url);
  const data = await res.json();
  return (data.data ?? [])
    .filter(t => t.isrc && !BEAT_PATTERN.test(t.title))
    .map(t => ({
      title:    t.title,
      artist:   t.artist?.name,
      isrc:     t.isrc,
      deezerId: t.id,
      bpm:      t.bpm ?? null,
    }));
}

// Run all neutral queries in parallel — 5× the candidates in the same latency as one.
async function searchDeezerByBPMWide(bpmMin, bpmMax, limit = 25) {
  const results = await Promise.all(
    BPM_FALLBACK_QUERIES.map(q =>
      fetch(`${DEEZER_BASE}/search/track?q=${encodeURIComponent(q)}&bpm_min=${bpmMin}&bpm_max=${bpmMax}&limit=${limit}`)
        .then(r => r.json())
        .then(d => d.data ?? [])
        .catch(() => [])
    )
  );
  const seen = new Set();
  return results.flat()
    .filter(t => {
      if (!t.isrc || BEAT_PATTERN.test(t.title) || seen.has(t.isrc)) return false;
      seen.add(t.isrc);
      return true;
    })
    .map(t => ({
      title:    t.title,
      artist:   t.artist?.name,
      isrc:     t.isrc,
      deezerId: t.id,
      bpm:      t.bpm ?? null,
    }));
}

// Fetch top tracks from artists Deezer considers similar to the seed.
// This is the big variety lever — one seed artist's `/related` returns up to 20 similar
// artists; we pick the top `artistLimit` and fetch `tracksPerArtist` top tracks each.
// The resulting tracks still flow through the scorer, so BPM/era/genre gates still apply.
async function getDeezerSimilarArtistTracks(artistDeezerId, artistLimit = 3, tracksPerArtist = 8) {
  const relRes  = await fetch(`${DEEZER_BASE}/artist/${artistDeezerId}/related?limit=${artistLimit}`);
  const relData = await relRes.json();
  const related = relData.data ?? [];
  if (!related.length) return [];

  const topLists = await Promise.all(
    related.map(a =>
      fetch(`${DEEZER_BASE}/artist/${a.id}/top?limit=${tracksPerArtist}`)
        .then(r => r.json())
        .then(d => (d.data ?? []).map(t => ({ ...t, _seedArtistName: a.name, _seedArtistId: a.id })))
        .catch(() => [])
    )
  );

  // Deezer's /artist/{id}/top response omits ISRC — have to fetch each track individually
  // to pick it up. Cap total enrichment to keep the latency reasonable.
  const flat     = topLists.flat().slice(0, 24);
  const enriched = await Promise.all(flat.map(async t => {
    if (t.isrc) return t;
    try {
      const r = await fetch(`${DEEZER_BASE}/track/${t.id}`);
      const d = await r.json();
      if (d.error) return null;
      return { ...t, isrc: d.isrc, bpm: d.bpm ?? t.bpm };
    } catch { return null; }
  }));

  return enriched
    .filter(t => t?.isrc)
    .map(t => ({
      title:          t.title,
      artist:         t.artist?.name ?? t._seedArtistName,
      artistDeezerId: t._seedArtistId,
      isrc:           t.isrc,
      deezerId:       t.id,
      bpm:            t.bpm ?? null,
      duration:       t.duration,
    }));
}

// Search Deezer for an artist by name, return their Deezer ID.
async function searchDeezerArtist(name) {
  const q   = encodeURIComponent(name);
  const res = await fetch(`${DEEZER_BASE}/search/artist?q=${q}&limit=1`);
  const data = await res.json();
  const artist = data.data?.[0];
  if (!artist) return null;
  return { artistDeezerId: artist.id, artistName: artist.name };
}

// Look up the original first-release-date for an ISRC via MusicBrainz.
// Apple Music and Deezer both return the *remaster* release date for catalog
// reissues, which poisons era detection. MusicBrainz stores the earliest known
// release across all editions, so "Bad" (1987) stays 1987 regardless of which
// 2012 remaster ISRC you query.
async function getMusicBrainzFirstRelease(isrc) {
  if (_mbCache.has(isrc)) return _mbCache.get(isrc);
  const res = await fetch(
    `https://musicbrainz.org/ws/2/isrc/${isrc}?fmt=json`,
    { headers: { "User-Agent": "Timbre-Segue/0.1 (safari-extension; https://github.com/markpernotto/timbresegue)" } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const dates = (data.recordings ?? [])
    .map(r => r["first-release-date"])
    .filter(Boolean);
  if (!dates.length) return null;
  // ISO string sort is stable for YYYY, YYYY-MM, YYYY-MM-DD — earliest sorts first
  const date = dates.sort()[0];
  _mbCache.set(isrc, date);
  return date;
}

// --- Debug probes: return the full raw JSON so we can inspect every available field.

async function debugDeezerFull(isrc) {
  const trackRes = await fetch(`${DEEZER_BASE}/track/isrc:${isrc}`);
  const track    = await trackRes.json();
  if (track.error) return { error: track.error };

  const [artist, artistTop, artistRelated, album] = await Promise.all([
    track.artist?.id   ? fetch(`${DEEZER_BASE}/artist/${track.artist.id}`).then(r => r.json())            : null,
    track.artist?.id   ? fetch(`${DEEZER_BASE}/artist/${track.artist.id}/top?limit=5`).then(r => r.json()) : null,
    track.artist?.id   ? fetch(`${DEEZER_BASE}/artist/${track.artist.id}/related?limit=5`).then(r => r.json()) : null,
    track.album?.id    ? fetch(`${DEEZER_BASE}/album/${track.album.id}`).then(r => r.json())              : null,
  ]);
  return { track, artist, artistTop, artistRelated, album };
}

async function debugMusicBrainzFull(isrc) {
  // Minimal, universally-supported inc params for ISRC lookups. Some ISRCs 400 on ratings or
  // releases combos, so stick to the reliable trio.
  const url = `https://musicbrainz.org/ws/2/isrc/${isrc}?inc=artists+genres+tags&fmt=json`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Timbre-Segue/0.1 (safari-extension; https://github.com/markpernotto/timbresegue)" },
  });
  if (!res.ok) return { error: `HTTP ${res.status}`, url };
  return await res.json();
}

export { getDeezerTrackByISRC, getDeezerRadio, getDeezerSimilarArtistTracks, searchDeezerByBPM, searchDeezerByBPMWide, searchDeezerArtist, getMusicBrainzFirstRelease, debugDeezerFull, debugMusicBrainzFull };
