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

  // Absolute date: "May 15, 2024" or "15 May 2024"
  const parsed = Date.parse(text);
  if (!Number.isNaN(parsed)) {
    const diffMs = Date.now() - parsed;
    if (diffMs >= 0 && diffMs < 365 * 24 * 60 * 60 * 1000) {
      return Math.floor(diffMs / 60000);
    }
  }

  return null;
}

/**
 * Client viewed more recently when "minutes ago" decreases.
 * Returns { notify, reason }.
 */
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

// Injected into the Upwork tab — must be fully self-contained.
function extractionScript() {
  const LAST_VIEWED_LABEL = /last\s+viewed\s+by\s+client/i;

  function normalizeText(text) {
    return (text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function looksLikeTimeValue(text) {
    if (!text || text.length > 120) return false;
    const s = text.toLowerCase();
    if (LAST_VIEWED_LABEL.test(s)) return false;
    if (/proposals|interviewing|invites|unanswered/i.test(s) && !/\d+\s*(min|hour|hr|day|week|month)/i.test(s)) {
      return false;
    }
    return (
      /\b(ago|just now|yesterday|today)\b/i.test(s) ||
      /\d+\s*(min|hour|hr|day|week|month)/i.test(s) ||
      /less than\s+(a\s+)?(minute|hour)/i.test(s) ||
      /half an hour/i.test(s) ||
      /few\s+(minutes|hours)/i.test(s)
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
      'verify you are a human',
      'security check',
      'unusual activity',
      'complete the captcha',
      'please verify',
      'are you a robot',
      'not a robot',
      'automated access',
      'checking your browser',
      'just a moment...',
      'access denied',
      'challenge-platform',
      'cloudflare',
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

  function extractFromLabelElement(el) {
    const full = normalizeText(el.innerText || el.textContent);
    const inline = full.match(/last\s+viewed\s+by\s+client\s*:?\s*(.+)/i);
    if (inline && inline[1]) {
      const val = normalizeText(inline[1].split(/\n/)[0]);
      if (looksLikeTimeValue(val)) return { value: val, source: 'inline-label' };
    }

    const next = el.nextElementSibling;
    if (next) {
      const val = normalizeText(next.innerText || next.textContent);
      if (looksLikeTimeValue(val)) return { value: val, source: 'next-sibling' };
    }

    const parent = el.parentElement;
    if (parent) {
      const children = Array.from(parent.children);
      const idx = children.indexOf(el);
      for (let i = idx + 1; i < children.length; i++) {
        const val = normalizeText(children[i].innerText || children[i].textContent);
        if (looksLikeTimeValue(val)) return { value: val, source: 'parent-sibling' };
      }
      const parentText = normalizeText(parent.innerText || parent.textContent);
      const parentMatch = parentText.match(/last\s+viewed\s+by\s+client\s*:?\s*([^\n]+)/i);
      if (parentMatch) {
        const val = normalizeText(parentMatch[1]);
        if (looksLikeTimeValue(val)) return { value: val, source: 'parent-inline' };
      }
    }

    return null;
  }

  function findLastViewedByClient() {
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
        if (looksLikeTimeValue(val)) return { value: val, source: 'data-test' };
      }
    }

    const candidates = document.querySelectorAll(
      'span, div, p, li, dt, dd, strong, b, label, h4, h5, [class*="activity"], [class*="stats"], [class*="sidebar"]'
    );
    for (const el of candidates) {
      const text = normalizeText(el.innerText || el.textContent);
      if (!text || text.length > 100) continue;
      if (!LAST_VIEWED_LABEL.test(text)) continue;
      const found = extractFromLabelElement(el);
      if (found) return found;
    }

    const bodyText = document.body?.innerText || '';
    const patterns = [
      /Last viewed by client:\s*([^\n]+?)(?:\s*\n|This is when|Interviewing|Invites sent|Unanswered|$)/i,
      /Last viewed by client\s+([^\n]+?)(?:\s*\n|This is when|Interviewing|Invites sent|Unanswered|$)/i,
      /Last viewed:\s*([^\n]+?)(?:\s*\n|Interviewing|Invites sent|Unanswered|$)/i
    ];
    for (const pattern of patterns) {
      const m = bodyText.match(pattern);
      if (m && m[1]) {
        const val = normalizeText(m[1]);
        if (looksLikeTimeValue(val)) return { value: val, source: 'body-regex' };
      }
    }

    return { value: '', source: 'none' };
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

  const title = normalizeText(
    document.querySelector('h1')?.innerText ||
      document.querySelector('[data-test="job-title"]')?.innerText ||
      document.querySelector('[data-test="JobTitle"]')?.innerText ||
      document.title.replace(/\s*[-|]\s*Upwork.*$/i, '')
  );

  const proposals = matchField(bodyText, [
    /Proposals:\s*([\d,\-–to\s]+?)(?=\n|Interviewing|Last viewed|Invites sent|Unanswered|$)/i
  ]);

  const lastViewedResult = findLastViewedByClient();
  const interviewing = matchField(bodyText, [/Interviewing:\s*(\d+)/i]);
  const invitesSent = matchField(bodyText, [/Invites sent:\s*(\d+)/i]);
  const unansweredInvites = matchField(bodyText, [
    /Unanswered invites:\s*(\d+)/i,
    /Unanswered Invites:\s*(\d+)/i
  ]);

  const pageReady = Boolean(title || proposals || /last viewed by client/i.test(bodyText));

  return {
    title,
    proposals,
    lastViewed: lastViewedResult.value,
    lastViewedSource: lastViewedResult.source,
    interviewing,
    invitesSent,
    unansweredInvites,
    captchaDetected,
    pageReady
  };
}
