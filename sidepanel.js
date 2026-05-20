// sidepanel.js — relies on extractor-shared.js loaded first in sidepanel.html

const jobListEl = document.getElementById('job-list');
const addBtn = document.getElementById('add-btn');
const statusEl = document.getElementById('status');
const debugSection = document.getElementById('debug-section');
const debugToggle = document.getElementById('debug-toggle');

debugToggle.addEventListener('click', () => {
  debugSection.classList.toggle('show');
  debugToggle.textContent = debugSection.classList.contains('show') ? 'Hide debug log' : 'Show debug log';
});

function logDebug(msg) {
  debugSection.innerHTML += `<div>${new Date().toLocaleTimeString()}: ${escapeHtml(msg)}</div>`;
  debugSection.scrollTop = debugSection.scrollHeight;
}

async function getActiveUpworkTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

function scoreExtraction(data) {
  if (!data?.lastViewed || !isValidLastViewedDisplay(data.lastViewed)) return -1;
  let s = lastViewedSpecificityScore(data.lastViewed);
  if (data.lastViewedSource?.startsWith('activity')) s += 50;
  return s;
}

async function extractDataFromTab(tabId) {
  let bestData = null;
  let bestScore = -1;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000));
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractionScript
    });
    const data = result?.result || null;
    if (!data) continue;
    if (data.captchaDetected) return data;
    if (data.lastViewedAbsent) return data;
    const score = scoreExtraction(data);
    if (score > bestScore) {
      bestScore = score;
      bestData = data;
    }
    if (score >= 150) return data;
  }
  return bestData;
}

function formatChangeTime(timestamp) {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleString();
}

function getStatusPill(job) {
  if (job.pendingRefresh) return { class: 'refresh', text: 'Refreshing' };
  if (job.needsVerification) return { class: 'error', text: 'Verify' };
  if (job.awaitingFirstView) return { class: 'wait', text: 'Awaiting view' };
  if (job.lastExtractionError) return { class: 'error', text: 'Issue' };
  return { class: 'live', text: 'Tracking' };
}

function renderLastViewedRow(job) {
  if (job.pendingRefresh) {
    return `<div class="last-viewed-row">
      <span class="last-viewed-label">Last viewed</span>
      <span class="last-viewed-value refreshing">Reloading…</span>
    </div>`;
  }

  if (job.awaitingFirstView || !job.lastViewed) {
    return `<div class="last-viewed-row">
      <span class="last-viewed-label">Last viewed</span>
      <span class="last-viewed-value muted">Not yet</span>
    </div>`;
  }

  return `<div class="last-viewed-row">
    <span class="last-viewed-label">Last viewed</span>
    <span class="last-viewed-value">${escapeHtml(job.lastViewed)}</span>
  </div>`;
}

function renderMetaLines(job) {
  const parts = [];

  const change = job.lastMeaningfulChange;
  if (change?.from && change?.to) {
    const flag = change.notified ? ' · <span class="change-notified">alert</span>' : '';
    parts.push(
      `Change: <span class="change-from">${escapeHtml(change.from)}</span><span class="change-arrow">→</span><span class="change-to">${escapeHtml(change.to)}</span>${flag}`
    );
  }

  if (job.lastComparison && !job.lastComparison.error) {
    const c = job.lastComparison;
    const sync = formatChangeTime(c.at);
    if (sync) parts.push(`Synced ${escapeHtml(sync)}`);
  }

  if (!parts.length) return '';
  return `<div class="meta-line">${parts.join('<span class="stats-dot">·</span>')}</div>`;
}

