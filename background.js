// background.js
importScripts('extractor-shared.js');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- SIDE PANEL ----------
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await syncAlarmsFromStorage();
});

chrome.runtime.onStartup.addListener(() => {
  syncAlarmsFromStorage();
});

async function syncAlarmsFromStorage() {
  const { jobs } = await chrome.storage.local.get('jobs');
  if (!jobs?.length) return;

  const existing = new Set((await chrome.alarms.getAll()).map((a) => a.name));
  for (const job of jobs) {
    if (!existing.has(job.id)) {
      const minutes = Math.max(1, job.checkInterval || 5);
      chrome.alarms.create(job.id, { periodInMinutes: minutes });
    }
  }
}

async function extractFromTab(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractionScript
  });
  return result?.result || null;
}

/** Retry extraction — Upwork SPA often renders stats after 'complete'. */
async function extractFromTabWithRetry(tabId, maxAttempts = 5, delayMs = 1200) {
  let lastData = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await sleep(delayMs);
    lastData = await extractFromTab(tabId);
    if (!lastData) continue;
    if (lastData.captchaDetected) return lastData;
    if (lastData.lastViewed && isValidLastViewedDisplay(lastData.lastViewed)) return lastData;
    if (lastData.pageReady && attempt >= maxAttempts - 1) return lastData;
  }
  return lastData;
}

function notifyClientViewed(job, lastViewedDisplay) {
  chrome.notifications.create(`view-${job.id}-${Date.now()}`, {
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: 'Upwork Job Alert — Client viewed',
    message: `"${job.title}": Last viewed by client is now ${lastViewedDisplay}.`
  });
}

function notifyCaptcha(job) {
  chrome.notifications.create(`captcha-${job.id}-${Date.now()}`, {
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: 'Upwork Job Tracker — Verification required',
    message: `CAPTCHA or security check on "${job.title}". Open the tab, complete verification, then remove and re-add the job.`
  });
}

function updateSecondaryFields(job, data) {
  if (data.title) job.title = data.title;
  if (data.proposals) job.proposals = data.proposals;
  if (data.interviewing) job.interviewing = data.interviewing;
  if (data.invitesSent) job.invitesSent = data.invitesSent;
  if (data.unansweredInvites) job.unansweredInvites = data.unansweredInvites;
}

// ---------- REFRESH HANDLER ----------
async function processRefreshedTab(tabId, tabUrl) {
  const { jobs } = await chrome.storage.local.get('jobs');
  if (!jobs) return;

  const jobIndex = jobs.findIndex((j) => j.tabId === tabId && j.pendingRefresh);
  if (jobIndex === -1) return;

  const job = jobs[jobIndex];
  job.pendingRefresh = false;

  if (tabUrl && job.url && normalizeJobUrl(tabUrl) !== normalizeJobUrl(job.url)) {
    console.warn(`[Upwork Tracker] Tab ${tabId} URL changed; skipping update for "${job.title}".`);
    jobs[jobIndex] = job;
    await chrome.storage.local.set({ jobs });
    return;
  }

  try {
    const newData = await extractFromTabWithRetry(tabId);
    if (!newData) {
      job.lastExtractionError = 'No data returned from page.';
      jobs[jobIndex] = job;
      await chrome.storage.local.set({ jobs });
      return;
    }

    updateSecondaryFields(job, newData);

    // --- CAPTCHA / bot check ---
    if (newData.captchaDetected) {
      console.warn(`[Upwork Tracker] CAPTCHA detected on tab ${tabId} for "${job.title}".`);
      job.needsVerification = true;
      job.lastExtractionError = 'CAPTCHA or security verification detected.';
      const now = Date.now();
      if (!job.lastCaptchaAlertAt || now - job.lastCaptchaAlertAt > 30 * 60 * 1000) {
        job.lastCaptchaAlertAt = now;
        notifyCaptcha(job);
      }
      jobs[jobIndex] = job;
      await chrome.storage.local.set({ jobs });
      return;
    }

    job.needsVerification = false;
    job.lastExtractionError = null;

    const newRaw = newData.lastViewed || '';
    const oldRaw = job.lastViewed || '';

    if (!isValidLastViewedDisplay(newRaw)) {
      console.warn(
        `[Upwork Tracker] Could not read valid "Last viewed by client" on tab ${tabId} (source: ${newData.lastViewedSource}). Keeping previous value: "${oldRaw}".`
      );
      job.lastExtractionError = 'Could not read "Last viewed by client" from page. Tab left unchanged.';
      jobs[jobIndex] = job;
      await chrome.storage.local.set({ jobs });
      return;
    }

    const newMinutes = parseRelativeMinutes(newRaw);
    const oldMinutes = job.lastViewedMinutes;

    console.log(`[Upwork Tracker] Tab ${tabId} refreshed (source: ${newData.lastViewedSource}).`);
    console.log(`  Stored: "${oldRaw}" (${oldMinutes} min) -> Page: "${newRaw}" (${newMinutes} min)`);

    const { notify, reason } = shouldNotifyClientViewed(oldMinutes, newMinutes, oldRaw, newRaw);

    const rawChanged = normalizeLastViewedText(oldRaw) !== normalizeLastViewedText(newRaw);

    if (rawChanged && newMinutes != null) {
      job.previousLastViewed = oldRaw || null;
      job.previousLastViewedMinutes = oldMinutes;
      job.lastViewed = newRaw;
      job.lastViewedMinutes = newMinutes;
      job.lastChangeTime = Date.now();
    } else if (!oldRaw && newMinutes != null) {
      job.lastViewed = newRaw;
      job.lastViewedMinutes = newMinutes;
    }

    jobs[jobIndex] = job;
    await chrome.storage.local.set({ jobs });

    if (notify) {
      console.log(`  -> NOTIFY (${reason}): ${oldMinutes} -> ${newMinutes} min`);
      notifyClientViewed(job, newRaw);
    } else {
      console.log(`  -> No notify (${reason}).`);
    }
  } catch (err) {
    console.error(`[Upwork Tracker] Error processing refreshed tab ${tabId}:`, err);
    job.lastExtractionError = err.message || 'Extraction failed';
    jobs[jobIndex] = job;
    await chrome.storage.local.set({ jobs });
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    processRefreshedTab(tabId, tab.url);
  }
});

