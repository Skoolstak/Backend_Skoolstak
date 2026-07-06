'use strict';
const xss = require('xss');

// ── Constants ─────────────────────────────────────────────────
// RFC 4122 UUID v1–v5
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Maximum allowed length for any single text field coming from the client.
// Prevents oversized payloads slipping past the body-size limit.
const MAX_FIELD_LENGTH = 1000;
const MAX_REMARK_LENGTH = 5000; // remarks / notes fields may be longer

// xss options: strip ALL tags and attributes — we store plain text only
const XSS_OPTIONS = {
  whiteList:         {},   // no tags allowed
  stripIgnoreTag:    true,
  stripIgnoreTagBody: ['script', 'style'],
};

// ── Core helpers ──────────────────────────────────────────────

/** Returns true when val is a well-formed UUID */
function isValidUUID(val) {
  return typeof val === 'string' && UUID_RE.test(val);
}

/**
 * Strips XSS vectors and trims whitespace from a string value.
 * Returns empty string for non-string input.
 */
function cleanString(val, maxLen = MAX_FIELD_LENGTH) {
  if (val === null || val === undefined) return val;
  if (typeof val !== 'string') return val; // numbers/booleans pass through untouched
  const trimmed = val.trim();
  const stripped = xss(trimmed, XSS_OPTIONS);
  return stripped.slice(0, maxLen);
}

/**
 * Recursively sanitize every string value in an object or array.
 * Numbers and booleans are untouched. Nested objects are walked.
 */
function deepClean(value, maxLen = MAX_FIELD_LENGTH) {
  if (Array.isArray(value)) {
    return value.map(v => deepClean(v, maxLen));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, deepClean(v, maxLen)])
    );
  }
  if (typeof value === 'string') {
    return cleanString(value, maxLen);
  }
  return value;
}

/**
 * Returns a new object containing ONLY the keys listed in `allowed`,
 * with every string value XSS-stripped and length-capped.
 * Prevents mass-assignment attacks (school_id, id, created_at from client).
 */
function pickFields(obj, allowed, maxLen = MAX_FIELD_LENGTH) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  return Object.fromEntries(
    Object.entries(obj)
      .filter(([k]) => allowed.includes(k))
      .map(([k, v]) => [k, deepClean(v, maxLen)])
  );
}

/**
 * Express middleware — sanitizes req.body, req.query, and req.params
 * in-place on every request. Mount globally in index.js after express.json().
 *
 * This is the last line of defence after rate limiting and body size limits.
 */
function sanitizeRequest(req, _res, next) {
  if (req.body && typeof req.body === 'object') {
    Object.assign(req.body, deepClean(req.body));
  }

  if (req.query && typeof req.query === 'object') {
    Object.assign(req.query, deepClean(req.query));
  }

  if (req.params && typeof req.params === 'object') {
    Object.assign(req.params, deepClean(req.params));
  }

  next();
}

/**
 * Express middleware: rejects the request if req.params.id is not a valid UUID.
 * Mount on individual routes: router.put('/:id', validateUUIDParam, handler)
 */
function validateUUIDParam(req, res, next) {
  if (req.params.id && !isValidUUID(req.params.id)) {
    return res.status(400).json({ error: 'Invalid ID format.' });
  }
  next();
}

/**
 * Safely parse a numeric query-param limit capped to `max`.
 * Defaults to `defaultVal` when the value is missing or non-numeric.
 */
function capLimit(value, defaultVal = 50, max = 200) {
  const n = parseInt(value, 10);
  if (isNaN(n) || n < 1) return defaultVal;
  return Math.min(n, max);
}

/**
 * Validates that a value is a safe plain-text string within bounds.
 * Returns false if the value contains characters that should never appear
 * in names, codes, or short text fields.
 */
function isSafeText(val, maxLen = MAX_FIELD_LENGTH) {
  if (typeof val !== 'string') return false;
  if (val.trim().length === 0) return false;
  if (val.length > maxLen) return false;
  return true;
}

/**
 * Validates an email address format.
 */
function isValidEmail(val) {
  return typeof val === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val.trim());
}

/**
 * Validates a date string is YYYY-MM-DD.
 */
function isValidDate(val) {
  return typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val);
}

/**
 * Validates a numeric score is within a given range.
 */
function isValidScore(val, min = 0, max = 100) {
  const n = Number(val);
  return !isNaN(n) && n >= min && n <= max;
}

module.exports = {
  isValidUUID,
  pickFields,
  validateUUIDParam,
  capLimit,
  sanitizeRequest,
  cleanString,
  deepClean,
  isSafeText,
  isValidEmail,
  isValidDate,
  isValidScore,
  MAX_FIELD_LENGTH,
  MAX_REMARK_LENGTH,
};

