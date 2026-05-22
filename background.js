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
async function extractFromTabWithRetry(tabId, maxAttempts = 3, delayMs = 800) {
  let bestData = null;
  let bestScore = -1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await sleep(delayMs);
    const data = await extractFromTab(tabId);
    if (!data) continue;
    if (data.captchaDetected) return data;

    const hasValid =
      data.lastViewedAbsent || (data.lastViewed && isValidLastViewedDisplay(data.lastViewed));
    const score = scoreExtractionResult(data);

    if (hasValid && score > bestScore) {
      bestScore = score;
      bestData = data;
    }
    if (score >= 150) return data;
    if (score >= 145 && isTrustworthyLastViewedSource(data.lastViewedSource)) return data;
    if (hasValid && isTrustworthyLastViewedSource(data.lastViewedSource)) return data;
  }

  if (
    bestData &&
    (bestData.lastViewedAbsent ||
      (bestData.lastViewed && isValidLastViewedDisplay(bestData.lastViewed)))
  ) {
    return bestData;
  }
  return bestData;
}

async function finishJobCheck(tabId, jobId, newData) {
  refreshByTab.delete(tabId);
  const { jobs } = await chrome.storage.local.get('jobs');
  if (jobs) {
    const idx = jobs.findIndex((j) => j.id === jobId && j.tabId === tabId);
    if (idx !== -1) {
      jobs[idx].pendingRefresh = false;
      await chrome.storage.local.set({ jobs });
    }
  }
  await applyExtractedData(tabId, jobId, newData);
}

/**
 * Every scheduled check: reload the tracked Upwork job TAB in Chrome,
 * then read/compare/notify in processRefreshedTab when load completes.
 */
async function runScheduledCheck(job) {
  const { jobs } = await chrome.storage.local.get('jobs');
  const jobIndex = jobs?.findIndex((j) => j.id === job.id);
  if (jobIndex === -1) return;

  const j = jobs[jobIndex];
  j.pendingRefresh = true;
  refreshByTab.set(j.tabId, j.id);
  await chrome.storage.local.set({ jobs });
  scheduleRefreshWatchdog(j.tabId, j.id);

  console.log(`[Upwork Tracker] Reloading job tab ${j.tabId} for "${j.title}"`);

  try {
    await chrome.tabs.get(j.tabId);
    await chrome.tabs.reload(j.tabId, { bypassCache: true });
  } catch (err) {
    console.warn(`[Upwork Tracker] Cannot reload tab ${j.tabId}:`, err);
    refreshByTab.delete(j.tabId);
    const { jobs: jobs2 } = await chrome.storage.local.get('jobs');
    const idx = jobs2?.findIndex((x) => x.id === job.id);
    if (idx !== -1 && jobs2) {
      jobs2[idx].pendingRefresh = false;
      jobs2[idx].lastExtractionError =
        'Job tab not found. Keep the Upwork job page open or pinned in this browser.';
      await chrome.storage.local.set({ jobs: jobs2 });
    }
  }
}

const pendingExtractRetries = new Map();
/** tabId -> jobId — survives storage race before reload completes */
const refreshByTab = new Map();

function clearRefreshState(jobs, jobIndex, tabId) {
  if (jobIndex >= 0 && jobs[jobIndex]) {
    jobs[jobIndex].pendingRefresh = false;
  }
  if (tabId != null) refreshByTab.delete(tabId);
}

function scheduleRefreshWatchdog(tabId, jobId) {
  const key = `${jobId}:${tabId}`;
  setTimeout(async () => {
    if (!refreshByTab.has(tabId)) return;
    console.warn(`[Upwork Tracker] Watchdog: refresh timed out for tab ${tabId}`);
    refreshByTab.delete(tabId);
    const { jobs } = await chrome.storage.local.get('jobs');
    if (!jobs) return;
    const idx = jobs.findIndex((j) => j.id === jobId && j.tabId === tabId);
    if (idx === -1) return;
    jobs[idx].pendingRefresh = false;
    jobs[idx].lastExtractionError = 'Refresh timed out. Will retry on next check.';
    await chrome.storage.local.set({ jobs });
  }, 45000);
}