// ---------- TAB CLOSED CLEANUP ----------
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { jobs } = await chrome.storage.local.get('jobs');
  if (!jobs) return;
  const index = jobs.findIndex((j) => j.tabId === tabId);
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
  const job = jobs.find((j) => j.id === jobId);
  if (!job) {
    chrome.alarms.clear(jobId);
    return;
  }

  try {
    await chrome.tabs.get(job.tabId);
    job.pendingRefresh = true;
    await chrome.storage.local.set({ jobs });
    console.log(`[Upwork Tracker] Refreshing tab ${job.tabId} for job "${job.title}"`);
    await chrome.tabs.reload(job.tabId);
  } catch {
    console.warn(`[Upwork Tracker] Tab ${job.tabId} no longer exists, removing job.`);
    const newJobs = jobs.filter((j) => j.id !== jobId);
    await chrome.storage.local.set({ jobs: newJobs });
    chrome.alarms.clear(jobId);
  }
});

// ---------- MESSAGE HANDLING ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.action === 'addJob') {
        const {
          url,
          tabId,
          title,
          proposals,
          lastViewed,
          interviewing,
          invitesSent,
          unansweredInvites,
          checkInterval,
          lastViewedSource
        } = msg.data;

        if (!isValidLastViewedDisplay(lastViewed)) {
          sendResponse({
            success: false,
            error:
              'Could not read "Last viewed by client" on this page. Scroll to the job Activity section and try again.'
          });
          return;
        }

        const normalizedUrl = normalizeJobUrl(url);
        const { jobs } = await chrome.storage.local.get('jobs');
        if (jobs?.some((j) => normalizeJobUrl(j.url) === normalizedUrl)) {
          sendResponse({ success: false, error: 'This job posting has already been added.' });
          return;
        }

        const id = Date.now().toString();
        const lastViewedMinutes = parseRelativeMinutes(lastViewed);
        const interval = Math.max(1, checkInterval || 5);

        const newJob = {
          id,
          url: normalizedUrl,
          tabId,
          title,
          proposals,
          lastViewed,
          lastViewedMinutes,
          lastViewedSource: lastViewedSource || 'manual-add',
          interviewing,
          invitesSent,
          unansweredInvites,
          checkInterval: interval,
          pendingRefresh: false,
          needsVerification: false,
          lastExtractionError: null,
          lastCaptchaAlertAt: null,
          previousLastViewed: null,
          previousLastViewedMinutes: null,
          lastChangeTime: null
        };

        const updatedJobs = jobs ? [...jobs, newJob] : [newJob];
        await chrome.storage.local.set({ jobs: updatedJobs });
        chrome.alarms.create(id, { periodInMinutes: interval });
        console.log(
          `[Upwork Tracker] Job added: "${title}", lastViewed="${lastViewed}" (${lastViewedMinutes}m, ${lastViewedSource})`
        );
        sendResponse({ success: true });
      } else if (msg.action === 'removeJob') {
        const { id } = msg;
        await chrome.alarms.clear(id);
        const { jobs } = await chrome.storage.local.get('jobs');
        const updatedJobs = jobs ? jobs.filter((j) => j.id !== id) : [];
        await chrome.storage.local.set({ jobs: updatedJobs });
        sendResponse({ success: true });
      } else if (msg.action === 'updateInterval') {
        const { id, checkInterval } = msg;
        const interval = Math.max(1, checkInterval);
        await chrome.alarms.clear(id);
        chrome.alarms.create(id, { periodInMinutes: interval });

        const { jobs } = await chrome.storage.local.get('jobs');
        if (jobs) {
          const job = jobs.find((j) => j.id === id);
          if (job) {
            job.checkInterval = interval;
            await chrome.storage.local.set({ jobs });
          }
        }
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'Unknown action' });
      }
    } catch (err) {
      console.error('[Upwork Tracker] Message handler error:', err);
      sendResponse({ success: false, error: err.message || 'Internal error' });
    }
  })();
  return true;
});
