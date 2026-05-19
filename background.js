// background.js

// ---------- SIDE PANEL OPENING ----------
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ windowId: tab.windowId });
});

// ---------- TIME PARSING ----------
function parseRelativeMinutes(text) {
  if (!text) return null;
  const str = text.toLowerCase().trim();

  if (str === 'just now' || str === 'a moment ago' || str === 'moments ago') return 0;
  if (str === 'yesterday') return 1440;

  const match = str.match(/^(\d+)\s*(min(?:ute)?s?|hour|hr|day|week)s?\s*(ago)?/i);
  if (match) {
    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    if (unit.startsWith('min')) return value;
    if (unit.startsWith('hour') || unit.startsWith('hr')) return value * 60;
    if (unit.startsWith('day')) return value * 1440;
    if (unit.startsWith('week')) return value * 10080;
  }

  const singleMatch = str.match(/^an?\s+(min(?:ute)?|hour|hr|day|week)\s*(ago)?/i);
  if (singleMatch) {
    const unit = singleMatch[1].toLowerCase();
    if (unit.startsWith('min')) return 1;
    if (unit.startsWith('hour') || unit.startsWith('hr')) return 60;
    if (unit.startsWith('day')) return 1440;
    if (unit.startsWith('week')) return 10080;
  }
  return null;
}

// ---------- DATA EXTRACTION SCRIPT ----------
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

// ---------- REFRESH HANDLER ----------
async function processRefreshedTab(tabId) {
  const { jobs } = await chrome.storage.local.get('jobs');
  if (!jobs) return;

  const jobIndex = jobs.findIndex(j => j.tabId === tabId && j.pendingRefresh);
  if (jobIndex === -1) return;

  let job = jobs[jobIndex];
  job.pendingRefresh = false;

  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractionScript
    });
    if (!result || !result.result) return;

    const newData = result.result;
    const newMinutes = parseRelativeMinutes(newData.lastViewed);
    const oldMinutes = job.lastViewedMinutes;
    const oldLastViewed = job.lastViewed;   // old string

    console.log(`[Upwork Tracker] Tab ${tabId} refreshed.`);
    console.log(`  Old lastViewed: "${oldLastViewed}" -> ${oldMinutes} minutes`);
    console.log(`  New lastViewed: "${newData.lastViewed}" -> ${newMinutes} minutes`);

    // Store previous values BEFORE overwriting
    job.previousLastViewed = oldLastViewed || '(not set)';
    job.previousLastViewedMinutes = oldMinutes; // may be null
    job.lastViewed = newData.lastViewed;
    job.lastViewedMinutes = newMinutes;
    job.lastChangeTime = Date.now();

    // Update other fields
    job.title = newData.title;
    job.proposals = newData.proposals;
    job.interviewing = newData.interviewing;
    job.invitesSent = newData.invitesSent;
    job.unansweredInvites = newData.unansweredInvites;

    jobs[jobIndex] = job;
    await chrome.storage.local.set({ jobs });

    // --- NOTIFICATION LOGIC ---
    if (newMinutes != null && (oldMinutes == null || newMinutes < oldMinutes)) {
      console.log(`  -> NOTIFICATION triggered: old=${oldMinutes}, new=${newMinutes}`);
      const perm = await chrome.permissions.contains({ permissions: ['notifications'] });
      if (perm) {
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon48.png',
          title: 'Upwork Job Alert',
          message: `The client's last viewed time for "${job.title}" is ${newMinutes} minutes.`
        });
      } else {
        console.warn('[Upwork Tracker] Notifications permission missing.');
      }
    } else {
      console.log(`  -> No notification. (old=${oldMinutes}, new=${newMinutes})`);
    }
  } catch (err) {
    console.error(`[Upwork Tracker] Error processing refreshed tab ${tabId}:`, err);
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    processRefreshedTab(tabId);
  }
});

// ---------- TAB CLOSED CLEANUP ----------
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { jobs } = await chrome.storage.local.get('jobs');
  if (!jobs) return;
  const index = jobs.findIndex(j => j.tabId === tabId);
  if (index !== -1) {
    const job = jobs[index];
    await chrome.alarms.clear(job.id);
    jobs.splice(index, 1);
    await chrome.storage.local.set({ jobs });
    console.log(`[Upwork Tracker] Job "${job.title}" removed because tab was closed.`);
  }
});

// ---------- ALARM TRIGGER: REFRESH TAB ----------
chrome.alarms.onAlarm.addListener(async (alarm) => {
  const jobId = alarm.name;
  const { jobs } = await chrome.storage.local.get('jobs');
  if (!jobs) return;
  const job = jobs.find(j => j.id === jobId);
  if (!job) {
    chrome.alarms.clear(jobId);
    return;
  }

  try {
    const tab = await chrome.tabs.get(job.tabId);
    job.pendingRefresh = true;
    await chrome.storage.local.set({ jobs });
    console.log(`[Upwork Tracker] Refreshing tab ${job.tabId} for job "${job.title}"`);
    await chrome.tabs.reload(job.tabId);
  } catch (e) {
    console.warn(`[Upwork Tracker] Tab ${job.tabId} no longer exists, removing job.`);
    const newJobs = jobs.filter(j => j.id !== jobId);
    await chrome.storage.local.set({ jobs: newJobs });
    chrome.alarms.clear(jobId);
  }
});

// ---------- MESSAGE HANDLING ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.action === 'addJob') {
      const { url, tabId, title, proposals, lastViewed, interviewing, invitesSent, unansweredInvites, checkInterval } = msg.data;

      // --- DUPLICATE CHECK (by URL) ---
      const { jobs } = await chrome.storage.local.get('jobs');
      if (jobs && jobs.some(j => j.url === url)) {
        sendResponse({ success: false, error: 'This job posting has already been added.' });
        return;
      }

      const id = Date.now().toString();
      const lastViewedMinutes = parseRelativeMinutes(lastViewed);

      const newJob = {
        id,
        url,
        tabId,
        title,
        proposals,
        lastViewed,
        lastViewedMinutes,
        interviewing,
        invitesSent,
        unansweredInvites,
        checkInterval: checkInterval || 5,
        pendingRefresh: false,
        // previous values start empty
        previousLastViewed: null,
        previousLastViewedMinutes: null,
        lastChangeTime: null
      };

      const updatedJobs = jobs ? [...jobs, newJob] : [newJob];
      await chrome.storage.local.set({ jobs: updatedJobs });

      chrome.alarms.create(id, { periodInMinutes: newJob.checkInterval });
      console.log(`[Upwork Tracker] Job added: "${title}" (ID: ${id}), lastViewed="${lastViewed}" -> ${lastViewedMinutes}m`);

      sendResponse({ success: true });
    } else if (msg.action === 'removeJob') {
      const { id } = msg;
      await chrome.alarms.clear(id);
      const { jobs } = await chrome.storage.local.get('jobs');
      const updatedJobs = jobs ? jobs.filter(j => j.id !== id) : [];
      await chrome.storage.local.set({ jobs: updatedJobs });
      sendResponse({ success: true });
    } else if (msg.action === 'updateInterval') {
      const { id, checkInterval } = msg;
      await chrome.alarms.clear(id);
      chrome.alarms.create(id, { periodInMinutes: checkInterval });

      const { jobs } = await chrome.storage.local.get('jobs');
      if (jobs) {
        const job = jobs.find(j => j.id === id);
        if (job) {
          job.checkInterval = checkInterval;
          await chrome.storage.local.set({ jobs });
        }
      }
      sendResponse({ success: true });
    }
  })();
  return true;
});