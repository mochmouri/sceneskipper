// background.js — service worker
// Handles: VTT interception, Gemini API calls, caching, storage

const STREAMING_HOSTS = [
  'netflix.com', 'primevideo.com', 'disneyplus.com',
  'hbomax.com', 'max.com', 'hulu.com', 'peacocktv.com'
];

// Map of tabId -> { vttUrl, movieTitle }
const tabState = new Map();
// Set of tabIds currently being processed
const processing = new Set();

// ── VTT interception ─────────────────────────────────────────────────────────

browser.webRequest.onCompleted.addListener(
  async (details) => {
    if (details.tabId < 0) return;

    const url = details.url;
    if (!looksLikeSubtitle(url)) return;

    // Only handle tabs on streaming sites
    let tab;
    try {
      tab = await browser.tabs.get(details.tabId);
    } catch {
      return;
    }
    if (!tab || !isStreamingTab(tab.url)) return;

    const tabId = details.tabId;
    const existing = tabState.get(tabId);

    // Avoid reprocessing the same URL
    if (existing && existing.vttUrl === url) return;

    const movieTitle = extractMovieTitle(tab.title);
    tabState.set(tabId, { vttUrl: url, movieTitle });

    notifyContent(tabId, { type: 'VTT_DETECTED' });
    scheduleProcessing(tabId);
  },
  { urls: ['<all_urls>'] }
);

function looksLikeSubtitle(url) {
  const lower = url.toLowerCase();
  // Match .vtt files; exclude manifest/playlist files
  if (lower.includes('.vtt')) return true;
  // Some services use query params instead of extensions
  if ((lower.includes('subtitle') || lower.includes('caption')) &&
      (lower.includes('format=vtt') || lower.includes('type=vtt'))) return true;
  return false;
}

function isStreamingTab(url) {
  if (!url) return false;
  return STREAMING_HOSTS.some(h => url.includes(h));
}

function extractMovieTitle(rawTitle) {
  if (!rawTitle) return 'Unknown Title';
  // Strip common streaming site suffixes
  return rawTitle
    .replace(/\s*[|\-–]\s*(Netflix|Prime Video|Disney\+|Max|Hulu|Peacock).*$/i, '')
    .replace(/\s*[|\-–]\s*Watch.*$/i, '')
    .trim() || rawTitle.trim();
}

// Slight delay so the tab title has time to update after VTT load
function scheduleProcessing(tabId) {
  setTimeout(() => processTab(tabId), 1500);
}

// ── Main processing pipeline ──────────────────────────────────────────────────

async function processTab(tabId) {
  if (processing.has(tabId)) return;

  const state = tabState.get(tabId);
  if (!state) return;

  const { apiKey } = await browser.storage.local.get('apiKey');
  if (!apiKey) {
    notifyContent(tabId, { type: 'NO_API_KEY' });
    return;
  }

  // Re-read title in case it updated
  try {
    const tab = await browser.tabs.get(tabId);
    if (tab.title) state.movieTitle = extractMovieTitle(tab.title);
  } catch { /* tab may have closed */ }

  const { movieTitle, vttUrl } = state;

  // Check cache first
  const cacheKey = `cache_${movieTitle}`;
  const stored = await browser.storage.local.get(cacheKey);
  if (stored[cacheKey]) {
    notifyContent(tabId, {
      type: 'SKIP_LIST',
      skipList: stored[cacheKey].skipList,
      movieTitle,
      fromCache: true
    });
    return;
  }

  processing.add(tabId);
  notifyContent(tabId, { type: 'PROCESSING_START', movieTitle });

  try {
    const vttText = await fetchVtt(vttUrl);
    const subtitles = parseVtt(vttText);

    if (subtitles.length === 0) {
      throw new Error('No subtitle cues found in the VTT file.');
    }

    const skipList = await callGemini(subtitles, movieTitle, apiKey);
    await cacheResult(movieTitle, skipList);

    notifyContent(tabId, { type: 'SKIP_LIST', skipList, movieTitle, fromCache: false });
  } catch (err) {
    notifyContent(tabId, { type: 'PROCESSING_ERROR', error: err.message });
  } finally {
    processing.delete(tabId);
  }
}

// ── VTT fetch & parse ─────────────────────────────────────────────────────────

async function fetchVtt(url) {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`Failed to fetch subtitles (HTTP ${res.status}).`);
  return res.text();
}

function parseVtt(text) {
  const subtitles = [];
  // Normalise line endings
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  let i = 0;

  // Skip WEBVTT header block
  while (i < lines.length && !lines[i].includes('-->')) i++;

  while (i < lines.length) {
    const line = lines[i].trim();

    if (line.includes('-->')) {
      const tsMatch = line.match(
        /(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}|\d{2}:\d{2}[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}|\d{2}:\d{2}[.,]\d{1,3})/
      );
      if (tsMatch) {
        const start = normaliseTs(tsMatch[1]);
        const end   = normaliseTs(tsMatch[2]);
        const textParts = [];
        i++;
        while (i < lines.length && lines[i].trim() !== '') {
          const clean = lines[i].replace(/<[^>]+>/g, '').trim();
          if (clean) textParts.push(clean);
          i++;
        }
        if (textParts.length > 0) {
          subtitles.push({ start, end, text: textParts.join(' ') });
        }
        continue;
      }
    }
    i++;
  }

  return subtitles;
}

