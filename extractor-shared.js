// Shared by background.js (importScripts) and sidepanel.html (script tag).

function isUpworkJobUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const { hostname, pathname } = new URL(url);
    if (!hostname.endsWith('upwork.com')) return false;
    return /\/jobs\//i.test(pathname) || /\/freelance-jobs\//i.test(pathname);
  } catch {
    return false;
  }
}

function normalizeJobUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    u.search = '';
    return u.href.replace(/\/$/, '');
  } catch {
    return url;
  }
}

/**
 * Upwork "Last viewed by client" uses English relative time in the Activity block.
 * Typical tiers (most specific → least):
 *   seconds (< 1 min) | minutes (< 1 hr) | hours (< 1 day) | days (< 1 week) | weeks (< ~1 month) | months
 * Also: just now, less than a minute/hour, today, yesterday, and vague phrases (few hours, etc.).
 */
const LAST_VIEWED_UNIT_MS = {
  second: 1000,
  minute: 60 * 1000,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000
};

function normalizeLastViewedText(text) {
  return (text || '')
    .toLowerCase()
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[.]+$/g, '')
    .replace(/^(about|approximately|around|over|almost|more than|less than)\s+/i, '')
    .trim();
}

/** Classify display string into unit bucket for logging/debug. */
function classifyLastViewedUnit(text) {
  const s = normalizeLastViewedText(text);
  if (!s) return null;
  if (/^just now$|^a moment ago$|^moments ago$/.test(s)) return { unit: 'instant', value: 0 };
  if (/^less than a minute ago$/.test(s)) return { unit: 'seconds', value: 0 };
  if (/^less than an hour ago$/.test(s)) return { unit: 'minutes', value: 0 };
  if (/^today$/.test(s)) return { unit: 'today', value: 0 };
  if (/^yesterday$/.test(s)) return { unit: 'yesterday', value: 1 };
  const sec = s.match(/^(\d+)\s*seconds?\s*ago$/);
  if (sec) return { unit: 'seconds', value: parseInt(sec[1], 10) };
  const min = s.match(/^(\d+)\s*min(?:ute)?s?\s*ago$/);
  if (min) return { unit: 'minutes', value: parseInt(min[1], 10) };
  const hr = s.match(/^(\d+)\s*hours?\s*ago$|^(\d+)\s*hrs?\s*ago$/);
  if (hr) return { unit: 'hours', value: parseInt(hr[1] || hr[2], 10) };
  const singleHr = s.match(/^an?\s+hours?\s*ago$/);
  if (singleHr) return { unit: 'hours', value: 1 };
  const day = s.match(/^(\d+)\s*days?\s*ago$/);
  if (day) return { unit: 'days', value: parseInt(day[1], 10) };
  const singleDay = s.match(/^an?\s+days?\s*ago$/);
  if (singleDay) return { unit: 'days', value: 1 };
  const week = s.match(/^(\d+)\s*weeks?\s*ago$/);
  if (week) return { unit: 'weeks', value: parseInt(week[1], 10) };
  const singleWeek = s.match(/^an?\s+weeks?\s*ago$/);
  if (singleWeek) return { unit: 'weeks', value: 1 };
  const month = s.match(/^(\d+)\s*months?\s*ago$/);
  if (month) return { unit: 'months', value: parseInt(month[1], 10) };
  const singleMonth = s.match(/^an?\s+months?\s*ago$/);
  if (singleMonth) return { unit: 'months', value: 1 };
  if (s.includes('few hours')) return { unit: 'hours', value: 3, vague: true };
  if (s.includes('few minutes')) return { unit: 'minutes', value: 3, vague: true };
  if (s.includes('half an hour')) return { unit: 'minutes', value: 30, vague: true };
  if (s.includes('couple of hours')) return { unit: 'hours', value: 2, vague: true };
  if (s.includes('couple of days')) return { unit: 'days', value: 2, vague: true };
  return { unit: 'unknown', value: null, raw: s };
}

/** True if the string looks like Upwork's relative "last viewed" display. */
function isValidLastViewedDisplay(text) {
  const s = normalizeLastViewedText(text);
  if (!s || s.length > 120) return false;
  return parseRelativeSeconds(s) !== null;
}

