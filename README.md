# Apple Music Lover

A Safari browser extension that replaces Apple Music's default autoplay with metadata-driven recommendations — matching tempo, genre, and era instead of popularity.

## What it does

When you listen on music.apple.com, Apple Music Lover watches what you play and builds a vibe profile from your recent tracks: average BPM, dominant genre, and dominant decade. As your queue runs low, it finds new tracks that match that profile and inserts them silently — so playback never stops and never drifts too far from where you started.

You can also override any dimension manually: lock to a specific genre, steer toward an era, shift the tempo up or down, or seed the recommendations from a specific artist.

## Privacy

Every track you listen to sends its ISRC code to two third-party services:

- **Deezer** — to look up BPM, track duration, and artist radio
- **Apple Music catalog API** — to resolve genre metadata

This means both services can infer your listening history. Your Apple Music credentials never leave your device. All preference data is stored locally. See the in-extension disclosure for full details.

## Getting started

The extension runs on `music.apple.com` in Safari. Build and load it via Xcode:

```
cd extension
npm install
npm run build
```

Then open the Xcode project in `xcode/` and run it targeting your device or simulator.

## How it works

See [USERGUIDE.md](USERGUIDE.md) for how to use the controls and how they interact.

See [ARCHITECTURE.md](ARCHITECTURE.md) for a full breakdown of the recommendation pipeline, the two-script isolation model, and the scoring system.