// Normalise VTT timestamp → HH:MM:SS.mmm
function normaliseTs(ts) {
  const clean = ts.replace(',', '.');
  const parts = clean.split(':');
  if (parts.length === 2) {
    // MM:SS.mmm → 00:MM:SS.mmm
    return `00:${parts[0].padStart(2,'0')}:${parts[1]}`;
  }
  return `${parts[0].padStart(2,'0')}:${parts[1]}:${parts[2]}`;
}

// ── Gemini API ────────────────────────────────────────────────────────────────

async function callGemini(subtitles, movieTitle, apiKey) {
  const subtitleText = subtitles
    .map(s => `[${s.start} --> ${s.end}] ${s.text}`)
    .join('\n');

  const prompt = `You are a content filter assistant helping families avoid explicit scenes in movies and TV shows.

Analyse the following subtitles from "${movieTitle}" and identify any scenes containing sexual content, nudity, or explicit adult material. Do NOT flag violence, gore, or strong language.

Flag scenes based on:
- Explicit or suggestive sexual dialogue
- Sound cues such as [moaning], [kissing sounds], [breathing heavily], [gasping], [sighing]
- Clear romantic/sexual escalation leading to or implying intercourse
- Dialogue or context implying nudity or sexual acts occurring off-screen

Confidence guide:
- high: explicit dialogue, unmistakable sound cues, direct sexual content
- medium: strong contextual indicators, physical escalation, implied sexual encounter
- low: ambiguous — could be innocent but context suggests possible adult content

Return ONLY a JSON array — no prose, no markdown fences. If no scenes qualify, return [].

Format:
[{"start":"HH:MM:SS","end":"HH:MM:SS","confidence":"high|medium|low","reason":"brief plain-English description"}]

The start/end times must match timestamps present in the subtitles. Expand the range slightly (5–10 seconds before and after) to ensure the skip covers the whole scene.

SUBTITLES:
${subtitleText}`;

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json'
      }
    })
  });

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch {}
    throw new Error(`Gemini API error ${res.status}${detail ? ': ' + detail : ''}.`);
  }

  const data = await res.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error('Gemini returned an empty response.');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Try to extract a JSON array from the text
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('Could not parse Gemini response as JSON.');
    parsed = JSON.parse(match[0]);
  }

  if (!Array.isArray(parsed)) throw new Error('Gemini response was not a JSON array.');
  return parsed;
}

// ── Storage helpers ───────────────────────────────────────────────────────────

async function cacheResult(movieTitle, skipList) {
  const cacheKey = `cache_${movieTitle}`;
  await browser.storage.local.set({
    [cacheKey]: { skipList, processedAt: Date.now() }
  });

  const { history = {} } = await browser.storage.local.get('history');
  if (!history[movieTitle]) {
    history[movieTitle] = {
      movieTitle,
      processedAt: Date.now(),
      scenesSkipped: 0,
      scenes: skipList
    };
  } else {
    history[movieTitle].scenes = skipList;
    history[movieTitle].processedAt = Date.now();
  }
  await browser.storage.local.set({ history });
}

// ── Notify content script (fire-and-forget) ───────────────────────────────────

function notifyContent(tabId, msg) {
  browser.tabs.sendMessage(tabId, msg).catch(() => {});
}

// ── Message handler ───────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((msg, sender) => {
  switch (msg.type) {

    case 'RETRY_ANALYSIS': {
      const tabId = sender.tab?.id;
      if (tabId != null) {
        processing.delete(tabId);
        processTab(tabId);
      }
      return Promise.resolve(true);
    }

    case 'SCENE_SKIPPED': {
      return (async () => {
        const { movieTitle } = msg;
        const { history = {} } = await browser.storage.local.get('history');
        if (history[movieTitle]) {
          history[movieTitle].scenesSkipped = (history[movieTitle].scenesSkipped || 0) + 1;
          await browser.storage.local.set({ history });
        }
        return true;
      })();
    }

    case 'GET_HISTORY':
      return browser.storage.local.get('history').then(s => s.history || {});

    case 'CLEAR_HISTORY_ITEM': {
      return (async () => {
        const { movieTitle } = msg;
        const { history = {} } = await browser.storage.local.get('history');
        delete history[movieTitle];
        await browser.storage.local.set({ history });
        await browser.storage.local.remove(`cache_${movieTitle}`);
        return true;
      })();
    }

    case 'CLEAR_ALL_HISTORY': {
      return (async () => {
        const { history = {} } = await browser.storage.local.get('history');
        const cacheKeys = Object.keys(history).map(t => `cache_${t}`);
        await browser.storage.local.remove(['history', ...cacheKeys]);
        return true;
      })();
    }

    case 'GET_SETTINGS':
      return browser.storage.local.get(['apiKey', 'autoSkipHigh', 'autoSkipMedium', 'autoSkipLow'])
        .then(s => ({
          apiKey:        s.apiKey        || '',
          autoSkipHigh:  s.autoSkipHigh  !== false,  // default on
          autoSkipMedium:s.autoSkipMedium !== false,  // default on
          autoSkipLow:   s.autoSkipLow   === true     // default off
        }));

    case 'SAVE_SETTINGS':
      return browser.storage.local.set({
        apiKey:         msg.apiKey,
        autoSkipHigh:   msg.autoSkipHigh,
        autoSkipMedium: msg.autoSkipMedium,
        autoSkipLow:    msg.autoSkipLow
      }).then(() => true);

    case 'GET_TAB_STATE': {
      const tabId = sender.tab?.id;
      if (tabId != null && tabState.has(tabId)) {
        return Promise.resolve({ ...tabState.get(tabId), processing: processing.has(tabId) });
      }
      return Promise.resolve(null);
    }
  }
});
