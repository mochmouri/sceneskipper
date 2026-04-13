// popup.js

(function () {
  'use strict';

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
    });
  });

  // ── Settings tab ──────────────────────────────────────────────────────────

  const apiKeyInput    = document.getElementById('api-key-input');
  const btnToggleKey   = document.getElementById('btn-toggle-key');
  const chkHigh        = document.getElementById('chk-high');
  const chkMedium      = document.getElementById('chk-medium');
  const chkLow         = document.getElementById('chk-low');
  const btnSave        = document.getElementById('btn-save');
  const saveFeedback   = document.getElementById('save-feedback');

  // Show/hide API key
  btnToggleKey.addEventListener('click', () => {
    const show = apiKeyInput.type === 'password';
    apiKeyInput.type = show ? 'text' : 'password';
  });

  // Load saved settings
  browser.runtime.sendMessage({ type: 'GET_SETTINGS' }).then(s => {
    if (!s) return;
    apiKeyInput.value    = s.apiKey        || '';
    chkHigh.checked      = s.autoSkipHigh  !== false;
    chkMedium.checked    = s.autoSkipMedium!== false;
    chkLow.checked       = s.autoSkipLow   === true;
  }).catch(console.error);

  // Save settings
  btnSave.addEventListener('click', async () => {
    const settings = {
      type:           'SAVE_SETTINGS',
      apiKey:         apiKeyInput.value.trim(),
      autoSkipHigh:   chkHigh.checked,
      autoSkipMedium: chkMedium.checked,
      autoSkipLow:    chkLow.checked
    };

    try {
      await browser.runtime.sendMessage(settings);
      saveFeedback.hidden = false;
      setTimeout(() => { saveFeedback.hidden = true; }, 2000);
    } catch (err) {
      console.error('Failed to save settings:', err);
    }
  });

  // ── History tab ───────────────────────────────────────────────────────────

  const historyList   = document.getElementById('history-list');
  const historyEmpty  = document.getElementById('history-empty');
  const historyFooter = document.getElementById('history-footer');
  const btnClearAll   = document.getElementById('btn-clear-all');

  loadHistory();

  async function loadHistory() {
    let history = {};
    try {
      history = await browser.runtime.sendMessage({ type: 'GET_HISTORY' }) || {};
    } catch (err) {
      console.error('Failed to load history:', err);
    }

    historyList.innerHTML = '';
    const entries = Object.values(history).sort((a, b) => b.processedAt - a.processedAt);

    if (entries.length === 0) {
      historyEmpty.hidden  = false;
      historyFooter.hidden = true;
      return;
    }

    historyEmpty.hidden  = true;
    historyFooter.hidden = false;

    entries.forEach(entry => {
      historyList.appendChild(buildMovieCard(entry));
    });
  }

  function buildMovieCard(entry) {
    const card = document.createElement('div');
    card.className = 'movie-card';

    const sceneCount   = entry.scenes?.length || 0;
    const skippedCount = entry.scenesSkipped  || 0;
    const date         = entry.processedAt
      ? new Date(entry.processedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      : '';

    card.innerHTML = `
      <div class="movie-header">
        <div class="movie-title-row">
          <div class="movie-title" title="${escHtml(entry.movieTitle)}">${escHtml(entry.movieTitle)}</div>
          <div class="movie-meta">
            ${sceneCount} scene${sceneCount !== 1 ? 's' : ''} flagged
            · ${skippedCount} skipped
            ${date ? '· ' + date : ''}
          </div>
        </div>
        <div class="movie-actions">
          <button class="btn btn-ghost btn-sm btn-danger btn-delete" data-title="${escAttr(entry.movieTitle)}" title="Remove from history">✕</button>
          <span class="chevron">▼</span>
        </div>
      </div>
      <div class="movie-scenes"></div>
    `;

    const header    = card.querySelector('.movie-header');
    const scenesEl  = card.querySelector('.movie-scenes');
    const btnDelete = card.querySelector('.btn-delete');

    // Build scene list
    if (entry.scenes && entry.scenes.length > 0) {
      entry.scenes.forEach(scene => {
        const row = document.createElement('div');
        row.className = 'scene-row';
        const startFmt = formatTs(scene.start);
        const endFmt   = formatTs(scene.end);
        row.innerHTML = `
          <span class="scene-conf ${escHtml(scene.confidence)}">${escHtml(scene.confidence)}</span>
          <div class="scene-info">
            <div class="scene-time">${startFmt} – ${endFmt}</div>
            <div class="scene-reason">${escHtml(scene.reason || '')}</div>
          </div>
        `;
        scenesEl.appendChild(row);
      });
    } else {
      scenesEl.innerHTML = '<p style="color:var(--text-muted);font-size:11px;padding:4px 0">No scenes flagged</p>';
    }

    // Toggle expand
    header.addEventListener('click', (e) => {
      if (e.target.closest('.btn-delete')) return;
      card.classList.toggle('expanded');
    });

    // Delete
    btnDelete.addEventListener('click', async (e) => {
      e.stopPropagation();
      const title = btnDelete.dataset.title;
      try {
        await browser.runtime.sendMessage({ type: 'CLEAR_HISTORY_ITEM', movieTitle: title });
        card.remove();
        // Hide footer if list is now empty
        if (historyList.children.length === 0) {
          historyEmpty.hidden  = false;
          historyFooter.hidden = true;
        }
      } catch (err) {
        console.error('Failed to delete history item:', err);
      }
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
    } catch (err) {
      console.error('Failed to clear history:', err);
    }
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  function formatTs(ts) {
    // ts is either "HH:MM:SS[.mmm]" string or seconds number
    let secs;
    if (typeof ts === 'string' && ts.includes(':')) {
      const parts = ts.split(':').map(parseFloat);
      if (parts.length === 3) secs = parts[0]*3600 + parts[1]*60 + parts[2];
      else if (parts.length === 2) secs = parts[0]*60 + parts[1];
      else secs = parseFloat(ts);
    } else {
      secs = parseFloat(ts) || 0;
    }

    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);

    if (h > 0) {
      return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    }
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }

  function escHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escAttr(str) {
    return escHtml(str);
  }

})();
