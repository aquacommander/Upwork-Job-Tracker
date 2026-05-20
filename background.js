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
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractionScript
    });
    return result?.result || null;
  } catch (err) {
    console.warn(`[Upwork Tracker] executeScript failed on tab ${tabId}:`, err);
    return null;
  }
}

/** Pick the best result across retries (prefer specific times like "17 hours ago" over "yesterday"). */
function scoreExtractionResult(data) {
  if (!data?.lastViewed || !isValidLastViewedDisplay(data.lastViewed)) return -1;
  let score = lastViewedSpecificityScore(data.lastViewed);
  if (data.lastViewedSource?.startsWith('activity')) score += 50;
  if (data.lastViewedSource === 'data-test') score += 40;
  if (data.lastViewedSource === 'activity-dt-dd') score += 55;
  return score;
}

function isTrustworthyLastViewedSource(source) {
  if (!source) return false;
  return (
    source.startsWith('activity') ||
    source === 'data-test' ||
    source === 'activity-dt-dd'
  );
}

/** Retry extraction — in-page wait handles SPA; background retries catch late renders. */
async function extractFromTabWithRetry(tabId, maxAttempts = 4, delayMs = 2000) {
  let bestData = null;
  let bestScore = -1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await sleep(delayMs);
    const data = await extractFromTab(tabId);
    if (!data) continue;
    if (data.captchaDetected) return data;

    const score = scoreExtractionResult(data);
    if (score > bestScore) {
      bestScore = score;
      bestData = data;
    }
    if (score >= 150) return data;
    if (score >= 145 && isTrustworthyLastViewedSource(data.lastViewedSource)) return data;
  }
  return bestData;
}

const pendingExtractRetries = new Map();

function scheduleExtractRetry(tabId, jobId) {
  const key = `${jobId}:${tabId}`;
  if (pendingExtractRetries.has(key)) return;

  pendingExtractRetries.set(key, true);
  (async () => {
    try {
      for (let i = 1; i <= 3; i++) {
        await sleep(i * 2500);
        const { jobs } = await chrome.storage.local.get('jobs');
        const job = jobs?.find((j) => j.id === jobId && j.tabId === tabId);
        if (!job) break;

        const newData = await extractFromTabWithRetry(tabId, 2, 1500);
        if (
          newData &&
          (newData.lastViewedAbsent || isValidLastViewedDisplay(newData.lastViewed))
        ) {
          await applyExtractedData(tabId, jobId, newData, { fromRetry: true });
          break;
        }
      }
    } finally {
      pendingExtractRetries.delete(key);
    }
  })();
}

