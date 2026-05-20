// sidepanel.js — relies on extractor-shared.js loaded first in sidepanel.html

const jobListEl = document.getElementById('job-list');
const addBtn = document.getElementById('add-btn');
const statusEl = document.getElementById('status');
const debugSection = document.getElementById('debug-section');
const debugToggle = document.getElementById('debug-toggle');

debugToggle.addEventListener('click', () => {
  debugSection.classList.toggle('show');
  debugToggle.textContent = debugSection.classList.contains('show') ? 'Hide Debug Info' : 'Show Debug Info';
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
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000));
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractionScript
    });
    const data = result?.result || null;
    if (!data) continue;
    if (data.captchaDetected) return data;
    const score = scoreExtraction(data);
    if (score > bestScore) {
      bestScore = score;
      bestData = data;
    }
    if (score >= 150) return data;
  }
  return bestData;
}

function formatTime(minutes) {
  if (minutes == null) return '(unknown)';
  if (minutes === 0) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
  if (minutes < 1440) {
    const h = Math.floor(minutes / 60);
    return `${h} hour${h !== 1 ? 's' : ''} ago`;
  }
  const d = Math.floor(minutes / 1440);
  return `${d} day${d !== 1 ? 's' : ''} ago`;
}

function formatChangeTime(timestamp) {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleString();
}

function renderComparisonLogs(job) {
  let html = '';

  if (job.lastComparison) {
    const c = job.lastComparison;
    const time = formatChangeTime(c.at);
    let line = '';
    let cssClass = 'compare-log';

    if (c.error) {
      line = `<b>Last check:</b> could not read page (kept "${escapeHtml(c.previous)}")`;
      cssClass += ' compare-error';
    } else if (c.skipped) {
      line = `<b>Last check:</b> ${escapeHtml(c.previous)} <span class="compare-arrow">→</span> <span class="compare-skipped">${escapeHtml(c.current)}</span> <span class="compare-note">(ignored bad read)</span>`;
    } else if (c.changed) {
      line = `<b>Last check:</b> ${escapeHtml(c.previous)} <span class="compare-arrow">→</span> <span class="compare-new">${escapeHtml(c.current)}</span>`;
      if (c.notified) line += ' <span class="compare-notify">· notified</span>';
    } else {
      line = `<b>Last check:</b> ${escapeHtml(c.previous)} <span class="compare-arrow">→</span> ${escapeHtml(c.current)} <span class="compare-note">(no change)</span>`;
    }

    html += `<div class="${cssClass}">${line}<br><small>${escapeHtml(time)}${c.source ? ' · ' + escapeHtml(c.source) : ''}</small></div>`;
  } else if (job.previousLastViewed != null && job.previousLastViewed !== job.lastViewed) {
    html += `
      <div class="compare-log">
        <b>Last change:</b> ${escapeHtml(job.previousLastViewed)} <span class="compare-arrow">→</span> ${escapeHtml(job.lastViewed)}<br>
        <small>${formatChangeTime(job.lastChangeTime)}</small>
      </div>
    `;
  }

  if (job.changeHistory?.length) {
    html += '<div class="compare-history"><b>Change history:</b>';
    job.changeHistory.slice(0, 8).forEach((entry) => {
      const flag = entry.notified ? ' · notified' : '';
      html += `<div class="history-row">${escapeHtml(entry.from)} <span class="compare-arrow">→</span> ${escapeHtml(entry.to)}<br><small>${formatChangeTime(entry.at)}${flag}</small></div>`;
    });
    html += '</div>';
  }

  return html;
}

