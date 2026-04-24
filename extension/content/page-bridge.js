// page-bridge.js
// Injected into the PAGE's JS context (not the extension's isolated world).
// Has direct access to MusicKit.getInstance().
// Communicates with content-script.js via window.postMessage.

(function () {
  // Guard against re-injection on SPA navigation (Safari re-runs content scripts
  // on pushState/popstate without a full page reload, causing duplicate listeners).
  if (window.__AML_BRIDGE_INIT__) return;
  window.__AML_BRIDGE_INIT__ = true;

  const PREFIX = "AML_";

  // Debug helper exposed on the page's main-world window so it's reachable from
  // Safari's DevTools console (content-script globals live in an isolated sandbox).
  window.tsDump = function tsDump() {
    return new Promise(resolve => {
      const id = Math.random().toString(36).slice(2);
      const handler = ev => {
        if (ev.source !== window || ev.data?.type !== `${PREFIX}DEBUG_DUMP_REPLY` || ev.data.id !== id) return;
        window.removeEventListener("message", handler);
        console.log("[TS DEBUG] MusicKit  :", ev.data.result?.musickit);
        console.log("[TS DEBUG] Apple full:", ev.data.result?.apple);
        console.log("[TS DEBUG] Deezer    :", ev.data.result?.deezer);
        console.log("[TS DEBUG] MB full   :", ev.data.result?.musicbrainz);
        resolve(ev.data.result);
      };
      window.addEventListener("message", handler);
      window.postMessage({ type: `${PREFIX}DEBUG_DUMP`, id }, "*");
    });
  };

  function getMK() {
    return typeof MusicKit !== "undefined" ? MusicKit.getInstance() : null;
  }

  function extractTrack(item) {
    if (!item) return null;
    return {
      id:               item.id,
      title:            item.title,
      artistName:       item.artistName,
      albumName:        item.albumName,
      isrc:             item.isrc,
      genreNames:       item.genreNames ?? [],
      releaseDate:      item.releaseDate,
      durationInMillis: item.durationInMillis,
    };
  }

  function waitForMK(retries = 20) {
    const mk = getMK();
    if (mk) return Promise.resolve(mk);
    if (retries <= 0) return Promise.reject(new Error("MusicKit not found"));
    return new Promise(r => setTimeout(r, 500)).then(() => waitForMK(retries - 1));
  }

  // Listen for commands from content script
  window.addEventListener("message", e => {
    if (e.source !== window || !e.data?.type?.startsWith(PREFIX)) return;
    const mk = getMK();

    if (!mk) return;
    switch (e.data.type) {
      case `${PREFIX}PLAY_NEXT`: {
        const songId   = e.data.id;
        const rawSong  = e.data.rawSong; // pre-fetched by content script (CORS-exempt)
        const afterIds = new Set(e.data.afterIds ?? []);
        const q        = mk.queue;

        function insertSong(song) {
          const mediaItem = new MusicKit.MediaItem(song);
          const pos  = q._position ?? 0;
          const ids  = q._itemIDs ?? [];

          // Insert AFTER the last of our already-queued tracks (FIFO order).
          // Default to pos+1 if none are found (first track we're queuing).
          let insertAt = pos + 1;
          for (let i = ids.length - 1; i > pos; i--) {
            if (afterIds.has(ids[i])) { insertAt = i + 1; break; }
          }

          q._itemIDs.splice(insertAt, 0, songId);
          q._queueItems.splice(insertAt, 0, { isAutoplay: false, item: mediaItem });
          window.postMessage({ type: `${PREFIX}PLAY_NEXT_OK`, id: songId }, "*");
        }

        if (rawSong) {
          // Content script already fetched this via api.music.apple.com (CORS-exempt in
          // isolated world). Use it directly — avoids the amp-api.music.apple.com CORS block
          // that hits mk.api.music() from the MAIN world.
          try { insertSong(rawSong); } catch (err) {
            console.error("[TS bridge] MediaItem construction failed:", err?.message ?? err);
          }
        } else {
          // Fallback: fetch via MusicKit (may hit CORS on some clients)
          const storefront = mk.storefrontId ?? "us";
          mk.api.music(`/v1/catalog/${storefront}/songs/${songId}`)
            .then(response => {
              const song = response.data.data?.[0];
              if (!song) throw new Error(`Song ${songId} not found`);
              insertSong(song);
            })
            .catch(err => console.error("[TS bridge] FAILED:", err?.message ?? err));
        }
        break;
      }

      case `${PREFIX}CLEAR_QUEUED`: {
        // Remove previously-inserted tracks from the queue when filters change.
        // Skips the currently-playing position and anything before it.
        const idsToRemove = new Set(e.data.ids ?? []);
        const q2 = mk?.queue;
        if (q2 && idsToRemove.size) {
          const pos = q2._position ?? 0;
          // Walk backwards so splice indices stay valid
          for (let i = (q2._itemIDs?.length ?? 0) - 1; i > pos; i--) {
            if (idsToRemove.has(q2._itemIDs[i])) {
              q2._itemIDs.splice(i, 1);
              q2._queueItems?.splice(i, 1);
            }
          }
        }
        break;
      }

      case `${PREFIX}GET_QUEUE`:
        window.postMessage({
          type:     `${PREFIX}QUEUE`,
          items:    mk.queue.items.map(extractTrack),
          position: mk.queue.position,
        }, "*");
        break;

      case `${PREFIX}GET_NOW_PLAYING`:
        window.postMessage({
          type:  `${PREFIX}NOW_PLAYING`,
          track: extractTrack(mk.nowPlayingItem),
        }, "*");
        break;

      case `${PREFIX}GET_TOKENS`:
        // Content script requests re-handshake after returning from background.
        window.postMessage({
          type:         `${PREFIX}TOKENS`,
          dev:          mk.developerToken,
          user:         mk.musicUserToken,
          storefront:   mk.storefrontId ?? "us",
          isAuthorized: mk.isAuthorized,
        }, "*");
        break;
    }
  });

  // Push events to content script
  waitForMK().then(mk => {
    console.log("[TS bridge] MusicKit connected");

    mk.addEventListener("nowPlayingItemDidChange", () => {
      window.postMessage({
        type:  `${PREFIX}NOW_PLAYING_CHANGED`,
        track: extractTrack(mk.nowPlayingItem),
      }, "*");
      // Also send current queue state — queueItemsDidChange doesn't fire on position advance
      window.postMessage({
        type:     `${PREFIX}QUEUE_CHANGED`,
        items:    mk.queue.items.map(extractTrack),
        position: mk.queue.position,
      }, "*");
    });

    mk.addEventListener("queueItemsDidChange", () => {
      window.postMessage({
        type:     `${PREFIX}QUEUE_CHANGED`,
        items:    mk.queue.items.map(extractTrack),
        position: mk.queue.position,
      }, "*");
    });

    // Send tokens to content script
    window.postMessage({
      type:         `${PREFIX}TOKENS`,
      dev:          mk.developerToken,
      user:         mk.musicUserToken,
      storefront:   mk.storefrontId ?? "us",
      isAuthorized: mk.isAuthorized,
    }, "*");

    // Send current state immediately
    window.postMessage({
      type:  `${PREFIX}NOW_PLAYING_CHANGED`,
      track: extractTrack(mk.nowPlayingItem),
    }, "*");

  }).catch(err => console.error("[TS bridge]", err));
})();
