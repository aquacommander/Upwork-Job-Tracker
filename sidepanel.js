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

function renderLastViewedBlock(job) {
  if (job.pendingRefresh) {
    return `
      <div class="last-viewed-block">
        <div class="last-viewed-label">Last viewed by client</div>
        <div class="last-viewed-value refreshing">Updating from page…</div>
      </div>`;
  }

  if (job.awaitingFirstView || !job.lastViewed) {
    return `
      <div class="last-viewed-block">
        <div class="last-viewed-label">Last viewed by client</div>
        <div class="last-viewed-value muted">Not viewed yet</div>
        <div class="last-viewed-meta">You will be alerted the moment Upwork shows a time.</div>
      </div>`;
  }

  const secs = getJobLastViewedSeconds(job);
  const meta = secs != null ? `≈ ${secs.toLocaleString()} seconds ago (internal compare)` : '';

  return `
    <div class="last-viewed-block">
      <div class="last-viewed-label">Last viewed by client</div>
      <div class="last-viewed-value">${escapeHtml(job.lastViewed)}</div>
      ${meta ? `<div class="last-viewed-meta">${escapeHtml(meta)}</div>` : ''}
    </div>`;
  }

function renderChangeAndCheck(job) {
  let html = '';

  const change = job.lastMeaningfulChange;
  if (change?.from && change?.to) {
    const flag = change.notified
      ? '<span class="change-notified">Alert sent</span>'
      : '';
    html += `
      <div class="change-row">
        <div class="label">Last client view change</div>
        <span class="change-from">${escapeHtml(change.from)}</span>
        <span class="change-arrow">→</span>
        <span class="change-to">${escapeHtml(change.to)}</span>
        ${flag}
        <div class="last-viewed-meta">${escapeHtml(formatChangeTime(change.at))}</div>
      </div>`;
  }

  if (job.lastComparison && !job.lastComparison.error) {
    const c = job.lastComparison;
    let checkText = `Last sync: ${escapeHtml(c.current)}`;
    if (c.reason === 'synced') checkText += ' (page time advanced)';
    if (c.notified) checkText += ' · alert sent';
    html += `<div class="check-row">${checkText}<br><small>${escapeHtml(formatChangeTime(c.at))}</small></div>`;
  }

  return html;
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
        <span class="stat-chip">Proposals <b>${escapeHtml(job.proposals) || '?'}</b></span>
        <span class="stat-chip">Interviewing <b>${escapeHtml(job.interviewing) || '0'}</b></span>
        <span class="stat-chip">Invites <b>${escapeHtml(job.invitesSent) || '0'}</b></span>
      </div>
      ${renderLastViewedBlock(job)}
      ${renderChangeAndCheck(job)}
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

renderJobs();