async function renderJobs() {
  const { jobs } = await chrome.storage.local.get('jobs');
  jobListEl.innerHTML = '';
  if (!jobs?.length) {
    jobListEl.innerHTML = '<p style="color:#888; text-align:center;">No job postings added yet.</p>';
    return;
  }

  jobs.forEach((job) => {
    let lastViewedContent;
    if (job.pendingRefresh) {
      lastViewedContent = '<span style="color: #e67e22; font-weight: bold;">REFRESHING...</span>';
    } else {
      lastViewedContent = `<span style="color: red; font-weight: bold;">${escapeHtml(job.lastViewed) || 'unknown'}</span>`;
    }

    let warningHtml = '';
    if (job.needsVerification) {
      warningHtml =
        '<div class="warning-banner">⚠ CAPTCHA / verification detected. Open the tab, complete it, then remove and re-add this job.</div>';
    } else if (job.lastExtractionError) {
      warningHtml = `<div class="warning-banner">⚠ ${escapeHtml(job.lastExtractionError)}</div>`;
    }

    const comparisonLogHtml = renderComparisonLogs(job);

    const div = document.createElement('div');
    div.className = 'job-item' + (job.needsVerification ? ' needs-verification' : '');
    div.innerHTML = `
      <div class="job-title">${escapeHtml(job.title) || '(no title)'}</div>
      ${warningHtml}
      <div class="details">
        <b>Proposals:</b> ${escapeHtml(job.proposals) || '?'}<br>
        <b>Interviewing:</b> ${escapeHtml(job.interviewing) || '0'} |
        <b>Invites:</b> ${escapeHtml(job.invitesSent) || '0'} |
        <b>Unanswered:</b> ${escapeHtml(job.unansweredInvites) || '0'}
      </div>
      <div class="details">
        <b>Last viewed by client:</b> ${lastViewedContent}
      </div>
      ${comparisonLogHtml}
      <div class="interval-row">
        <label>Check every (min):</label>
        <input type="number" class="interval-input" value="${job.checkInterval}" min="1" data-id="${job.id}">
        <button class="remove-btn" data-id="${job.id}">Remove</button>
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
          setStatus('❌ ' + (response?.error || 'Failed to update interval'), 'error');
        }
        await renderJobs();
      }
    });
  });

  document.querySelectorAll('.remove-btn').forEach((btn) => {
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
  return String(text).replace(/[&<>"']/g, (m) => map[m]);
}

function setStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = 'status-' + type;
}

addBtn.addEventListener('click', async () => {
  setStatus('Adding current tab...', 'info');
  debugSection.innerHTML = '';
  logDebug('Starting add process...');

  try {
    const tab = await getActiveUpworkTab();
    logDebug(`Active tab ID: ${tab?.id}, URL: ${tab?.url}`);

    if (!tab?.id) {
      throw new Error('No active tab found. Open an Upwork job page in this window first.');
    }

    if (!isUpworkJobUrl(tab.url)) {
      throw new Error(
        'This tab is not an Upwork job page. Open a job from upwork.com (URL should contain /jobs/ or /freelance-jobs/).'
      );
    }

    logDebug('Reading page (may retry while SPA loads)...');
    const data = await extractDataFromTab(tab.id);

    if (!data) {
      throw new Error('Could not read the page. Wait for it to finish loading, then try again.');
    }

    if (data.captchaDetected) {
      throw new Error(
        'CAPTCHA or security verification is showing. Complete it in the tab, then add the job again.'
      );
    }

    logDebug(`Title: "${data.title}"`);
    logDebug(`Proposals: "${data.proposals}"`);
    logDebug(`Last viewed: "${data.lastViewed}" (source: ${data.lastViewedSource}, candidates: ${data.lastViewedCandidates || '?'})`);
    logDebug(`Parsed minutes: ${parseRelativeMinutes(data.lastViewed)}, specificity: ${lastViewedSpecificityScore(data.lastViewed)}`);

    if (!isValidLastViewedDisplay(data.lastViewed)) {
      throw new Error(
        'Could not find "Last viewed by client" on this page. Scroll to the Activity / Proposals block and try again.'
      );
    }

    logDebug('Sending to background...');
    const response = await chrome.runtime.sendMessage({
      action: 'addJob',
      data: {
        url: tab.url,
        tabId: tab.id,
        title: data.title,
        proposals: data.proposals,
        lastViewed: data.lastViewed,
        lastViewedSource: data.lastViewedSource,
        interviewing: data.interviewing,
        invitesSent: data.invitesSent,
        unansweredInvites: data.unansweredInvites,
        checkInterval: 5
      }
    });

    logDebug(`Background response: ${JSON.stringify(response)}`);

    if (!response) {
      throw new Error('No response from extension background. Reload the extension at chrome://extensions.');
    }
    if (response.success) {
      setStatus(`Job added. Last viewed: ${data.lastViewed}`, 'success');
      await renderJobs();
    } else {
      setStatus('❌ ' + (response.error || 'Failed to add job'), 'error');
    }
  } catch (err) {
    logDebug(`ERROR: ${err.message}`);
    setStatus('❌ ' + err.message, 'error');
  }
});

renderJobs();
