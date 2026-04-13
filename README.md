# SceneSkipper

Firefox extension that automatically detects and skips explicit/adult scenes on
streaming sites using AI subtitle analysis.

**Supported sites:** Netflix, Amazon Prime Video, Disney+, Max (HBO Max), Hulu, Peacock

---

## Setup

### 1. Get a Gemini API key

1. Go to [Google AI Studio](https://aistudio.google.com/app/apikey)
2. Create a free API key for the Gemini API
3. Copy the key (starts with `AIza…`)

### 2. Load the extension in Firefox

1. Open Firefox and navigate to `about:debugging`
2. Click **This Firefox** in the left sidebar
3. Click **Load Temporary Add-on…**
4. Navigate to the `sceneskipper` folder and select `manifest_sceneskip.json`
5. The extension icon (▶|) will appear in your toolbar

> **Note:** Temporary add-ons are removed when Firefox restarts. To install
> permanently you would need to sign the extension via [addons.mozilla.org](https://addons.mozilla.org/).

### 3. Add your API key

1. Click the SceneSkipper icon in the toolbar
2. Open the **Settings** tab
3. Paste your Gemini API key and click **Save settings**

---

## How it works

1. **Enable subtitles** on the streaming site before starting playback. SceneSkipper
   only works when a `.vtt` subtitle file is loaded by the page.

2. Once a subtitle file is detected, the extension sends the full subtitle text to
   Gemini 2.5 Flash-Lite with a prompt that identifies explicit scenes. This takes
   5–30 seconds depending on the film length.

3. A small status indicator appears briefly in the top-right corner of the page:
   - **⏳ Analysing…** — API call in progress
   - **✓ N scenes flagged** — done, monitoring active
   - **✗ Error…** — something went wrong (check API key)

4. During playback:
   - **High confidence** scenes are skipped immediately without interruption
   - **Medium/low confidence** scenes pause playback and show a banner with
     **Skip** and **Continue watching** options

5. Results are cached by movie title so the API is never called twice for the
   same film.

---

## Settings

| Setting | Default | Description |
|---|---|---|
| Auto-skip high confidence | On | Silently skip scenes the AI is very sure about |
| Show banner for medium | On | Pause + prompt for likely explicit scenes |
| Show banner for low | Off | Pause + prompt for ambiguous scenes |

---

## History

The **History** tab in the popup lists every film analysed, with:
- Number of scenes flagged and skipped
- Each scene's timestamp range, confidence level, and reason
- Per-movie delete button and a "Clear all" option

---

## Limitations

- Requires subtitles to be turned on — the extension cannot analyse video directly
- Works best with dialogue-heavy scenes; purely visual content with no audio cues
  in the subtitles may not be detected
- Some services use TTML/XML subtitle formats instead of VTT — these are not yet
  supported
- Caching is keyed by movie title; if a title changes (e.g., a show episode updates
  the page title) the analysis will re-run
- Temporary add-ons are removed on browser restart

---

## File structure

```
manifest_sceneskip.json   — MV3 manifest
background.js             — service worker: VTT interception, Gemini API, storage
content.js                — injected into streaming pages: video monitoring, banners
popup.html                — extension popup
popup.js                  — popup logic (history + settings tabs)
popup.css                 — popup styles
icons/                    — 16/48/128px SVG icons
notes/                    — build notes
```
