// background.js — service worker
// Handles: OpenSubtitles search/download, subtitle parsing, Gemini calls, caching, storage

const OS_API_BASE  = 'https://api.opensubtitles.com/api/v1';
const OS_USER_AGENT = 'SceneSkipper v1.1';

// ── OpenSubtitles ─────────────────────────────────────────────────────────────

async function searchSubtitles(query, osApiKey) {
  const params = new URLSearchParams({
    query,
    languages:       'en',
    order_by:        'download_count',
    order_direction: 'desc',
    per_page:        '10',
  });

  const res = await fetch(`${OS_API_BASE}/subtitles?${params}`, {
    headers: osHeaders(osApiKey),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Search failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const json = await res.json();
  return json.data || [];
}

async function downloadSubtitle(fileId, osApiKey) {
  const res = await fetch(`${OS_API_BASE}/download`, {
    method:  'POST',
    headers: osHeaders(osApiKey),
    body:    JSON.stringify({ file_id: fileId }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Download request failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const json = await res.json();
  if (!json.link) throw new Error(json.message || 'No download link returned.');

  const fileRes = await fetch(json.link);
  if (!fileRes.ok) throw new Error(`Failed to fetch subtitle file (${fileRes.status}).`);

  return {
    content:   await fileRes.text(),
    fileName:  json.file_name  || 'subtitle.srt',
    remaining: json.remaining  ?? null,
  };
}

function osHeaders(key) {
  return {
    'Api-Key':      key,
    'Content-Type': 'application/json',
    'User-Agent':   OS_USER_AGENT,
  };
}

// ── Subtitle parsing ──────────────────────────────────────────────────────────

function parseSubtitleContent(content, fileName) {
  const isVtt = fileName.toLowerCase().endsWith('.vtt') ||
                content.trimStart().startsWith('WEBVTT');
  return isVtt ? parseVtt(content) : parseSRT(content);
}

function parseSRT(text) {
  const subtitles = [];
  const blocks = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 2) continue;

    // First line may be a sequence number — skip it if it has no arrow
    const tIdx = lines[0].includes('-->') ? 0 : 1;
    if (tIdx >= lines.length) continue;

    const match = lines[tIdx].match(
      /(\d{1,2}:\d{2}:\d{2}[,\.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,\.]\d{1,3})/
    );
    if (!match) continue;

    const start = normaliseTs(match[1]);
    const end   = normaliseTs(match[2]);
    const parts = lines.slice(tIdx + 1)
      .map(l => l.replace(/<[^>]+>/g, '').replace(/\{[^}]+\}/g, '').trim())
      .filter(Boolean);

    if (parts.length) subtitles.push({ start, end, text: parts.join(' ') });
  }

  return subtitles;
}

function parseVtt(text) {
  const subtitles = [];
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  let i = 0;

  while (i < lines.length && !lines[i].includes('-->')) i++;

  while (i < lines.length) {
    const line = lines[i].trim();

    if (line.includes('-->')) {
      const match = line.match(
        /(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}|\d{2}:\d{2}[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}|\d{2}:\d{2}[.,]\d{1,3})/
      );
      if (match) {
        const start = normaliseTs(match[1]);
        const end   = normaliseTs(match[2]);
        const parts = [];
        i++;
        while (i < lines.length && lines[i].trim() !== '') {
          const clean = lines[i].replace(/<[^>]+>/g, '').trim();
          if (clean) parts.push(clean);
          i++;
        }
        if (parts.length) subtitles.push({ start, end, text: parts.join(' ') });
        continue;
      }
    }
    i++;
  }

  return subtitles;
}

function normaliseTs(ts) {
  const clean = ts.replace(',', '.');
  const parts = clean.split(':');
  if (parts.length === 2) return `00:${parts[0].padStart(2,'0')}:${parts[1]}`;
  return `${parts[0].padStart(2,'0')}:${parts[1]}:${parts[2]}`;
}

// ── Analysis pipeline ─────────────────────────────────────────────────────────

async function analyseSubtitle({ fileId, movieTitle, tabId }) {
  const { geminiApiKey, osApiKey } = await browser.storage.local.get(['geminiApiKey', 'osApiKey']);

  if (!geminiApiKey) throw new Error('No Gemini API key set — add it in Settings.');
  if (!osApiKey)     throw new Error('No OpenSubtitles API key set — add it in Settings.');

  // Cache hit
  const cacheKey = `cache_${movieTitle}`;
  const stored   = await browser.storage.local.get(cacheKey);
  if (stored[cacheKey]) {
    if (tabId != null) notifyContent(tabId, {
      type: 'SKIP_LIST', skipList: stored[cacheKey].skipList, movieTitle, fromCache: true
    });
    return { skipList: stored[cacheKey].skipList, fromCache: true };
  }

  // Download
  const dl        = await downloadSubtitle(fileId, osApiKey);
  const subtitles = parseSubtitleContent(dl.content, dl.fileName);
  if (subtitles.length === 0) throw new Error('No subtitle cues found in the downloaded file.');

  // Analyse
  const geminiList = await callGemini(subtitles, movieTitle, geminiApiKey);
  const gapList    = detectSilentGaps(subtitles);
  const skipList   = [
    ...geminiList,
    ...gapList.filter(gap => !geminiList.some(g => rangesOverlap(g, gap))),
  ];

  await cacheResult(movieTitle, skipList);

  if (tabId != null) notifyContent(tabId, {
    type: 'SKIP_LIST', skipList, movieTitle, fromCache: false
  });

  return { skipList, fromCache: false, remaining: dl.remaining };
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
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      contents:       [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
    }),
  });

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch {}
    throw new Error(`Gemini API error ${res.status}${detail ? ': ' + detail : ''}.`);
  }

  const data = await res.json();
  const raw  = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error('Gemini returned an empty response.');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('Could not parse Gemini response as JSON.');
    parsed = JSON.parse(match[0]);
  }

  if (!Array.isArray(parsed)) throw new Error('Gemini response was not a JSON array.');
  return parsed;
}

