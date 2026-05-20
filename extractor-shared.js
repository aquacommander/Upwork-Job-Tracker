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

function normalizeLastViewedText(text) {
  return (text || '')
    .toLowerCase()
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[.]+$/g, '')
    .trim();
}

/** True if the string looks like Upwork's relative "last viewed" display. */
function isValidLastViewedDisplay(text) {
  const s = normalizeLastViewedText(text);
  if (!s || s.length > 120) return false;

  if (parseRelativeMinutes(s) !== null) return true;

  const validPhrases = [
    /^just now$/,
    /^yesterday$/,
    /^today$/,
    /^a moment ago$/,
    /^moments ago$/,
    /^less than a minute ago$/,
    /^less than an hour ago$/
  ];
  return validPhrases.some((re) => re.test(s));
}

function lastViewedSpecificityScore(text) {
  const s = normalizeLastViewedText(text);
  if (!s) return 0;
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
function isLikelyExtractionRegression(oldRaw, newRaw, oldMinutes, newMinutes) {
  if (!oldRaw || !newRaw) return false;
  if (normalizeLastViewedText(oldRaw) === normalizeLastViewedText(newRaw)) return false;
  if (oldMinutes == null || newMinutes == null) return false;

  const oldSpecific = /\d+\s*(minute|min|hour|hr)s?\s*ago/i.test(oldRaw);
  const newVague = /^yesterday$/i.test(normalizeLastViewedText(newRaw));
  if (oldSpecific && newVague && newMinutes > oldMinutes) return true;

  if (newMinutes > oldMinutes + 60 && lastViewedSpecificityScore(newRaw) < lastViewedSpecificityScore(oldRaw)) {
    return true;
  }
  return false;
}

function parseRelativeMinutes(text) {
  if (!text) return null;
  const str = normalizeLastViewedText(text);

  if (str === 'just now' || str === 'a moment ago' || str === 'moments ago') return 0;
  if (str === 'less than a minute ago') return 0;
  if (str === 'less than an hour ago') return 30;
  if (str === 'yesterday') return 1440;
  if (str === 'today') return 0;

  if (str.includes('half an hour')) return 30;
  if (str.includes('few hours')) return 180;
  if (str.includes('few minutes')) return 3;
  if (str.includes('couple of hours')) return 120;
  if (str.includes('couple of days')) return 2880;

  const match = str.match(/^(\d+)\s*(min(?:ute)?s?|hours?|hrs?|days?|weeks?|months?)\s*(ago)?/i);
  if (match) {
    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    if (unit.startsWith('min')) return value;
    if (unit.startsWith('hour') || unit.startsWith('hr')) return value * 60;
    if (unit.startsWith('day')) return value * 1440;
    if (unit.startsWith('week')) return value * 10080;
    if (unit.startsWith('month')) return value * 43200;
  }

  const singleMatch = str.match(/^an?\s+(min(?:ute)?|hour|hr|day|week|month)\s*(ago)?/i);
  if (singleMatch) {
    const unit = singleMatch[1].toLowerCase();
    if (unit.startsWith('min')) return 1;
    if (unit.startsWith('hour') || unit.startsWith('hr')) return 60;
    if (unit.startsWith('day')) return 1440;
    if (unit.startsWith('week')) return 10080;
    if (unit.startsWith('month')) return 43200;
  }

  const parsed = Date.parse(text);
  if (!Number.isNaN(parsed)) {
    const diffMs = Date.now() - parsed;
    if (diffMs >= 0 && diffMs < 365 * 24 * 60 * 60 * 1000) {
      return Math.floor(diffMs / 60000);
    }
  }

  return null;
}

function shouldNotifyClientViewed(oldMinutes, newMinutes, oldRaw, newRaw) {
  const oldNorm = normalizeLastViewedText(oldRaw);
  const newNorm = normalizeLastViewedText(newRaw);
  if (!newNorm || newNorm === oldNorm) {
    return { notify: false, reason: 'unchanged' };
  }
  if (!isValidLastViewedDisplay(newRaw)) {
    return { notify: false, reason: 'invalid-new' };
  }
  if (newMinutes == null) {
    return { notify: false, reason: 'unparsed-new' };
  }
  if (oldMinutes == null) {
    return { notify: false, reason: 'no-baseline' };
  }
  if (newMinutes < oldMinutes) {
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

  function looksLikeTimeValue(text) {
    if (!text || text.length > 80) return false;
    const s = text.toLowerCase();
    if (LAST_VIEWED_LABEL.test(s)) return false;
    if (/^proposals\b|^interviewing\b|^invites\b|^unanswered\b/i.test(s)) return false;
    return (
      /\b(ago|just now|yesterday|today)\b/i.test(s) ||
      /^\d+\s*(min|hour|hr|day|week|month)/i.test(s) ||
      /^less than\s+(a\s+)?(minute|hour)/i.test(s) ||
      /^an?\s+(minute|hour|day|week)/i.test(s)
    );
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
    const all = document.querySelectorAll('section, div, aside, article');
    let bestRoot = null;
    let bestSize = Infinity;

    for (const el of all) {
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

  function findAllLastViewedCandidates() {
    const candidates = [];
    const activityRoot = findActivitySectionRoot();

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
      const scoped = activityRoot.querySelectorAll('span, div, p, li, dt, dd, strong, b, label');
      for (const el of scoped) {
        const text = normalizeText(el.innerText || el.textContent);
        if (!text || text.length > 80) continue;
        if (!LAST_VIEWED_LABEL.test(text)) continue;
        candidates.push(...extractFromLabelElement(el, 150));
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
        /Last viewed by client\s*\n\s*([^\n]+?)(?=\n|Interviewing|Invites sent|Unanswered|$)/i
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

  function findLastViewedByClient() {
    const candidates = findAllLastViewedCandidates();
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
  const bodyText = document.body?.innerText || '';
  const activityRoot = findActivitySectionRoot();
  const statsText = activityRoot ? activityRoot.innerText : bodyText;

  const title = normalizeText(
    document.querySelector('h1')?.innerText ||
      document.querySelector('[data-test="job-title"]')?.innerText ||
      document.title.replace(/\s*[-|]\s*Upwork.*$/i, '')
  );

  const proposals = matchField(statsText, [
    /Proposals:\s*([\d,\-–to\s]+?)(?=\n|Interviewing|Last viewed|Invites sent|Unanswered|$)/i
  ]);

  const lastViewedResult = findLastViewedByClient();
  const interviewing = matchField(statsText, [/Interviewing:\s*(\d+)/i]);
  const invitesSent = matchField(statsText, [/Invites sent:\s*(\d+)/i]);
  const unansweredInvites = matchField(statsText, [
    /Unanswered invites:\s*(\d+)/i,
    /Unanswered Invites:\s*(\d+)/i
  ]);

  const pageReady = Boolean(title || proposals || /last viewed by client/i.test(bodyText));

  return {
    title,
    proposals,
    lastViewed: lastViewedResult.value,
    lastViewedSource: lastViewedResult.source,
    lastViewedCandidates: lastViewedResult.candidates,
    interviewing,
    invitesSent,
    unansweredInvites,
    captchaDetected,
    pageReady
  };
}
