# SequencerVisualizer

A web app to visualize and edit RTPBuit sequencer patterns in the native
`.rtpseq` (RTP0 binary) format. Legacy `.json` pattern files can still be
imported and exported.

## Usage

Serve the folder with any static file server and open `index.html`:

```bash
python3 -m http.server 8765
# open http://localhost:8765
```

The app auto-loads `pattern.rtpseq` if present next to `index.html`,
falling back to `data/scenes.json`. You can also drag & drop a
`.rtpseq` / `.bin` / `.json` file anywhere onto the page, or use **Open…**.

## Editing

- **Scenes** — click to select, double-click to rename.
- **Sequence cards** — 4×4 layout matching the NeoTrellis grid (row 0 at the
  bottom). Shows type, MIDI channel, port, clock divider, page count and a
  mini step preview colored by the sequence's own color index.
- **Editor** — type, MIDI channel, port, input, clock divider, page length,
  color and enabled flag.
- **Step grid** — click selects a step, double-click toggles it, mouse wheel
  adjusts velocity, shift+wheel adjusts note length.
- **Note inspector** — edit note number, read value, velocity, length and
  literal-pitch flag for the selected step.

**Save .rtpseq** downloads a byte-exact RTP0 v3 binary that the firmware
loads directly (e.g. as `p00s00.rtpseq` in the pattern bank).
**Export JSON** produces the legacy firmware-compatible JSON (note pitch is
not preserved by that format).

## ESP32 serving

The app is dependency-free vanilla JS/CSS/HTML — no CDN, fonts or build
step — so it can be served straight from LittleFS/PROGMEM on an ESP32.
Optionally gzip the assets (`app.js.gz`, `styles.css.gz`, `index.html.gz`)
and serve them with `Content-Encoding: gzip` to save flash. To load a
pattern hosted on the device, place it at `/pattern.rtpseq` (the auto-load
path) or extend `init()` in `app.js` to fetch a file list endpoint.