// ── Gap detection ─────────────────────────────────────────────────────────────

const GAP_THRESHOLD_S = 90;
const EDGE_BUFFER_S   = 300;

function detectSilentGaps(subtitles) {
  if (subtitles.length < 2) return [];
  const gaps = [];

  for (let i = 1; i < subtitles.length; i++) {
    const prevEnd   = tsToSeconds(subtitles[i - 1].end);
    const nextStart = tsToSeconds(subtitles[i].start);
    const gapLen    = nextStart - prevEnd;

    if (gapLen < GAP_THRESHOLD_S) continue;
    if (prevEnd < EDGE_BUFFER_S)  continue;

    const filmEnd = tsToSeconds(subtitles[subtitles.length - 1].end);
    if (nextStart > filmEnd - EDGE_BUFFER_S) continue;

    gaps.push({
      start:      secondsToTs(prevEnd),
      end:        secondsToTs(nextStart),
      confidence: 'low',
      reason:     `No dialogue for ${Math.round(gapLen)}s`,
    });
  }

  return gaps;
}

function rangesOverlap(a, b) {
  const aS = tsToSeconds(a.start), aE = tsToSeconds(a.end);
  const bS = tsToSeconds(b.start), bE = tsToSeconds(b.end);
  return aS < bE && bS < aE;
}

function tsToSeconds(ts) {
  if (!ts) return 0;
  const parts = String(ts).split(':').map(parseFloat);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parseFloat(ts) || 0;
}

function secondsToTs(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

// ── Storage helpers ───────────────────────────────────────────────────────────

async function cacheResult(movieTitle, skipList) {
  const cacheKey = `cache_${movieTitle}`;
  await browser.storage.local.set({
    [cacheKey]: { skipList, processedAt: Date.now() }
  });

  const { history = {} } = await browser.storage.local.get('history');
  history[movieTitle] = {
    movieTitle,
    processedAt:  Date.now(),
    scenesSkipped: history[movieTitle]?.scenesSkipped || 0,
    scenes:        skipList,
  };
  await browser.storage.local.set({ history });
}

function notifyContent(tabId, msg) {
  browser.tabs.sendMessage(tabId, msg).catch(() => {});
}

// ── Message handler ───────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((msg, sender) => {
  switch (msg.type) {

    case 'SEARCH_SUBTITLES':
      return (async () => {
        const { osApiKey } = await browser.storage.local.get('osApiKey');
        if (!osApiKey) throw new Error('No OpenSubtitles API key set — add it in Settings.');
        return searchSubtitles(msg.query, osApiKey);
      })();

    case 'ANALYSE_SUBTITLE':
      return analyseSubtitle(msg);

    case 'SCENE_SKIPPED':
      return (async () => {
        const { history = {} } = await browser.storage.local.get('history');
        if (history[msg.movieTitle]) {
          history[msg.movieTitle].scenesSkipped =
            (history[msg.movieTitle].scenesSkipped || 0) + 1;
          await browser.storage.local.set({ history });
        }
        return true;
      })();

    case 'GET_HISTORY':
      return browser.storage.local.get('history').then(s => s.history || {});

    case 'CLEAR_HISTORY_ITEM':
      return (async () => {
        const { history = {} } = await browser.storage.local.get('history');
        delete history[msg.movieTitle];
        await browser.storage.local.set({ history });
        await browser.storage.local.remove(`cache_${msg.movieTitle}`);
        return true;
      })();

    case 'CLEAR_ALL_HISTORY':
      return (async () => {
        const { history = {} } = await browser.storage.local.get('history');
        const cacheKeys = Object.keys(history).map(t => `cache_${t}`);
        await browser.storage.local.remove(['history', ...cacheKeys]);
        return true;
      })();

    case 'GET_SETTINGS':
      return browser.storage.local
        .get(['geminiApiKey', 'osApiKey', 'autoSkipHigh', 'autoSkipMedium', 'autoSkipLow'])
        .then(s => ({
          geminiApiKey:   s.geminiApiKey   || '',
          osApiKey:       s.osApiKey       || '',
          autoSkipHigh:   s.autoSkipHigh   !== false,
          autoSkipMedium: s.autoSkipMedium !== false,
          autoSkipLow:    s.autoSkipLow    === true,
        }));

    case 'SAVE_SETTINGS':
      return browser.storage.local.set({
        geminiApiKey:   msg.geminiApiKey,
        osApiKey:       msg.osApiKey,
        autoSkipHigh:   msg.autoSkipHigh,
        autoSkipMedium: msg.autoSkipMedium,
        autoSkipLow:    msg.autoSkipLow,
      }).then(() => true);
  }
});
