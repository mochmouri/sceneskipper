// content.js — injected into streaming pages
// Handles: video monitoring, skip logic, overlay banners

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────

  let skipList      = [];      // [{ start, end, confidence, reason }] in seconds
  let movieTitle    = '';
  let settings      = { autoSkipHigh: true, autoSkipMedium: true, autoSkipLow: false };
  let videoEl       = null;
  let pollTimer     = null;
  let lastTime      = -1;
  let activeOverlay = null;    // currently shown banner
  let dismissedRanges = [];    // ranges the user explicitly dismissed this session
  let skippedRanges   = [];    // ranges already skipped this session (avoid re-triggering)
  let status        = 'idle';  // 'idle' | 'processing' | 'ready' | 'error' | 'no_api_key' | 'no_subtitle'

  // ── Init ───────────────────────────────────────────────────────────────────

  injectStyles();
  waitForVideo();
  // Retry after 2.5 s in case the player mounts late (common on SPAs)
  setTimeout(() => { if (!videoEl) waitForVideo(); }, 2500);
  loadSettings();

  // ── Listen for messages from background ───────────────────────────────────

  browser.runtime.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'PROCESSING_START':
        movieTitle = msg.movieTitle || movieTitle;
        setStatus('processing');
        break;

      case 'SKIP_LIST':
        movieTitle = msg.movieTitle || movieTitle;
        skipList   = (msg.skipList || []).map(normaliseScene);
        setStatus('ready');
        break;

      case 'PROCESSING_ERROR':
        setStatus('error', msg.error);
        break;

      case 'NO_API_KEY':
        setStatus('no_api_key');
        break;
    }
  });

  // ── Settings ───────────────────────────────────────────────────────────────

  async function loadSettings() {
    try {
      settings = await browser.runtime.sendMessage({ type: 'GET_SETTINGS' });
    } catch {}
  }

  // ── Video detection ────────────────────────────────────────────────────────

  function waitForVideo() {
    const found = findVideo();
    if (found) return;

    const obs = new MutationObserver(() => {
      if (findVideo()) obs.disconnect();
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  function findVideo() {
    const videos = Array.from(document.querySelectorAll('video'));
    if (videos.length === 0) return false;

    // Pick the video with the largest rendered area on screen
    const largest = videos.reduce((best, v) =>
      v.offsetWidth * v.offsetHeight > best.offsetWidth * best.offsetHeight ? v : best
    );

    if (largest.offsetWidth === 0 && largest.offsetHeight === 0) return false;

    videoEl = largest;
    startPolling();
    return true;
  }

  // ── Polling ────────────────────────────────────────────────────────────────

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(tick, 500);
  }

  function tick() {
    // Re-find video if it was replaced (SPA navigation)
    if (!videoEl || !document.contains(videoEl)) {
      videoEl = null;
      findVideo();
      return;
    }

    const t = videoEl.currentTime;
    if (videoEl.paused || videoEl.ended) {
      lastTime = t;
      return;
    }

    // Detect large seek (>5 s jump) → clear session skip records
    if (Math.abs(t - lastTime) > 5 && lastTime >= 0) {
      // User seeked; allow re-evaluation of ranges
      skippedRanges = skippedRanges.filter(r => !(t >= r.start && t <= r.end));
    }
    lastTime = t;

    checkForScene(t);
  }

  function checkForScene(t) {
    if (skipList.length === 0) return;
    if (activeOverlay) return; // already showing a banner

    for (const scene of skipList) {
      // Check if we're inside this scene's range
      if (t < scene.start || t >= scene.end) continue;

      // Skip if already handled this pass
      if (skippedRanges.some(r => r.start === scene.start)) continue;
      if (dismissedRanges.some(r => r.start === scene.start)) continue;

      handleScene(scene);
      return;
    }
  }

  // ── Scene handling ─────────────────────────────────────────────────────────

  function handleScene(scene) {
    const c = scene.confidence;

    if (c === 'high' && settings.autoSkipHigh) {
      doSkip(scene, true);
      return;
    }

    if (c === 'medium' && settings.autoSkipMedium) {
      showBanner(scene, 'Explicit scene detected');
      return;
    }

    if (c === 'low' && settings.autoSkipLow) {
      showBanner(scene, 'Possible explicit scene detected');
      return;
    }

    // Confidence level not auto-enabled: do nothing (treat as dismissed)
    dismissedRanges.push(scene);
  }

  function doSkip(scene, silent) {
    if (videoEl) videoEl.currentTime = scene.end;
    skippedRanges.push(scene);
    if (!silent) removeOverlay();

    // Tell background to increment skip counter
    browser.runtime.sendMessage({
      type: 'SCENE_SKIPPED',
      movieTitle
    }).catch(() => {});
  }

  // ── Overlay banner ─────────────────────────────────────────────────────────

  function showBanner(scene, headline) {
    if (activeOverlay) return;

    // Pause while showing banner for medium/low
    if (videoEl && !videoEl.paused) videoEl.pause();

    const banner = document.createElement('div');
    banner.className = 'ss-banner';
    banner.dataset.ssOverlay = '1';

    const conf = scene.confidence.charAt(0).toUpperCase() + scene.confidence.slice(1);
    const duration = Math.round(scene.end - scene.start);

    banner.innerHTML = `
      <div class="ss-banner-inner">
        <div class="ss-banner-icon">⚠</div>
        <div class="ss-banner-text">
          <strong>${headline}</strong>
          <span>${scene.reason || ''} · ${duration}s · ${conf} confidence</span>
        </div>
        <div class="ss-banner-actions">
          <button class="ss-btn ss-btn-skip">Skip</button>
          <button class="ss-btn ss-btn-dismiss">Continue watching</button>
        </div>
      </div>`;

    banner.querySelector('.ss-btn-skip').addEventListener('click', () => {
      doSkip(scene, false);
      if (videoEl) videoEl.play();
    });

    banner.querySelector('.ss-btn-dismiss').addEventListener('click', () => {
      dismissedRanges.push(scene);
      removeOverlay();
      if (videoEl) videoEl.play();
    });

    document.body.appendChild(banner);
    activeOverlay = banner;
  }

  function removeOverlay() {
    if (activeOverlay) {
      activeOverlay.remove();
      activeOverlay = null;
    }
  }

  // ── Status indicator (tiny pill in corner) ─────────────────────────────────

  let statusPill = null;

  function setStatus(s, detail) {
    status = s;
    renderStatusPill(s, detail);
  }

  function renderStatusPill(s, detail) {
    if (!statusPill) {
      statusPill = document.createElement('div');
      statusPill.className = 'ss-status';
      document.body.appendChild(statusPill);
      // Auto-hide after 5 s for non-error states
    }

    const labels = {
      idle:         '',
      processing:   '⏳ SceneSkipper: analysing…',
      ready:        `✓ SceneSkipper: ${skipList.length} scene${skipList.length !== 1 ? 's' : ''} flagged`,
      error:        `✗ SceneSkipper error: ${detail || 'unknown error'}`,
      no_api_key:   '⚙ SceneSkipper: add API key in settings',
      no_subtitle:  'ℹ SceneSkipper: no subtitle file detected'
    };

    const text = labels[s] || '';
    if (!text) {
      statusPill.style.display = 'none';
      return;
    }

    statusPill.textContent = text;
    statusPill.className   = `ss-status ss-status-${s}`;
    statusPill.style.display = 'block';

    clearTimeout(statusPill._hideTimer);
    if (s !== 'error' && s !== 'no_api_key') {
      statusPill._hideTimer = setTimeout(() => {
        statusPill.style.display = 'none';
      }, 5000);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  function normaliseScene(scene) {
    return {
      ...scene,
      start: tsToSeconds(scene.start),
      end:   tsToSeconds(scene.end)
    };
  }

  function tsToSeconds(ts) {
    if (!ts) return 0;
    const parts = String(ts).split(':').map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return Number(ts) || 0;
  }

  // ── Styles ─────────────────────────────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById('ss-styles')) return;
    const style = document.createElement('style');
    style.id = 'ss-styles';
    style.textContent = `
      .ss-banner {
        position: fixed;
        bottom: 80px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 2147483647;
        background: rgba(10,10,10,0.92);
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 12px;
        padding: 14px 18px;
        max-width: 520px;
        width: calc(100% - 40px);
        box-shadow: 0 8px 32px rgba(0,0,0,0.6);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        color: #fff;
        backdrop-filter: blur(8px);
        animation: ss-slide-up 0.2s ease;
      }
      @keyframes ss-slide-up {
        from { opacity:0; transform:translateX(-50%) translateY(12px); }
        to   { opacity:1; transform:translateX(-50%) translateY(0); }
      }
      .ss-banner-inner {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .ss-banner-icon {
        font-size: 22px;
        flex-shrink: 0;
        color: #f59e0b;
      }
      .ss-banner-text {
        flex: 1;
        min-width: 0;
      }
      .ss-banner-text strong {
        display: block;
        font-size: 14px;
        font-weight: 600;
        margin-bottom: 2px;
      }
      .ss-banner-text span {
        font-size: 12px;
        color: rgba(255,255,255,0.6);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        display: block;
      }
      .ss-banner-actions {
        display: flex;
        gap: 8px;
        flex-shrink: 0;
      }
      .ss-btn {
        padding: 7px 14px;
        border-radius: 6px;
        border: none;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        transition: opacity 0.15s;
      }
      .ss-btn:hover { opacity: 0.85; }
      .ss-btn-skip {
        background: #ef4444;
        color: #fff;
      }
      .ss-btn-dismiss {
        background: rgba(255,255,255,0.12);
        color: #fff;
      }
      .ss-status {
        position: fixed;
        top: 12px;
        right: 12px;
        z-index: 2147483646;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 11px;
        padding: 5px 10px;
        border-radius: 20px;
        color: #fff;
        pointer-events: none;
        display: none;
        max-width: 280px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .ss-status-processing { background: rgba(30,100,200,0.85); }
      .ss-status-ready      { background: rgba(22,163,74,0.85); }
      .ss-status-error      { background: rgba(220,38,38,0.85); pointer-events: auto; }
      .ss-status-no_api_key { background: rgba(100,60,0,0.9); pointer-events: auto; }
      .ss-status-no_subtitle{ background: rgba(60,60,60,0.85); }
    `;
    document.head.appendChild(style);
  }

})();