async function renderJobs() {
  const { jobs } = await chrome.storage.local.get('jobs');
  jobListEl.innerHTML = '';

  if (!jobs?.length) {
    jobListEl.innerHTML = `
      <div class="empty-state">
        <div class="icon">📋</div>
        <p>No jobs tracked yet.<br>Open an Upwork job tab and click <b>Track Current Job Tab</b>.</p>
      </div>`;
    return;
  }

  jobs.forEach((job) => {
    const pill = getStatusPill(job);
    let cardClass = 'job-card';
    if (job.pendingRefresh) cardClass += ' refreshing';
    else if (job.awaitingFirstView) cardClass += ' awaiting-view';
    else if (job.needsVerification) cardClass += ' needs-verification';
    else cardClass += ' alert-ready';

    let bannerHtml = '';
    if (job.needsVerification) {
      bannerHtml =
        '<div class="banner warn">Complete CAPTCHA in the job tab, then remove and re-add this job.</div>';
    } else if (job.lastExtractionError) {
      bannerHtml = `<div class="banner warn">${escapeHtml(job.lastExtractionError)}</div>`;
    }

    const div = document.createElement('div');
    div.className = cardClass;
    div.innerHTML = `
      <div class="job-card-header">
        <div class="job-title">${escapeHtml(job.title) || '(no title)'}</div>
        <span class="status-pill ${pill.class}">${pill.text}</span>
      </div>
      ${bannerHtml}
      <div class="stats-row">
        <b>${escapeHtml(job.proposals) || '?'}</b> proposals
        <span class="stats-dot">·</span>
        <b>${escapeHtml(job.interviewing) || '0'}</b> interviewing
        <span class="stats-dot">·</span>
        <b>${escapeHtml(job.invitesSent) || '0'}</b> invites
      </div>
      ${renderLastViewedRow(job)}
      ${renderMetaLines(job)}
      <div class="card-footer">
        <label for="interval-${job.id}">Check every</label>
        <input type="number" id="interval-${job.id}" class="interval-input" value="${job.checkInterval}" min="1" data-id="${job.id}">
        <label>min</label>
        <button type="button" class="btn-remove" data-id="${job.id}">Remove</button>
      </div>
    `;
    jobListEl.appendChild(div);
  });

  document.querySelectorAll('.interval-input').forEach((input) => {
    input.addEventListener('change', async (e) => {
      const id = e.target.dataset.id;
      const newInterval = parseInt(e.target.value, 10);
      if (newInterval > 0) {
        const response = await chrome.runtime.sendMessage({
          action: 'updateInterval',
          id,
          checkInterval: newInterval
        });
        if (!response?.success) {
          setStatus('Failed to update interval', 'error');
        }
        await renderJobs();
      }
    });
  });

  document.querySelectorAll('.btn-remove').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const id = e.target.dataset.id;
      await chrome.runtime.sendMessage({ action: 'removeJob', id });
      await renderJobs();
    });
  });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.jobs) {
    renderJobs();
  }
});

function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return String(text ?? '').replace(/[&<>"']/g, (m) => map[m]);
}

function setStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = 'visible status-' + type;
}

addBtn.addEventListener('click', async () => {
  setStatus('Reading job page…', 'info');
  debugSection.innerHTML = '';
  logDebug('Add job started');

  try {
    const tab = await getActiveUpworkTab();
    if (!tab?.id) {
      throw new Error('No active tab. Open an Upwork job page first.');
    }
    if (!isUpworkJobUrl(tab.url)) {
      throw new Error('Not an Upwork job URL (/jobs/ or /freelance-jobs/).');
    }

    const data = await extractDataFromTab(tab.id);
    if (!data) {
      throw new Error('Could not read the page. Wait for it to load and try again.');
    }
    if (data.captchaDetected) {
      throw new Error('Complete CAPTCHA in the tab, then try again.');
    }

    const hasTime = data.lastViewed && isValidLastViewedDisplay(data.lastViewed);
    const absent = data.lastViewedAbsent && !hasTime;

    logDebug(`Last viewed: "${data.lastViewed || '(none)'}" absent=${!!absent}`);
    if (hasTime) {
      logDebug(`Seconds: ${parseRelativeSeconds(data.lastViewed)} · ${JSON.stringify(classifyLastViewedUnit(data.lastViewed))}`);
    }

    if (!hasTime && !absent) {
      throw new Error(
        'Could not find Activity / Last viewed on this page. Scroll to the Activity section.'
      );
    }

    const response = await chrome.runtime.sendMessage({
      action: 'addJob',
      data: {
        url: tab.url,
        tabId: tab.id,
        title: data.title,
        proposals: data.proposals,
        lastViewed: data.lastViewed || '',
        lastViewedAbsent: absent,
        lastViewedSource: data.lastViewedSource,
        interviewing: data.interviewing,
        invitesSent: data.invitesSent,
        unansweredInvites: data.unansweredInvites,
        checkInterval: 5
      }
    });

    if (!response?.success) {
      throw new Error(response?.error || 'Failed to add job');
    }

    if (response.awaitingFirstView) {
      setStatus('Job tracked. Waiting for client’s first view — you’ll be alerted immediately.', 'success');
    } else {
      setStatus(`Tracking started. Last viewed: ${data.lastViewed}`, 'success');
    }
    await renderJobs();
  } catch (err) {
    logDebug(`ERROR: ${err.message}`);
    setStatus(err.message, 'error');
  }
});

