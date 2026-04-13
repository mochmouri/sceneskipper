// popup.js

(function () {
  'use strict';

  let activeTabId = null;

  // ── Tab switching ──────────────────────────────────────────────────────────

  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      document.querySelectorAll('.tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === target);
        t.setAttribute('aria-selected', String(t.dataset.tab === target));
      });
      document.querySelectorAll('.tab-panel').forEach(panel => {
        const show = panel.id === `tab-${target}`;
        panel.classList.toggle('active', show);
        panel.hidden = !show;
      });
      if (target === 'history') loadHistory();
    });
  });

  // ── Init ───────────────────────────────────────────────────────────────────

  async function init() {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    activeTabId = tab.id;

    if (tab.title) {
      document.getElementById('search-input').value = cleanTitle(tab.title);
    }
  }

  init().catch(console.error);

  // ── Analyse tab ────────────────────────────────────────────────────────────

  const searchInput  = document.getElementById('search-input');
  const btnSearch    = document.getElementById('btn-search');
  const searchStatus = document.getElementById('search-status');
  const resultsList  = document.getElementById('results-list');
  const analyseDone  = document.getElementById('analyse-done');
  const analyseDoneText = document.getElementById('analyse-done-text');
  const analyseDoneIcon = document.getElementById('analyse-done-icon');

  btnSearch.addEventListener('click', doSearch);
  searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

  async function doSearch() {
    const query = searchInput.value.trim();
    if (!query) return;

    setStatus('Searching…');
    btnSearch.disabled  = true;
    resultsList.hidden  = true;
    resultsList.innerHTML = '';
    analyseDone.hidden  = true;

    try {
      const results = await browser.runtime.sendMessage({
        type: 'SEARCH_SUBTITLES', query
      });

      if (!results.length) {
        setStatus('No English subtitles found for that title.');
        return;
      }

      setStatus(`${results.length} result${results.length !== 1 ? 's' : ''} — click one to analyse.`);
      renderResults(results);

    } catch (err) {
      setStatus(`Error: ${err.message}`, true);
    } finally {
      btnSearch.disabled = false;
    }
  }

  function renderResults(results) {
    resultsList.innerHTML = '';

    for (const item of results) {
      const attrs   = item.attributes || {};
      const details = attrs.feature_details || {};
      const title   = details.title || attrs.movie_name || 'Unknown title';
      const year    = details.year  || '';
      const release = (attrs.release || '').slice(0, 60);
      const downloads = (attrs.download_count ?? 0).toLocaleString();
      const fileId  = attrs.files?.[0]?.file_id;

      if (!fileId) continue;

      const li = document.createElement('li');
      li.className = 'result-item';
      li.innerHTML = `
        <div class="result-title">${escHtml(title)}${year ? ` <span class="result-year">(${year})</span>` : ''}</div>
        <div class="result-meta">${escHtml(release) || '—'} · ${downloads} downloads</div>
      `;
      li.addEventListener('click', () => runAnalysis(fileId, title));
      resultsList.appendChild(li);
    }

    resultsList.hidden = false;
  }

  async function runAnalysis(fileId, movieTitle) {
    resultsList.hidden = true;
    analyseDone.hidden = true;
    btnSearch.disabled = true;

    setStatus('Downloading subtitle…');

    // Give the UI a tick to render the status before the network call blocks
    await new Promise(r => setTimeout(r, 30));
    setStatus('Analysing with Gemini…');

    try {
      const result = await browser.runtime.sendMessage({
        type:       'ANALYSE_SUBTITLE',
        fileId,
        movieTitle,
        tabId:      activeTabId,
      });

      const count = result.skipList?.length || 0;
      const note  = result.fromCache ? ' (from cache)' : '';
      const rem   = result.remaining != null
        ? ` · ${result.remaining} OS downloads left today`
        : '';

      showDone(
        `${count} scene${count !== 1 ? 's' : ''} flagged${note}${rem}`,
        count > 0
      );
      setStatus('');

    } catch (err) {
      setStatus(`Error: ${err.message}`, true);
      resultsList.hidden = false;
    } finally {
      btnSearch.disabled = false;
    }
  }

  function setStatus(msg, isError = false) {
    searchStatus.textContent = msg;
    searchStatus.className   = `status-msg${isError ? ' status-error' : ''}`;
    searchStatus.hidden      = !msg;
  }

  function showDone(text, hasScenes) {
    analyseDoneIcon.textContent = hasScenes ? '✓' : 'ℹ';
    analyseDoneIcon.className   = `done-icon ${hasScenes ? 'done-ok' : 'done-info'}`;
    analyseDoneText.textContent = text;
    analyseDone.hidden = false;
  }

  // ── History tab ───────────────────────────────────────────────────────────

  const historyList   = document.getElementById('history-list');
  const historyEmpty  = document.getElementById('history-empty');
  const historyFooter = document.getElementById('history-footer');
  const btnClearAll   = document.getElementById('btn-clear-all');

  async function loadHistory() {
    let history = {};
    try {
      history = await browser.runtime.sendMessage({ type: 'GET_HISTORY' }) || {};
    } catch (err) { console.error(err); }

    historyList.innerHTML = '';
    const entries = Object.values(history).sort((a, b) => b.processedAt - a.processedAt);

    if (entries.length === 0) {
      historyEmpty.hidden  = false;
      historyFooter.hidden = true;
      return;
    }

    historyEmpty.hidden  = true;
    historyFooter.hidden = false;
    entries.forEach(e => historyList.appendChild(buildMovieCard(e)));
  }

  function buildMovieCard(entry) {
    const card         = document.createElement('div');
    card.className     = 'movie-card';
    const sceneCount   = entry.scenes?.length || 0;
    const skippedCount = entry.scenesSkipped  || 0;
    const date         = entry.processedAt
      ? new Date(entry.processedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      : '';

    card.innerHTML = `
      <div class="movie-header">
        <div class="movie-title-row">
          <div class="movie-title" title="${escHtml(entry.movieTitle)}">${escHtml(entry.movieTitle)}</div>
          <div class="movie-meta">${sceneCount} flagged · ${skippedCount} skipped${date ? ' · ' + date : ''}</div>
        </div>
        <div class="movie-actions">
          <button class="btn btn-ghost btn-sm btn-danger btn-delete" data-title="${escHtml(entry.movieTitle)}" title="Remove">✕</button>
          <span class="chevron">▼</span>
        </div>
      </div>
      <div class="movie-scenes"></div>
    `;

    const scenesEl  = card.querySelector('.movie-scenes');
    const btnDelete = card.querySelector('.btn-delete');

    if (entry.scenes?.length) {
      entry.scenes.forEach(scene => {
        const row = document.createElement('div');
        row.className = 'scene-row';
        row.innerHTML = `
          <span class="scene-conf ${escHtml(scene.confidence)}">${escHtml(scene.confidence)}</span>
          <div class="scene-info">
            <div class="scene-time">${formatTs(scene.start)} – ${formatTs(scene.end)}</div>
            <div class="scene-reason">${escHtml(scene.reason || '')}</div>
          </div>
        `;
        scenesEl.appendChild(row);
      });
    } else {
      scenesEl.innerHTML = '<p style="color:var(--text-muted);font-size:11px;padding:4px 0">No scenes flagged</p>';
    }

    card.querySelector('.movie-header').addEventListener('click', e => {
      if (e.target.closest('.btn-delete')) return;
      card.classList.toggle('expanded');
    });

    btnDelete.addEventListener('click', async e => {
      e.stopPropagation();
      try {
        await browser.runtime.sendMessage({ type: 'CLEAR_HISTORY_ITEM', movieTitle: entry.movieTitle });
        card.remove();
        if (!historyList.children.length) {
          historyEmpty.hidden  = false;
          historyFooter.hidden = true;
        }
      } catch (err) { console.error(err); }
    });

    return card;
  }

  btnClearAll.addEventListener('click', async () => {
    if (!confirm('Clear all SceneSkipper history? This cannot be undone.')) return;
    try {
      await browser.runtime.sendMessage({ type: 'CLEAR_ALL_HISTORY' });
      historyList.innerHTML = '';
      historyEmpty.hidden  = false;
      historyFooter.hidden = true;
    } catch (err) { console.error(err); }
  });

  // ── Settings tab ──────────────────────────────────────────────────────────

  const geminiKeyInput = document.getElementById('gemini-key-input');
  const osKeyInput     = document.getElementById('os-key-input');
  const chkHigh        = document.getElementById('chk-high');
  const chkMedium      = document.getElementById('chk-medium');
  const chkLow         = document.getElementById('chk-low');
  const btnSave        = document.getElementById('btn-save');
  const saveFeedback   = document.getElementById('save-feedback');

  // Show/hide toggles for password fields
  document.querySelectorAll('[data-toggle-target]').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.toggleTarget);
      if (input) input.type = input.type === 'password' ? 'text' : 'password';
    });
  });

  browser.runtime.sendMessage({ type: 'GET_SETTINGS' }).then(s => {
    if (!s) return;
    geminiKeyInput.value    = s.geminiApiKey   || '';
    osKeyInput.value        = s.osApiKey       || '';
    chkHigh.checked         = s.autoSkipHigh   !== false;
    chkMedium.checked       = s.autoSkipMedium !== false;
    chkLow.checked          = s.autoSkipLow    === true;
  }).catch(console.error);

  btnSave.addEventListener('click', async () => {
    try {
      await browser.runtime.sendMessage({
        type:           'SAVE_SETTINGS',
        geminiApiKey:   geminiKeyInput.value.trim(),
        osApiKey:       osKeyInput.value.trim(),
        autoSkipHigh:   chkHigh.checked,
        autoSkipMedium: chkMedium.checked,
        autoSkipLow:    chkLow.checked,
      });
      saveFeedback.hidden = false;
      setTimeout(() => { saveFeedback.hidden = true; }, 2000);
    } catch (err) { console.error(err); }
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  function cleanTitle(raw) {
    return (raw || '')
      .replace(/\s*[|\-–—]\s*(Netflix|Prime Video|Disney\+|Max|Hulu|Peacock|HBO).*$/i, '')
      .replace(/\s*[|\-–—]\s*Watch.*$/i, '')
      .replace(/\s*\(?\d{4}\)?$/, '')
      .trim();
  }

  function formatTs(ts) {
    let secs;
    if (typeof ts === 'string' && ts.includes(':')) {
      const p = ts.split(':').map(parseFloat);
      secs = p.length === 3 ? p[0]*3600 + p[1]*60 + p[2] : p[0]*60 + p[1];
    } else {
      secs = parseFloat(ts) || 0;
    }
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    return h > 0
      ? `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
      : `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }

  function escHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

})();
