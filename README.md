# Timbre

A Safari browser extension that replaces Apple Music's default autoplay with metadata-driven recommendations — matching tempo, genre, and era instead of popularity.

## What it does

When you listen on music.apple.com, Timbre watches what you play and builds a vibe profile from your recent tracks: average BPM, dominant genre, and dominant decade. As your queue runs low, it finds new tracks that match that profile and inserts them silently — so playback never stops and never drifts too far from where you started.

You can also override any dimension manually: lock to a specific genre, steer toward an era, shift the tempo up or down, or seed the recommendations from a specific artist.

## Privacy

On every track play, the track's ISRC code is sent to two third-party services:

- **Deezer** — to look up BPM, duration, and artist radio data
- **MusicBrainz** — to look up the track's original release date (Apple Music returns the remaster year for catalog reissues, which breaks era detection)

Both services can infer your listening history from these requests. Your Apple Music credentials never leave your device. All preference data is stored locally. The extension shows a full disclosure on first use.

## Building from source

```
cd extension
npm install
npm run build
```

Then open `xcode/Timbre/Timbre.xcodeproj` in Xcode and run the app. Enable the extension in Safari → Settings → Extensions.

## How it works

See [USERGUIDE.md](USERGUIDE.md) for how to use the controls and how they interact.

See [ARCHITECTURE.md](ARCHITECTURE.md) for a full breakdown of the recommendation pipeline, the two-script isolation model, and the scoring system.

## Contributing

Bug reports and pull requests welcome at [github.com/markpernotto/AppleMusicLover](https://github.com/markpernotto/AppleMusicLover).

## License

MIT — see [LICENSE](LICENSE). Copyright © 2026 [Facet Build, LLC](https://facetbuild.llc).