// ---------- Appearance / themes ----------
const bgLayer = document.getElementById('bg-layer');
const themeGrid = document.getElementById('theme-grid');
const settingsToggle = document.getElementById('settings-toggle');
const settingsBody = document.getElementById('settings-body');
const settingsSummary = document.getElementById('settings-summary');
const bgPickBtn = document.getElementById('bg-pick-btn');
const bgClearBtn = document.getElementById('bg-clear-btn');
const bgFileInput = document.getElementById('bg-file-input');
const bgPreview = document.getElementById('bg-preview');
const bgOpacity = document.getElementById('bg-opacity');
const bgOpacityVal = document.getElementById('bg-opacity-val');

const MAX_BG_BYTES = 3 * 1024 * 1024;

function applyTheme(themeId) {
  const theme = THEME_PRESETS[themeId] || THEME_PRESETS.upwork;
  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme.vars)) {
    root.style.setProperty(key, value);
  }
  document.querySelectorAll('.theme-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.themeId === theme.id);
  });
  if (settingsSummary) {
    settingsSummary.textContent = `${theme.emoji} ${theme.name}`;
  }
}

function applyBackground(appearance) {
  const opacity = (appearance.backgroundOpacity ?? 25) / 100;
  document.documentElement.style.setProperty('--bg-image-opacity', String(opacity));

  if (appearance.backgroundImage) {
    const url = `url(${JSON.stringify(appearance.backgroundImage)})`;
    bgLayer.style.backgroundImage = url;
    bgLayer.classList.add('has-image');
    bgPreview.style.backgroundImage = url;
    bgPreview.classList.add('visible');
  } else {
    bgLayer.style.backgroundImage = '';
    bgLayer.classList.remove('has-image');
    bgPreview.style.backgroundImage = '';
    bgPreview.classList.remove('visible');
  }

  if (bgOpacity) bgOpacity.value = Math.round(appearance.backgroundOpacity ?? 25);
  if (bgOpacityVal) bgOpacityVal.textContent = `${Math.round(appearance.backgroundOpacity ?? 25)}%`;
}

async function loadAppearance() {
  const { appearance } = await chrome.storage.local.get('appearance');
  return { ...DEFAULT_APPEARANCE, ...appearance };
}

async function saveAppearance(appearance) {
  await chrome.storage.local.set({ appearance });
}

function buildThemeGrid() {
  themeGrid.innerHTML = '';
  for (const theme of Object.values(THEME_PRESETS)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-btn';
    btn.dataset.themeId = theme.id;
    btn.title = theme.name;
    btn.innerHTML = `<span class="emoji">${theme.emoji}</span><span>${theme.name}</span>`;
    btn.addEventListener('click', async () => {
      const appearance = await loadAppearance();
      appearance.themeId = theme.id;
      applyTheme(theme.id);
      await saveAppearance(appearance);
    });
    themeGrid.appendChild(btn);
  }
}

settingsToggle.addEventListener('click', () => {
  const open = settingsBody.classList.toggle('open');
  settingsToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
});

bgPickBtn.addEventListener('click', () => bgFileInput.click());

bgFileInput.addEventListener('change', async () => {
  const file = bgFileInput.files?.[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    setStatus('Please choose an image file (PNG, JPG, WebP, GIF).', 'error');
    return;
  }
  if (file.size > MAX_BG_BYTES) {
    setStatus('Image too large. Use a file under 3 MB.', 'error');
    bgFileInput.value = '';
    return;
  }

  const reader = new FileReader();
  reader.onload = async () => {
    const appearance = await loadAppearance();
    appearance.backgroundImage = reader.result;
    applyBackground(appearance);
    await saveAppearance(appearance);
    setStatus('Background image applied.', 'success');
  };
  reader.onerror = () => setStatus('Could not read that image.', 'error');
  reader.readAsDataURL(file);
  bgFileInput.value = '';
});

bgClearBtn.addEventListener('click', async () => {
  const appearance = await loadAppearance();
  appearance.backgroundImage = null;
  applyBackground(appearance);
  await saveAppearance(appearance);
  setStatus('Background removed.', 'info');
});

bgOpacity.addEventListener('input', async () => {
  const val = parseInt(bgOpacity.value, 10);
  bgOpacityVal.textContent = `${val}%`;
  const appearance = await loadAppearance();
  appearance.backgroundOpacity = val;
  applyBackground(appearance);
  await saveAppearance(appearance);
});

async function initAppearance() {
  buildThemeGrid();
  const appearance = await loadAppearance();
  applyTheme(appearance.themeId || 'upwork');
  applyBackground(appearance);
}

initAppearance();
renderJobs();
