// sidepanel.js
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
  debugSection.innerHTML += `<div>${new Date().toLocaleTimeString()}: ${msg}</div>`;
  debugSection.scrollTop = debugSection.scrollHeight;
}

function extractionScript() {
  const bodyText = document.body.innerText;
  const title = (
    document.querySelector('h1')?.innerText ||
    document.querySelector('[data-test="job-title"]')?.innerText ||
    document.querySelector('.job-title')?.innerText ||
    document.title.replace(' - Upwork', '').trim()
  ).trim();

  const proposalsMatch = bodyText.match(/Proposals:\s*([\d,\-–to\s]+?)(?=\n|Interviewing|Last viewed|Invites sent|Unanswered|$)/i);
  const proposals = proposalsMatch ? proposalsMatch[1].trim() : '';

  const lastViewedMatch = bodyText.match(/Last viewed by client:\s*(.+?)(?:\n|This is when|Interviewing|Invites sent|Unanswered|$)/i);
  const lastViewed = lastViewedMatch ? lastViewedMatch[1].trim() : '';

  const interviewingMatch = bodyText.match(/Interviewing:\s*(\d+)/i);
  const interviewing = interviewingMatch ? interviewingMatch[1] : '';

  const invitesSentMatch = bodyText.match(/Invites sent:\s*(\d+)/i);
  const invitesSent = invitesSentMatch ? invitesSentMatch[1] : '';

  const unansweredInvitesMatch = bodyText.match(/Unanswered invites:\s*(\d+)/i);
  const unansweredInvites = unansweredInvitesMatch ? unansweredInvitesMatch[1] : '';

  return { title, proposals, lastViewed, interviewing, invitesSent, unansweredInvites };
}

async function extractDataFromTab(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractionScript
  });
  if (!result || !result.result) {
    throw new Error('Script executed but returned no data. The page may not be fully loaded.');
  }
  return result.result;
}

// Format relative time for display (e.g., "2 hours ago")
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
  const d = new Date(timestamp);
  return d.toLocaleTimeString();
}

async function renderJobs() {
  const { jobs } = await chrome.storage.local.get('jobs');
  jobListEl.innerHTML = '';
  if (!jobs || jobs.length === 0) {
    jobListEl.innerHTML = '<p style="color:#888; text-align:center;">No job postings added yet.</p>';
    return;
  }
  jobs.forEach(job => {
    // Last viewed display (bold red or REFRESHING...)
    let lastViewedContent;
    if (job.pendingRefresh) {
      lastViewedContent = '<span style="color: #e67e22; font-weight: bold;">REFRESHING...</span>';
    } else {
      lastViewedContent = `<span style="color: red; font-weight: bold;">${escapeHtml(job.lastViewed) || 'unknown'}</span>`;
    }

    // --- CHANGE LOG (previous -> new) ---
    let changeLogHtml = '';
    if (job.previousLastViewed !== null && job.previousLastViewed !== undefined) {
      const prevTime = job.previousLastViewedMinutes != null
        ? formatTime(job.previousLastViewedMinutes)
        : job.previousLastViewed;
      const newTime = job.lastViewedMinutes != null
        ? formatTime(job.lastViewedMinutes)
        : job.lastViewed;
      const changeTime = formatChangeTime(job.lastChangeTime);
      changeLogHtml = `
        <div class="change-log">
          <b>Change:</b> ${escapeHtml(prevTime)} → ${escapeHtml(newTime)}<br>
          <small>${changeTime ? 'at ' + changeTime : ''}</small>
        </div>
      `;
    }

    const div = document.createElement('div');
    div.className = 'job-item';
    div.innerHTML = `
      <div class="job-title">${escapeHtml(job.title) || '(no title)'}</div>
      <div class="details">
        <b>Proposals:</b> ${job.proposals || '?'}<br>
        <b>Interviewing:</b> ${job.interviewing || '0'} | 
        <b>Invites:</b> ${job.invitesSent || '0'} | 
        <b>Unanswered:</b> ${job.unansweredInvites || '0'}
      </div>
      <div class="details">
        <b>Last viewed:</b> ${lastViewedContent}
      </div>
      ${changeLogHtml}
      <div class="interval-row">
        <label>Check every (min):</label>
        <input type="number" class="interval-input" value="${job.checkInterval}" min="1" data-id="${job.id}">
        <button class="remove-btn" data-id="${job.id}">Remove</button>
      </div>
    `;
    jobListEl.appendChild(div);
  });

  document.querySelectorAll('.interval-input').forEach(input => {
    input.addEventListener('change', async (e) => {
      const id = e.target.dataset.id;
      const newInterval = parseInt(e.target.value, 10);
      if (newInterval > 0) {
        await chrome.runtime.sendMessage({ action: 'updateInterval', id, checkInterval: newInterval });
        await renderJobs();
      }
    });
  });

  document.querySelectorAll('.remove-btn').forEach(btn => {
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
  return String(text).replace(/[&<>"']/g, m => map[m]);
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
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    logDebug(`Active tab ID: ${tab?.id}, URL: ${tab?.url}`);

    if (!tab || !tab.id) {
      throw new Error('No active tab found. Please open an Upwork job posting first.');
    }

    const upworkJobPattern = /^https?:\/\/.*\.upwork\.com\/(freelance-)?jobs\//;
    logDebug(`URL check: "${tab.url}" matches pattern? ${upworkJobPattern.test(tab.url)}`);

    if (!upworkJobPattern.test(tab.url)) {
      throw new Error(`This does not look like an Upwork job posting. URL: ${tab.url}`);
    }

    logDebug('Injecting extraction script...');
    const data = await extractDataFromTab(tab.id);
    logDebug(`Extracted - Title: "${data.title}"`);
    logDebug(`Extracted - Proposals: "${data.proposals}"`);
    logDebug(`Extracted - Last Viewed: "${data.lastViewed}"`);
    logDebug(`Extracted - Interviewing: "${data.interviewing}"`);
    logDebug(`Extracted - Invites Sent: "${data.invitesSent}"`);
    logDebug(`Extracted - Unanswered Invites: "${data.unansweredInvites}"`);

    if (!data.title && !data.lastViewed) {
      throw new Error('Could not extract any data from the page.');
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
        interviewing: data.interviewing,
        invitesSent: data.invitesSent,
        unansweredInvites: data.unansweredInvites,
        checkInterval: 5
      }
    });

    logDebug(`Background response: ${JSON.stringify(response)}`);
    if (response.success) {
      setStatus('✅ Job added successfully!', 'success');
      await renderJobs();
    } else {
      setStatus('❌ ' + (response.error || 'Failed to add job'), 'error');
    }
  } catch (err) {
    logDebug(`❌ ERROR: ${err.message}`);
    setStatus('❌ ' + err.message, 'error');
  }
});

// Initial render
renderJobs();