function scheduleExtractRetry(tabId, jobId) {
  const key = `${jobId}:${tabId}`;
  if (pendingExtractRetries.has(key)) return;

  pendingExtractRetries.set(key, true);
  (async () => {
    try {
      const { jobs } = await chrome.storage.local.get('jobs');
      const job = jobs?.find((j) => j.id === jobId && j.tabId === tabId);
      if (!job) return;

      job.pendingRefresh = true;
      refreshByTab.set(tabId, jobId);
      await chrome.storage.local.set({ jobs });
      console.log(`[Upwork Tracker] Retry reload tab ${tabId} for job ${jobId}`);
      await chrome.tabs.reload(tabId, { bypassCache: true });
    } catch (err) {
      console.warn(`[Upwork Tracker] Retry reload failed:`, err);
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
  if (data.proposals != null) job.proposals = data.proposals;
  if (data.interviewing != null) job.interviewing = data.interviewing;
  if (data.invitesSent != null) job.invitesSent = data.invitesSent;
  if (data.unansweredInvites != null) job.unansweredInvites = data.unansweredInvites;
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
    job.pendingRefresh = false;
    refreshByTab.delete(tabId);
    jobs[jobIndex] = job;
    await chrome.storage.local.set({ jobs });
    return;
  }

  job.needsVerification = false;
  job.pendingRefresh = false;
  refreshByTab.delete(tabId);

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
    job.pendingRefresh = false;
    refreshByTab.delete(tabId);
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
    job.pendingRefresh = false;
    refreshByTab.delete(tabId);
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
    job.pendingRefresh = false;
    refreshByTab.delete(tabId);
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
    job.pendingRefresh = false;
    refreshByTab.delete(tabId);
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
    previous: oldRaw || '(not viewed yet)',
    current: newRaw,
    changed: meaningful,
    notified: notify && meaningful,
    reason: notify ? reason : rawChanged ? 'synced' : 'unchanged',
    source: newData.lastViewedSource
  });

  // After each tab refresh: always mirror the latest page data in the extension UI.
  if (newSeconds != null) {
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
    job.lastSyncedAt = Date.now();
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
  const pendingJobId = refreshByTab.get(tabId);
  const { jobs } = await chrome.storage.local.get('jobs');
  if (!jobs) return;

  let jobIndex = -1;
  if (pendingJobId) {
    jobIndex = jobs.findIndex((j) => j.id === pendingJobId && j.tabId === tabId);
  }
  if (jobIndex === -1) {
    jobIndex = jobs.findIndex((j) => j.tabId === tabId && j.pendingRefresh);
  }
  if (jobIndex === -1) return;

  const job = jobs[jobIndex];

  if (tabUrl && job.url && normalizeJobUrl(tabUrl) !== normalizeJobUrl(job.url)) {
    console.warn(`[Upwork Tracker] Tab ${tabId} URL changed; skipping update for "${job.title}".`);
    clearRefreshState(jobs, jobIndex, tabId);
    await chrome.storage.local.set({ jobs });
    return;
  }

  try {
    console.log(`[Upwork Tracker] Tab ${tabId} reload complete — reading Last viewed for "${job.title}"`);
    await sleep(300);
    const newData = await extractFromTabWithRetry(tabId, 4, 1000);
    if (!newData) {
      job.pendingRefresh = false;
      refreshByTab.delete(tabId);
      job.lastExtractionError = 'No data returned from page. Retrying…';
      jobs[jobIndex] = job;
      await chrome.storage.local.set({ jobs });
      scheduleExtractRetry(tabId, job.id);
      return;
    }

    if (newData.lastViewedAbsent && !newData.lastViewed) {
      await finishJobCheck(tabId, job.id, newData);
      return;
    }

    if (!isValidLastViewedDisplay(newData.lastViewed)) {
      job.pendingRefresh = false;
      refreshByTab.delete(tabId);
      job.lastExtractionError = 'Page not ready. Retrying…';
      jobs[jobIndex] = job;
      await chrome.storage.local.set({ jobs });
      scheduleExtractRetry(tabId, job.id);
      return;
    }

    await finishJobCheck(tabId, job.id, newData);
  } catch (err) {
    console.error(`[Upwork Tracker] Error processing refreshed tab ${tabId}:`, err);
    job.pendingRefresh = false;
    refreshByTab.delete(tabId);
    job.lastExtractionError = err.message || 'Extraction failed';
    jobs[jobIndex] = job;
    await chrome.storage.local.set({ jobs });
    scheduleExtractRetry(tabId, job.id);
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!refreshByTab.has(tabId)) {
    chrome.storage.local.get('jobs').then(({ jobs }) => {
      if (jobs?.some((j) => j.tabId === tabId && j.pendingRefresh)) {
        processRefreshedTab(tabId, tab.url);
      }
    });
    return;
  }
  processRefreshedTab(tabId, tab.url);
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
    await runScheduledCheck(job);
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