/** Convert display text to seconds (all comparisons and alerts use this). */
function parseRelativeSeconds(text) {
  if (!text) return null;
  const str = normalizeLastViewedText(text);

  if (str === 'just now' || str === 'a moment ago' || str === 'moments ago') return 0;
  if (str === 'less than a minute ago') return 30;
  if (str === 'less than an hour ago') return 30 * 60;
  if (str === 'yesterday') return 86400;
  if (str === 'today') return 0;

  if (str.includes('half an hour')) return 30 * 60;
  if (str.includes('few hours')) return 3 * 3600;
  if (str.includes('few minutes')) return 3 * 60;
  if (str.includes('couple of hours')) return 2 * 3600;
  if (str.includes('couple of days')) return 2 * 86400;

  const secMatch = str.match(/^(\d+)\s*seconds?\s*ago$/i);
  if (secMatch) return parseInt(secMatch[1], 10);

  const match = str.match(/^(\d+)\s*(sec(?:ond)?s?|min(?:ute)?s?|hours?|hrs?|days?|weeks?|months?)\s*ago$/i);
  if (match) {
    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    if (unit.startsWith('sec')) return value;
    if (unit.startsWith('min')) return value * 60;
    if (unit.startsWith('hour') || unit.startsWith('hr')) return value * 3600;
    if (unit.startsWith('day')) return value * 86400;
    if (unit.startsWith('week')) return value * 604800;
    if (unit.startsWith('month')) return value * 2592000;
  }

  const singleMatch = str.match(/^an?\s+(sec(?:ond)?|min(?:ute)?|hour|hr|day|week|month)\s*ago$/i);
  if (singleMatch) {
    const unit = singleMatch[1].toLowerCase();
    if (unit.startsWith('sec')) return 1;
    if (unit.startsWith('min')) return 60;
    if (unit.startsWith('hour') || unit.startsWith('hr')) return 3600;
    if (unit.startsWith('day')) return 86400;
    if (unit.startsWith('week')) return 604800;
    if (unit.startsWith('month')) return 2592000;
  }

  const parsed = Date.parse(text);
  if (!Number.isNaN(parsed)) {
    const diffMs = Date.now() - parsed;
    if (diffMs >= 0 && diffMs < 365 * 24 * 60 * 60 * 1000) {
      return Math.floor(diffMs / 1000);
    }
  }

  return null;
}

function getJobLastViewedSeconds(job) {
  if (!job) return null;
  if (job.lastViewedSeconds != null) return job.lastViewedSeconds;
  if (job.lastViewedMinutes != null) return job.lastViewedMinutes * 60;
  if (job.lastViewed) return parseRelativeSeconds(job.lastViewed);
  return null;
}

function lastViewedSpecificityScore(text) {
  const s = normalizeLastViewedText(text);
  if (!s) return 0;
  if (/\d+\s*seconds?\s*ago/i.test(s)) return 95;
  if (/\d+\s*(minute|min|hour|hr|day|week|month)s?\s*ago/i.test(s)) return 100;
  if (/^less than an hour ago$/i.test(s)) return 85;
  if (/^less than a minute ago$/i.test(s)) return 85;
  if (/^just now$|^a moment ago$/i.test(s)) return 80;
  if (/^today$/i.test(s)) return 40;
  if (/^yesterday$/i.test(s)) return 15;
  if (/\d/.test(s)) return 60;
  return 30;
}

/**
 * Reject when refresh reads a vaguer/older label but the page likely still shows
 * a more specific time (e.g. "17 hours ago" misread as "yesterday").
 */
function isLikelyExtractionRegression(oldRaw, newRaw, oldSeconds, newSeconds) {
  if (!oldRaw || !newRaw) return false;
  if (normalizeLastViewedText(oldRaw) === normalizeLastViewedText(newRaw)) return false;
  if (oldSeconds == null || newSeconds == null) return false;

  const oldSpecific = /\d+\s*(second|sec|minute|min|hour|hr)s?\s*ago/i.test(oldRaw);
  const newVague = /^yesterday$/i.test(normalizeLastViewedText(newRaw));
  if (oldSpecific && newVague && newSeconds > oldSeconds) return true;

  if (newSeconds > oldSeconds + 3600 && lastViewedSpecificityScore(newRaw) < lastViewedSpecificityScore(oldRaw)) {
    return true;
  }
  return false;
}