function notifyClientViewed(job, lastViewedDisplay, reason) {
  const isFirst = reason === 'first-view';
  chrome.notifications.create(`view-${job.id}-${Date.now()}`, {
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    priority: 2,
    title: isFirst ? 'Upwork — Client viewed (first time)' : 'Upwork — Client viewed again',
    message: isFirst
      ? `"${job.title}": Client viewed for the first time — ${lastViewedDisplay}.`
      : `"${job.title}": Last viewed by client is now ${lastViewedDisplay}.`
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

function recordComparison(job, entry) {
  job.lastComparison = {
    at: Date.now(),
    previous: entry.previous ?? '(none)',
    current: entry.current ?? '(unknown)',
    changed: !!entry.changed,
    notified: !!entry.notified,
    skipped: !!entry.skipped,
    reason: entry.reason || null,
    error: !!entry.error,
    source: entry.source || null
  };
}

function recordMeaningfulChange(job, from, to, notified) {
  if (!from || !to || normalizeLastViewedText(from) === normalizeLastViewedText(to)) return;
  const entry = { at: Date.now(), from, to, notified: !!notified };
  job.lastMeaningfulChange = entry;
  job.changeHistory = [entry];
}

// ---------- REFRESH HANDLER ----------
async function applyExtractedData(tabId, jobId, newData, opts = {}) {
  const { jobs } = await chrome.storage.local.get('jobs');
  if (!jobs) return;

  const jobIndex = jobs.findIndex((j) => j.id === jobId && j.tabId === tabId);
  if (jobIndex === -1) return;

  const job = jobs[jobIndex];
  updateSecondaryFields(job, newData);

  if (newData.captchaDetected) {
    console.warn(`[Upwork Tracker] CAPTCHA detected on tab ${tabId} for "${job.title}".`);
    job.needsVerification = true;
    job.lastExtractionError = 'CAPTCHA or security verification detected.';
    recordComparison(job, {
      previous: job.lastViewed || '(none)',
      current: '(CAPTCHA / verification)',
      changed: false,
      error: true,
      reason: 'captcha'
    });
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

  const newRaw = newData.lastViewed || '';
  const oldRaw = job.lastViewed || '';

  if (newData.lastViewedAbsent && !newRaw) {
    job.awaitingFirstView = true;
    job.lastViewed = null;
    job.lastViewedSeconds = null;
    job.lastExtractionError = null;
    recordComparison(job, {
      previous: '(not viewed yet)',
      current: '(not viewed yet)',
      changed: false,
      reason: 'awaiting-first-view',
      source: newData.lastViewedSource
    });
    jobs[jobIndex] = job;
    await chrome.storage.local.set({ jobs });
    return;
  }

  if (!isValidLastViewedDisplay(newRaw)) {
    console.warn(
      `[Upwork Tracker] Invalid last viewed on tab ${tabId} (source: ${newData.lastViewedSource}, raw: "${newRaw}").`
    );
    job.lastExtractionError =
      'Could not read "Last viewed by client" from page. Retrying without reload…';
    recordComparison(job, {
      previous: oldRaw,
      current: '(read failed)',
      changed: false,
      error: true,
      source: newData.lastViewedSource
    });
    jobs[jobIndex] = job;
    await chrome.storage.local.set({ jobs });
    if (!opts.fromRetry) scheduleExtractRetry(tabId, jobId);
    return;
  }

  job.lastExtractionError = null;

  const newSeconds = parseRelativeSeconds(newRaw);
  const oldSeconds = getJobLastViewedSeconds(job);

  console.log(`[Upwork Tracker] Tab ${tabId} extract (source: ${newData.lastViewedSource}).`);
  console.log(`  Stored: "${oldRaw}" (${oldSeconds}s) -> Page: "${newRaw}" (${newSeconds}s)`);

  if (
    oldSeconds != null &&
    newSeconds != null &&
    newSeconds < oldSeconds &&
    oldSeconds - newSeconds >= 120 &&
    !isTrustworthyLastViewedSource(newData.lastViewedSource)
  ) {
    console.warn(
      `[Upwork Tracker] Rejected untrusted "more recent" read "${newRaw}" (keeping "${oldRaw}").`
    );
    job.lastExtractionError = `Kept "${oldRaw}" — unreliable read "${newRaw}". Will retry.`;
    recordComparison(job, {
      previous: oldRaw,
      current: newRaw,
      changed: false,
      skipped: true,
      reason: 'untrusted-read',
      source: newData.lastViewedSource
    });
    jobs[jobIndex] = job;
    await chrome.storage.local.set({ jobs });
    if (!opts.fromRetry) scheduleExtractRetry(tabId, jobId);
    return;
  }

  if (isLikelyExtractionRegression(oldRaw, newRaw, oldSeconds, newSeconds)) {
    console.warn(
      `[Upwork Tracker] Rejected ambiguous read "${newRaw}" (keeping "${oldRaw}").`
    );
    job.lastExtractionError = `Kept "${oldRaw}" — page read "${newRaw}" looked incorrect. Will retry.`;
    recordComparison(job, {
      previous: oldRaw,
      current: newRaw,
      changed: false,
      skipped: true,
      reason: 'rejected-read',
      source: newData.lastViewedSource
    });
    jobs[jobIndex] = job;
    await chrome.storage.local.set({ jobs });
    if (!opts.fromRetry) scheduleExtractRetry(tabId, jobId);
    return;
  }

  const hadNoBaseline = oldSeconds == null;
  const { notify, reason } = shouldNotifyClientViewed(oldSeconds, newSeconds, oldRaw, newRaw, {
    awaitingFirstView: job.awaitingFirstView,
    hadNoBaseline
  });
  const rawChanged = normalizeLastViewedText(oldRaw) !== normalizeLastViewedText(newRaw);
  const meaningful = isMeaningfulLastViewedChange(oldSeconds, newSeconds, notify);

  recordComparison(job, {
    previous: meaningful ? oldRaw || '(not viewed yet)' : newRaw,
    current: newRaw,
    changed: meaningful,
    notified: notify && meaningful,
    reason: meaningful ? reason : rawChanged ? 'synced' : 'unchanged',
    source: newData.lastViewedSource
  });

  if (newSeconds != null && (rawChanged || !oldRaw || job.awaitingFirstView)) {
    if (meaningful) {
      job.previousLastViewed = oldRaw || null;
      job.previousLastViewedSeconds = oldSeconds;
      recordMeaningfulChange(job, oldRaw || '(not viewed yet)', newRaw, notify);
      job.lastChangeTime = Date.now();
    }
    job.awaitingFirstView = false;
    job.lastViewed = newRaw;
    job.lastViewedSeconds = newSeconds;
    job.lastViewedMinutes = Math.floor(newSeconds / 60);
    job.lastViewedSource = newData.lastViewedSource || job.lastViewedSource;
  }

  jobs[jobIndex] = job;
  await chrome.storage.local.set({ jobs });

  if (notify) {
    console.log(`  -> NOTIFY (${reason}): ${oldSeconds}s -> ${newSeconds}s`);
    notifyClientViewed(job, newRaw, reason);
  } else {
    console.log(`  -> No notify (${reason}).`);
  }
}

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
    await sleep(500);
    const newData = await extractFromTabWithRetry(tabId);
    if (!newData) {
      job.lastExtractionError = 'No data returned from page. Retrying…';
      jobs[jobIndex] = job;
      await chrome.storage.local.set({ jobs });
      scheduleExtractRetry(tabId, job.id);
      return;
    }

    if (newData.lastViewedAbsent && !newData.lastViewed) {
      await applyExtractedData(tabId, job.id, newData);
      return;
    }

    if (!isValidLastViewedDisplay(newData.lastViewed)) {
      job.lastExtractionError = 'Could not read "Last viewed by client" (page not ready). Retrying…';
      jobs[jobIndex] = job;
      await chrome.storage.local.set({ jobs });
      scheduleExtractRetry(tabId, job.id);
      return;
    }

    await applyExtractedData(tabId, job.id, newData);
  } catch (err) {
    console.error(`[Upwork Tracker] Error processing refreshed tab ${tabId}:`, err);
    job.lastExtractionError = err.message || 'Extraction failed';
    jobs[jobIndex] = job;
    await chrome.storage.local.set({ jobs });
    scheduleExtractRetry(tabId, job.id);
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
    await chrome.tabs.reload(job.tabId, { bypassCache: true });
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

        const lastViewedAbsent = !!msg.data.lastViewedAbsent;
        const hasTime = isValidLastViewedDisplay(lastViewed);

        if (!lastViewedAbsent && !hasTime) {
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
        const lastViewedSeconds = hasTime ? parseRelativeSeconds(lastViewed) : null;
        const interval = Math.max(1, checkInterval || 5);

        const newJob = {
          id,
          url: normalizedUrl,
          tabId,
          title,
          proposals,
          lastViewed: hasTime ? lastViewed : null,
          lastViewedSeconds,
          lastViewedMinutes: lastViewedSeconds != null ? Math.floor(lastViewedSeconds / 60) : null,
          lastViewedSource: lastViewedSource || 'manual-add',
          awaitingFirstView: lastViewedAbsent || !hasTime,
          interviewing,
          invitesSent,
          unansweredInvites,
          checkInterval: interval,
          pendingRefresh: false,
          needsVerification: false,
          lastExtractionError: null,
          lastCaptchaAlertAt: null,
          previousLastViewed: null,
          previousLastViewedSeconds: null,
          lastChangeTime: null,
          lastComparison: {
            at: Date.now(),
            previous: '(added)',
            current: hasTime ? lastViewed : '(waiting for first view)',
            changed: false,
            notified: false,
            source: lastViewedSource || 'manual-add'
          },
          changeHistory: [],
          lastMeaningfulChange: null
        };

        const updatedJobs = jobs ? [...jobs, newJob] : [newJob];
        await chrome.storage.local.set({ jobs: updatedJobs });
        chrome.alarms.create(id, { periodInMinutes: interval });
        console.log(
          `[Upwork Tracker] Job added: "${title}", lastViewed="${lastViewed || 'absent'}" (${lastViewedSeconds}s, awaiting=${newJob.awaitingFirstView})`
        );
        sendResponse({ success: true, awaitingFirstView: newJob.awaitingFirstView });
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
