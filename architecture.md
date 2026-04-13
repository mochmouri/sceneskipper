# Architecture — SceneSkipper

## Overview

SceneSkipper is a Firefox Manifest V3 extension. It has three moving parts:
a background service worker, a content script injected into streaming pages,
and a popup UI.

```
┌─────────────────────────────────────────────────────────┐
│  Streaming page (Netflix, Prime, etc.)                  │
│                                                         │
│  ┌──────────────┐     messages      ┌────────────────┐  │
│  │  content.js  │ ◄──────────────── │ background.js  │  │
│  │              │ ──RETRY/SKIPPED──►│ (service       │  │
│  │  - finds     │                   │  worker)       │  │
│  │    <video>   │                   │                │  │
│  │  - polls     │                   │ - webRequest   │  │
│  │    currentTime                   │   listener     │  │
│  │  - skips /   │                   │ - fetches VTT  │  │
│  │    shows     │                   │ - Gemini API   │  │
│  │    banner    │                   │ - storage      │  │
│  └──────────────┘                   └───────┬────────┘  │
│                                             │           │
└─────────────────────────────────────────────┼───────────┘
                                              │ messages
                              ┌───────────────▼────────┐
                              │  popup.html / popup.js  │
                              │  - History tab          │
                              │  - Settings tab         │
                              └─────────────────────────┘
```

---

## Data flow

```
1. User starts playback with subtitles on
         │
         ▼
2. Browser loads a .vtt subtitle file
         │
         ▼
3. background.js: webRequest.onCompleted fires
   → checks tab is a streaming site
   → stores { vttUrl, movieTitle } for the tab
         │
         ▼
4. background.js: fetches the VTT URL (cross-origin, credentialless)
   → parses VTT into [{ start, end, text }]
         │
         ▼
5. background.js: checks storage for cached skip list
   → cache hit  → sends SKIP_LIST to content.js immediately
   → cache miss → calls Gemini API
         │
         ▼
6. Gemini 2.5 Flash-Lite returns JSON array
   [{ start, end, confidence, reason }]
         │
         ▼
7. background.js: stores in cache + history, sends SKIP_LIST to content.js
         │
         ▼
8. content.js: converts timestamps to seconds, stores skip list
   → polls video.currentTime every 500 ms
   → on match:
       high + setting on  → silent skip
       medium/low + on    → pause + show banner
```

---

## Components

### `background.js` (service worker)

| Responsibility | Detail |
|---|---|
| VTT detection | `webRequest.onCompleted` on `<all_urls>`, filtered by URL pattern and tab host |
| VTT fetch | Plain `fetch()` with `credentials: 'omit'`; works because extension has `<all_urls>` host permission |
| VTT parsing | Regex-based cue extractor; handles `HH:MM:SS.mmm` and `MM:SS.mmm`, strips HTML tags |
| Gemini call | POST to `generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent` with `responseMimeType: application/json` and `temperature: 0.1` |
| Caching | `storage.local` key `cache_<movieTitle>` → `{ skipList, processedAt }` |
| History | `storage.local` key `history` → object keyed by title, tracks scene list and skip count |
| Message bus | Handles `GET_SETTINGS`, `SAVE_SETTINGS`, `GET_HISTORY`, `CLEAR_HISTORY_ITEM`, `CLEAR_ALL_HISTORY`, `SCENE_SKIPPED`, `RETRY_ANALYSIS` |

### `content.js` (injected into streaming pages)

| Responsibility | Detail |
|---|---|
| Video discovery | Queries all `<video>` elements, picks the one with the longest duration; watches for DOM changes via `MutationObserver` to handle SPA navigation |
| Playback polling | `setInterval` at 500 ms; skips tick when paused or ended |
| Seek detection | If `currentTime` jumps >5 s, clears session skip records for ranges the user re-entered |
| Skip execution | Sets `video.currentTime = scene.end`; notifies background to increment skip counter |
| Banner | Fixed-position overlay injected into `document.body`; pauses video; removed on user action |
| Status pill | Small non-interactive indicator in top-right corner; auto-hides after 5 s except on errors |
| Session state | `dismissedRanges` and `skippedRanges` prevent repeat triggers within a session |

### `popup.html` / `popup.js`

Two-tab popup with no framework dependency.

- **History tab** — reads `GET_HISTORY` from background; renders collapsible cards per movie with per-scene confidence, timestamp, and reason; supports per-movie and bulk delete.
- **Settings tab** — reads/writes `GET_SETTINGS` / `SAVE_SETTINGS`; stores API key and three auto-skip toggles.

---

## Storage schema

```
storage.local {
  apiKey:          string,         // Gemini API key
  autoSkipHigh:    boolean,        // default true
  autoSkipMedium:  boolean,        // default true
  autoSkipLow:     boolean,        // default false

  history: {
    "<movieTitle>": {
      movieTitle:   string,
      processedAt:  number,        // unix ms
      scenesSkipped:number,
      scenes: [
        { start, end, confidence, reason }  // timestamps as strings
      ]
    }
  },

  "cache_<movieTitle>": {
    skipList:     [...],           // same shape as scenes above
    processedAt:  number
  }
}
```

---

## Permissions

| Permission | Why |
|---|---|
| `webRequest` | Detect VTT file loads across all tabs |
| `storage` | Persist API key, settings, history, cache |
| `tabs` | Read tab URL and title to identify streaming tabs and movie title |
| `host_permissions: <all_urls>` | Intercept subtitle requests from any CDN; fetch VTT content cross-origin from the service worker |

---

## Known limitations

- **TTML/XML subtitles** — some older Amazon Prime content uses TTML instead of VTT; not currently parsed.
- **Encrypted / tokenised CDN URLs** — if a CDN URL expires between the `webRequest` event and the background re-fetch, the fetch will fail with a 403. A retry button is shown in this case.
- **Shadow DOM players** — if a streaming site moves its `<video>` element into a closed shadow root, `document.querySelectorAll('video')` will not find it.
- **Service worker lifetime** — Firefox MV3 service workers can be terminated by the browser when idle. The `tabState` map lives in memory; if the worker is killed and restarted between VTT detection and the content script message, the state is lost. In practice the worker stays alive during active playback.
