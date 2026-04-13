// metadata-bridge.js
// Deezer API calls — runs in background service worker (CORS-exempt).

const DEEZER_BASE = "https://api.deezer.com";

// Look up a track by ISRC — returns BPM, Deezer track ID, and artist Deezer ID
async function getDeezerTrackByISRC(isrc) {
  const res = await fetch(`${DEEZER_BASE}/track/isrc:${isrc}`);
  const data = await res.json();
  if (data.error) return null;
  return {
    bpm:            data.bpm ?? 0,
    duration:       data.duration,
    deezerId:       data.id,
    artistDeezerId: data.artist?.id ?? null,
    isrc:           data.isrc,
  };
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
        if (d.error) { console.log("[AML metadata] Track enrich error for", t.id, d.error); return null; }
        return { ...t, isrc: d.isrc, bpm: d.bpm ?? t.bpm };
      } catch (e) { console.log("[AML metadata] Track enrich fetch failed:", e?.message); return null; }
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
async function searchDeezerByBPM(bpmMin, bpmMax, limit = 25, genre = null) {
  const q   = encodeURIComponent(genre ?? BPM_FALLBACK_QUERIES[Math.floor(Math.random() * BPM_FALLBACK_QUERIES.length)]);
  const url = `${DEEZER_BASE}/search/track?q=${q}&bpm_min=${bpmMin}&bpm_max=${bpmMax}&limit=${limit}`;
  const res  = await fetch(url);
  const data = await res.json();
  const BEAT_PATTERN = /\b(instrumental|beat mix|rap beat|hip hop beat|trap beat|beatmaker|type beat|backing track|karaoke)\b/i;
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
  const res = await fetch(
    `https://musicbrainz.org/ws/2/isrc/${isrc}?fmt=json`,
    { headers: { "User-Agent": "AppleMusicLover/0.1 (safari-extension; https://github.com/markpernotto/AppleMusicLover)" } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const dates = (data.recordings ?? [])
    .map(r => r["first-release-date"])
    .filter(Boolean);
  if (!dates.length) return null;
  // ISO string sort is stable for YYYY, YYYY-MM, YYYY-MM-DD — earliest sorts first
  return dates.sort()[0];
}

export { getDeezerTrackByISRC, getDeezerRadio, searchDeezerByBPM, searchDeezerArtist, getMusicBrainzFirstRelease };
