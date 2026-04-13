# Initial build — 2026-04-13

## What was built

A Firefox Manifest V3 extension that intercepts subtitle (VTT) files on streaming
sites, sends them to the Gemini 2.5 Flash-Lite API, and skips or prompts on
explicit scenes based on AI-assigned confidence levels.

## Architecture

### VTT interception
`webRequest.onCompleted` in the background service worker watches for URLs that
look like subtitle files across all tabs. When one is detected on a known streaming
host, it fetches the raw VTT content directly from the background context
(cross-origin fetch works because the extension has `<all_urls>` host permission).

Alternative considered: overriding `XMLHttpRequest`/`fetch` in the content script.
Rejected — intercepting response bodies in content scripts is unreliable across
streaming sites (some use Service Workers for media, some use encrypted URLs).

### Gemini model
`gemini-2.5-flash-lite` was chosen (as specified). The prompt requests
`responseMimeType: "application/json"` to get clean JSON back without markdown
fences. Temperature is 0.1 to reduce creative/hallucinated ranges. The prompt
explicitly asks Gemini to use timestamps from the subtitle file and to expand
ranges by 5–10 seconds.

### Skip logic
- High confidence + setting on → silent skip (set `video.currentTime = scene.end`)
- Medium/low confidence + setting on → pause + show banner, user chooses
- Any confidence + setting off → skip silently (treated as dismissed in session)

Dismissed scenes are stored in a per-session array so the banner does not re-appear
if the user seeks back. Skipped scenes are tracked similarly.

Seek detection: if `currentTime` jumps by >5 s between polls, session skip records
for ranges the user has re-entered are cleared so they can be re-evaluated.

### Storage
- `cache_<movieTitle>` — full skip list, used to avoid repeat API calls
- `history` — object keyed by title, stores scenes + skip count for the popup
- `apiKey`, `autoSkipHigh/Medium/Low` — user settings

### What was considered but rejected

- **Response body interception via `webRequestBlocking`**: Not available in MV3.
- **TTML/XML subtitle support**: Some services (older Amazon Prime) use TTML.
  Not implemented in this version — would need a TTML parser. The extension falls
  back gracefully (no subtitle detected message).
- **Per-episode caching by URL**: Would be more precise than title-based caching
  but titles are the user-visible identifier and much simpler.
- **React/Svelte for popup UI**: Overkill for a two-tab popup with no state
  management needs beyond basic DOM.
