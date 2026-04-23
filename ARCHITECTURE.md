# Architecture

## Overview

Timbre is a Manifest V3 Safari extension with three independent execution contexts that communicate via message passing. No single script can do everything — MusicKit JS is only accessible from the page's own JavaScript context, but CORS-restricted API calls require either the isolated extension world or the background service worker.

```
┌─────────────────────────────────────────────────────────┐
│  music.apple.com (browser tab)                          │
│                                                         │
│  ┌─────────────────┐   postMessage   ┌───────────────┐ │
│  │  page-bridge.js │ ◄─────────────► │ content-      │ │
│  │  (MAIN world)   │                 │ script.js     │ │
│  │                 │                 │ (isolated)    │ │
│  │  MusicKit API   │                 │               │ │
│  └─────────────────┘                 └───────┬───────┘ │
│                                              │         │
└──────────────────────────────────────────────┼─────────┘
                                               │ chrome.runtime
                                    ┌──────────▼──────────┐
                                    │  service-worker.js  │
                                    │  (background)       │
                                    │                     │
                                    │  Deezer API calls   │
                                    └─────────────────────┘
```

## The two content scripts

**`page-bridge.js` (MAIN world)** runs in the same JavaScript context as music.apple.com itself, giving it direct access to `MusicKit.getInstance()`. It does two things:

1. Listens for MusicKit events (`nowPlayingItemDidChange`, `queueItemsDidChange`) and forwards them to the content script via `window.postMessage`.
2. Handles `PLAY_NEXT` commands from the content script — fetching a song from the Apple Music catalog via `mk.api.music()`, wrapping it as a `MusicKit.MediaItem`, and inserting it directly into MusicKit's internal queue (`_itemIDs` and `_queueItems`). The public `playNext()` API doesn't work reliably for this use case.

**`content-script.js` (isolated world)** runs the recommendation pipeline. It receives track events from the page bridge, calls Deezer via the service worker, calls the Apple Music catalog API directly (using tokens received from the page bridge), scores candidates, and tells the page bridge what to queue next.

**`service-worker.js` (background)** exists solely to make Deezer API calls. Content scripts are subject to CORS restrictions; the background service worker is not.

## Recommendation pipeline

When a track starts playing, this sequence runs:

1. **Enrich now-playing track** — look up genre tags from the Apple Music catalog (MusicKit doesn't always expose them). Then wait up to 1 second for Deezer to return BPM data before proceeding, so the profile has tempo info from the first track onward.

2. **Build vibe profile** — from the last 5 tracks played: average BPM (±15 tolerance), dominant genre (by frequency), and dominant decade.

3. **Gather candidates** — two sources run together:
   - If a genre is forced: fetch Apple Music's genre chart for that genre (up to 50 songs, genre-correct by definition)
   - Deezer BPM range search (neutral query terms — genre names match song *titles* on Deezer, not actual genre, so we never pass genre as the search term)
   - If no genre is forced and we have a seed artist: Deezer artist radio

4. **Resolve Deezer candidates** — Deezer tracks only have ISRCs, not Apple Music attributes. Each one is resolved via the Apple Music catalog API to get genre tags, release date, and Apple Music track ID. Genre chart songs already have all attributes and skip this step.

5. **Score each candidate** — `scoreCandidate()` in `matcher.js`:

   | Dimension | Max points | How |
   |---|---|---|
   | Genre | 3 | Any overlap between candidate tags and expanded profile genre aliases = full 3 points. Binary — extra tags don't add more. |
   | BPM | 3 | Proportional to closeness within ±15 BPM tolerance. 0 delta = 3pts, at the edge = ~0pts. Penalty of -1 if outside tolerance. |
   | Era | 2 | Exact decade match = 2pts. Adjacent decade = 1pt. No match = 0pts. Hard exclude if era is explicitly forced and decade doesn't match. |

   Maximum possible score: **8**. Hard excludes (return -1, never queued): already-queued track IDs, recently played artists, candidates with zero overlap against the forced genre's core alias set.

6. **Select winner** — highest scoring candidate above the threshold. If nothing qualifies and genre is forced, the slot is skipped (rather than degrading to wrong-genre tracks). If genre is not forced, fallbacks progressively loosen the threshold, then drop era constraints entirely.

7. **Insert into queue** — winner's Apple Music ID is sent to the page bridge, which inserts it into MusicKit's queue at position+1.

## Genre matching

Apple Music's genre taxonomy doesn't match user-facing labels. "Indie" isn't an Apple Music genre tag — "Alternative", "Indie Rock", and "Chamber Pop" are. Two maps handle this:

- **`GENRE_ALIASES`** (broad) — used for scoring. Includes crossover tags so adjacent-genre tracks still earn points.
- **`GENRE_CORE`** (tight) — used only for the forced-genre hard-exclude gate. Deliberately omits broad crossover tags (e.g. "soul", "dance") that would let clearly wrong-genre tracks through.

## Era handling

Eras are bucketed by decade from the 1960s through the 2020s. The special sentinel value `"pre1960"` matches any track released before 1960 — streaming catalog coverage before that point is too sparse for decade-level targeting to return enough candidates.

When genre and era are both forced simultaneously, era drops to soft scoring. The Apple Music genre chart only returns current/popular songs, so hard era exclusion combined with forced genre would produce nothing.

## User overrides

Overrides are applied on top of the auto-detected vibe profile, not instead of it:

| Override | Effect |
|---|---|
| **Tempo** | Shifts the BPM target ±15 BPM per click |
| **Era** | Locks decade; drops to soft scoring when genre is also forced |
| **Genre** | Switches candidate source to Apple Music genre chart; applies core alias hard-exclude |
| **Loose / Strict** | Lowers or raises the score threshold for a match |
| **Seed artist** | Resolved to a Deezer artist ID; used as the artist radio seed instead of the current track's artist |

Overrides are cleared on every page load. The engine always starts fresh from what you're actually listening to.

## Key files

| File | Purpose |
|---|---|
| `content/page-bridge.js` | MusicKit event forwarding and queue insertion (MAIN world) |
| `content/content-script.js` | Recommendation pipeline, API calls, popup message handling |
| `background/service-worker.js` | Deezer API proxy (CORS-exempt) |
| `lib/matcher.js` | Vibe profile builder, candidate scorer, genre alias maps |
| `lib/metadata-bridge.js` | Deezer API functions (track lookup, artist radio, BPM search) |
| `popup/popup.js` | UI state, override controls, profile display |
| `popup/popup.html` | Extension popup markup |