function parseRelativeMinutes(text) {
  const s = parseRelativeSeconds(text);
  return s == null ? null : Math.floor(s / 60);
}

/** True when the client likely viewed the job (not just the label aging on the page). */
function isMeaningfulLastViewedChange(oldSeconds, newSeconds, notify) {
  if (notify) return true;
  if (oldSeconds == null || newSeconds == null) return false;
  return newSeconds < oldSeconds;
}

function shouldNotifyClientViewed(oldSeconds, newSeconds, oldRaw, newRaw, opts = {}) {
  const oldNorm = normalizeLastViewedText(oldRaw);
  const newNorm = normalizeLastViewedText(newRaw);
  if (!newNorm || newNorm === oldNorm) {
    return { notify: false, reason: 'unchanged' };
  }
  if (!isValidLastViewedDisplay(newRaw)) {
    return { notify: false, reason: 'invalid-new' };
  }
  if (newSeconds == null) {
    return { notify: false, reason: 'unparsed-new' };
  }
  if (oldSeconds == null) {
    if (opts.awaitingFirstView || opts.hadNoBaseline) {
      return { notify: true, reason: 'first-view' };
    }
    return { notify: true, reason: 'first-view' };
  }
  if (newSeconds < oldSeconds) {
    return { notify: true, reason: 'more-recent' };
  }
  return { notify: false, reason: 'not-more-recent' };
}

function pickBestLastViewedCandidate(candidates) {
  let best = { value: '', source: 'none', score: 0 };
  for (const c of candidates) {
    if (!c.value || !isValidLastViewedDisplay(c.value)) continue;
    const spec = lastViewedSpecificityScore(c.value);
    const total = spec + (c.priority || 0);
    if (total > best.score) {
      best = { value: c.value, source: c.source, score: total };
    }
  }
  return best;
}

// Injected into the Upwork tab — must be fully self-contained.
function extractionScript() {
  const LAST_VIEWED_LABEL = /last\s+viewed\s+by\s+client/i;

  function normalizeText(text) {
    return (text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function isElementVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function looksLikeTimeValue(text) {
    if (!text || text.length > 80) return false;
    const s = text.toLowerCase();
    if (LAST_VIEWED_LABEL.test(s)) return false;
    if (/^proposals\b|^interviewing\b|^invites\b|^unanswered\b/i.test(s)) return false;
    return (
      /\b(ago|just now|yesterday|today)\b/i.test(s) ||
      /^\d+\s*(second|sec|min|hour|hr|day|week|month)/i.test(s) ||
      /^less than\s+(a\s+)?(minute|hour)/i.test(s) ||
      /^an?\s+(minute|hour|day|week)/i.test(s)
    );
  }

  function spinWait(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* sync poll — extractionScript cannot use async */
    }
  }

  /** Wait until activity block exists and last-viewed text is stable across two reads. */
  function waitForActivityReady(maxMs) {
    const deadline = Date.now() + maxMs;
    let lastRoot = null;
    let lastBest = null;
    let prevStable = '';

    while (Date.now() < deadline) {
      const root = findActivitySectionRoot();
      if (root) {
        lastRoot = root;
        try {
          root.scrollIntoView({ block: 'center', behavior: 'auto' });
        } catch {
          root.scrollIntoView({ block: 'center' });
        }
        spinWait(150);
        const candidates = findAllLastViewedCandidates(root);
        const best = pickBest(candidates);
        if (best.value && looksLikeTimeValue(best.value)) {
          const norm = best.value.toLowerCase().trim();
          if (norm === prevStable) {
            return { root, best };
          }
          prevStable = norm;
          lastBest = best;
        }
      }
      spinWait(250);
    }
    return { root: lastRoot || findActivitySectionRoot(), best: lastBest };
  }

  function detectCaptchaOrBlocked() {
    const text = (document.body?.innerText || '').slice(0, 20000).toLowerCase();
    const title = (document.title || '').toLowerCase();
    const url = (location.href || '').toLowerCase();

    if (
      document.querySelector(
        'iframe[src*="hcaptcha"], iframe[src*="recaptcha"], #challenge-form, .g-recaptcha, [data-hcaptcha-widget-id], .cf-browser-verification'
      )
    ) {
      return true;
    }

    const phrases = [
      'verify you are human',
      "verify you're human",
      'security check',
      'unusual activity',
      'complete the captcha',
      'checking your browser',
      'access denied',
      'captcha'
    ];

    if (phrases.some((p) => text.includes(p) || title.includes(p))) return true;
    if (url.includes('challenge') || url.includes('captcha')) return true;

    const onUpwork = location.hostname.endsWith('upwork.com');
    const hasJobSignals = /proposals|last viewed by client|interviewing:/i.test(text);
    if (onUpwork && !hasJobSignals && (text.includes('verify') || text.includes('captcha'))) {
      return true;
    }
    return false;
  }

  function findActivitySectionRoot() {
    const testRoots = [
      '[data-test="job-activity"]',
      '[data-test="JobActivity"]',
      '[data-qa="job-activity"]',
      'section[data-test="activity"]'
    ];
    for (const sel of testRoots) {
      const el = document.querySelector(sel);
      if (el && isElementVisible(el) && /last viewed by client/i.test(el.innerText || '')) {
        return el;
      }
    }

    const all = document.querySelectorAll('section, div, aside, article');
    let bestRoot = null;
    let bestSize = Infinity;

    for (const el of all) {
      if (!isElementVisible(el)) continue;
      const text = el.innerText || '';
      if (!/activity on this job/i.test(text)) continue;
      if (!/last viewed by client/i.test(text)) continue;
      if (!/proposals/i.test(text)) continue;
      const len = text.length;
      if (len > 0 && len < bestSize && len < 8000) {
        bestSize = len;
        bestRoot = el;
      }
    }

    if (bestRoot) return bestRoot;

    const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6, span, strong, div');
    for (const h of headings) {
      const t = normalizeText(h.textContent);
      if (!/^activity on this job$/i.test(t)) continue;
      let node = h.parentElement;
      for (let depth = 0; depth < 6 && node; depth++) {
        const text = node.innerText || '';
        if (/last viewed by client/i.test(text) && /proposals/i.test(text)) {
          return node;
        }
        node = node.parentElement;
      }
    }
    return null;
  }

  function extractFromLineBlock(text, priority) {
    const found = [];
    const lines = text.split('\n').map((l) => normalizeText(l)).filter(Boolean);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!LAST_VIEWED_LABEL.test(line)) continue;

      const inline = line.match(/last\s+viewed\s+by\s+client\s*:?\s*(.+)/i);
      if (inline && inline[1]) {
        const val = normalizeText(inline[1]);
        if (looksLikeTimeValue(val)) {
          found.push({ value: val, source: 'activity-inline', priority });
        }
      }

      for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
        const next = lines[j];
        if (LAST_VIEWED_LABEL.test(next)) break;
        if (/^proposals\b|^interviewing\b|^invites\b|^unanswered\b|^activity\b/i.test(next)) break;
        if (looksLikeTimeValue(next)) {
          found.push({ value: next, source: 'activity-next-line', priority: priority + 5 });
          break;
        }
      }
    }
    return found;
  }

  function extractFromActivitySection(activityRoot) {
    if (!activityRoot) return [];
    const text = activityRoot.innerText || '';
    return extractFromLineBlock(text, 200);
  }

  function extractFromLabelElement(el, priority) {
    const found = [];
    const full = normalizeText(el.innerText || el.textContent);

    if (full.length > 500) {
      return extractFromLineBlock(full, priority);
    }

    const inline = full.match(/last\s+viewed\s+by\s+client\s*:?\s*(.+)/i);
    if (inline && inline[1]) {
      const val = normalizeText(inline[1].split(/\n/)[0]);
      if (looksLikeTimeValue(val)) found.push({ value: val, source: 'inline-label', priority });
    }

    const next = el.nextElementSibling;
    if (next) {
      const val = normalizeText(next.innerText || next.textContent);
      if (looksLikeTimeValue(val)) found.push({ value: val, source: 'next-sibling', priority: priority - 10 });
    }

    const parent = el.parentElement;
    if (parent) {
      const lines = (parent.innerText || '').split('\n').map(normalizeText).filter(Boolean);
      let afterLabel = false;
      for (const line of lines) {
        if (LAST_VIEWED_LABEL.test(line)) {
          afterLabel = true;
          const m = line.match(/last\s+viewed\s+by\s+client\s*:?\s*(.+)/i);
          if (m && m[1] && looksLikeTimeValue(m[1])) {
            found.push({ value: normalizeText(m[1]), source: 'parent-inline', priority: priority - 5 });
          }
          continue;
        }
        if (afterLabel) {
          if (/^proposals\b|^interviewing\b|^invites\b/i.test(line)) break;
          if (looksLikeTimeValue(line)) {
            found.push({ value: line, source: 'parent-next-line', priority: priority - 5 });
            break;
          }
        }
      }
    }
    return found;
  }

  function findAllLastViewedCandidates(activityRootIn) {
    const candidates = [];
    const activityRoot = activityRootIn || findActivitySectionRoot();

    if (activityRoot && isElementVisible(activityRoot)) {
      try {
        activityRoot.scrollIntoView({ block: 'center', behavior: 'instant' });
      } catch {
        activityRoot.scrollIntoView({ block: 'center' });
      }
    }

    candidates.push(...extractFromActivitySection(activityRoot));

    const testSelectors = [
      '[data-test="last-viewed"]',
      '[data-test="LastViewed"]',
      '[data-test="client-last-viewed"]',
      '[data-qa="last-viewed"]'
    ];
    for (const sel of testSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        const val = normalizeText(el.innerText || el.textContent);
        if (looksLikeTimeValue(val)) {
          candidates.push({ value: val, source: 'data-test', priority: 180 });
        }
      }
    }

    if (activityRoot) {
      const scoped = activityRoot.querySelectorAll(
        'span, div, p, li, dt, dd, strong, b, label, [data-test], [data-qa]'
      );
      for (const el of scoped) {
        if (!isElementVisible(el)) continue;
        const text = normalizeText(el.innerText || el.textContent);
        if (!text || text.length > 80) continue;
        if (!LAST_VIEWED_LABEL.test(text)) continue;
        candidates.push(...extractFromLabelElement(el, 150));
      }

      // dl/dt/dd and flex rows: value often in sibling after label-only node
      const dts = activityRoot.querySelectorAll('dt, [class*="label"], [class*="Label"]');
      for (const dt of dts) {
        if (!isElementVisible(dt)) continue;
        const labelText = normalizeText(dt.innerText || dt.textContent);
        if (!LAST_VIEWED_LABEL.test(labelText)) continue;
        const dd = dt.nextElementSibling;
        if (dd && isElementVisible(dd)) {
          const val = normalizeText(dd.innerText || dd.textContent);
          if (looksLikeTimeValue(val)) {
            candidates.push({ value: val, source: 'activity-dt-dd', priority: 210 });
          }
        }
      }
    }

    const bodyText = document.body?.innerText || '';
    const activityOnlyText = activityRoot ? activityRoot.innerText : '';
    for (const [text, priority, tag] of [
      [activityOnlyText, 190, 'activity-regex'],
      [bodyText, 50, 'body-regex']
    ]) {
      if (!text) continue;
      const patterns = [
        /Last viewed by client:\s*([^\n]+?)(?=\n|This is when|Interviewing|Invites sent|Unanswered|$)/i,
        /Last viewed by client\s*\n\s*([^\n]+?)(?=\n|Interviewing|Invites sent|Unanswered|$)/i,
        /Last viewed by client[:\s]+(\d+\s+seconds?\s+ago)/i,
        /Last viewed by client[:\s]+(\d+\s+minutes?\s+ago)/i,
        /Last viewed by client[:\s]+(\d+\s+hours?\s+ago)/i,
        /Last viewed by client[:\s]+(\d+\s+days?\s+ago)/i,
        /Last viewed by client[:\s]+(\d+\s+weeks?\s+ago)/i,
        /Last viewed by client[:\s]+(\d+\s+months?\s+ago)/i,
        /Last viewed by client[:\s]+(yesterday|today|just now)/i
      ];
      for (const pattern of patterns) {
        const m = text.match(pattern);
        if (m && m[1]) {
          const val = normalizeText(m[1]);
          if (looksLikeTimeValue(val)) {
            candidates.push({ value: val, source: tag, priority });
          }
        }
      }
    }

    return candidates;
  }

  function specificityScore(text) {
    const s = (text || '').toLowerCase().trim();
    if (!s) return 0;
    if (/\d+\s*seconds?\s*ago/i.test(s)) return 95;
    if (/\d+\s*(minute|min|hour|hr|day|week|month)s?\s*ago/i.test(s)) return 100;
    if (/^less than an hour ago$/i.test(s)) return 85;
    if (/^just now$/i.test(s)) return 80;
    if (/^yesterday$/i.test(s)) return 15;
    if (/^today$/i.test(s)) return 40;
    return 30;
  }

  function pickBest(candidates) {
    let best = { value: '', source: 'none', score: 0 };
    for (const c of candidates) {
      if (!c.value || !looksLikeTimeValue(c.value)) continue;
      const total = specificityScore(c.value) + (c.priority || 0);
      if (total > best.score) {
        best = { value: c.value, source: c.source, score: total };
      }
    }
    return best;
  }

  function findLastViewedByClient(activityRoot) {
    const candidates = findAllLastViewedCandidates(activityRoot);
    const best = pickBest(candidates);
    return { value: best.value, source: best.source, candidates: candidates.length };
  }

  function matchField(bodyText, patterns) {
    for (const pattern of patterns) {
      const m = bodyText.match(pattern);
      if (m && m[1]) return normalizeText(m[1]);
    }
    return '';
  }

  const captchaDetected = detectCaptchaOrBlocked();
  const { root: activityRoot, best: readyBest } = waitForActivityReady(4000);
  const bodyText = document.body?.innerText || '';
  const statsText = activityRoot ? activityRoot.innerText : bodyText;

  const title = normalizeText(
    document.querySelector('h1')?.innerText ||
      document.querySelector('[data-test="job-title"]')?.innerText ||
      document.title.replace(/\s*[-|]\s*Upwork.*$/i, '')
  );

  const proposals = matchField(statsText, [
    /Proposals:\s*([\d,\-–to\s+]+?)(?=\n|Interviewing|Last viewed|Invites sent|Unanswered|$)/i,
    /Proposals:\s*([^\n]+?)(?=\n|Interviewing|Last viewed|Invites sent|Unanswered|$)/i
  ]);

  let lastViewedResult = findLastViewedByClient(activityRoot);
  if (!lastViewedResult.value && readyBest?.value) {
    lastViewedResult = {
      value: readyBest.value,
      source: readyBest.source,
      candidates: lastViewedResult.candidates
    };
  }
  const interviewing = matchField(statsText, [/Interviewing:\s*(\d+)/i]);
  const invitesSent = matchField(statsText, [/Invites sent:\s*(\d+)/i]);
  const unansweredInvites = matchField(statsText, [
    /Unanswered invites:\s*(\d+)/i,
    /Unanswered Invites:\s*(\d+)/i
  ]);

  const pageReady = Boolean(title || proposals || /last viewed by client/i.test(bodyText));
  const hasActivitySection =
    Boolean(activityRoot) || /activity on this job/i.test(bodyText);
  const hasLastViewedLabel = /last viewed by client/i.test(statsText);
  const lastViewedAbsent =
    hasActivitySection && hasLastViewedLabel && !lastViewedResult.value && !captchaDetected;

  return {
    title,
    proposals,
    lastViewed: lastViewedResult.value,
    lastViewedSource: lastViewedResult.source,
    lastViewedCandidates: lastViewedResult.candidates,
    lastViewedAbsent,
    interviewing,
    invitesSent,
    unansweredInvites,
    captchaDetected,
    pageReady
  };
}
