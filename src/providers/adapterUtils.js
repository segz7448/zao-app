/**
 * ZAO - Shared provider adapter utilities
 *
 * Every provider call MUST go through withTimeout + classifyError.
 * This is what makes "the app never hangs or crashes" actually true,
 * rather than just a hope.
 */

export const ERROR_TYPES = {
  RATE_LIMIT: 'RATE_LIMIT',           // should trigger fallback
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',   // should trigger fallback
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE', // should trigger fallback
  SERVER_ERROR: 'SERVER_ERROR',       // retry once, then fallback
  TIMEOUT: 'TIMEOUT',                 // retry once, then fallback
  BAD_REQUEST: 'BAD_REQUEST',         // do NOT fallback blindly, payload issue
  AUTH_ERROR: 'AUTH_ERROR',           // do NOT fallback, key issue - surface to user
  NETWORK_ERROR: 'NETWORK_ERROR',     // no connectivity at all
  UNKNOWN: 'UNKNOWN',
};

// Error types where retrying the SAME model on a different provider account,
// or moving to the next model in the chain, is actually likely to help.
export const FALLBACK_WORTHY = new Set([
  ERROR_TYPES.RATE_LIMIT,
  ERROR_TYPES.QUOTA_EXCEEDED,
  ERROR_TYPES.MODEL_UNAVAILABLE,
  ERROR_TYPES.SERVER_ERROR,
  ERROR_TYPES.TIMEOUT,
]);

/**
 * Wraps a promise with a hard timeout so a hung network call can never
 * freeze the app. Always resolves to a result object, never throws.
 */
export async function withTimeout(promiseFactory, timeoutMs = 30000) {
  let timeoutHandle;
  try {
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error('TIMEOUT')), timeoutMs);
    });
    const result = await Promise.race([promiseFactory(), timeoutPromise]);
    clearTimeout(timeoutHandle);
    return { success: true, data: result, error: null };
  } catch (err) {
    clearTimeout(timeoutHandle);
    if (err?.message === 'TIMEOUT') {
      return { success: false, data: null, error: { type: ERROR_TYPES.TIMEOUT, message: 'Request timed out', raw: err } };
    }
    return { success: false, data: null, error: classifyError(err) };
  }
}

/**
 * Classify a caught error/response into a stable type so the orchestrator
 * can decide: fallback, retry, or surface to user.
 */
export function classifyError(err) {
  // Network completely unreachable (no internet, DNS failure, etc.)
  if (err?.message === 'Network request failed' || err?.name === 'TypeError') {
    return { type: ERROR_TYPES.NETWORK_ERROR, message: 'No network connection', raw: err };
  }

  const status = err?.status || err?.response?.status;

  if (status === 429) {
    return { type: ERROR_TYPES.RATE_LIMIT, message: 'Rate limit reached', raw: err, status };
  }
  if (status === 402) {
    return { type: ERROR_TYPES.QUOTA_EXCEEDED, message: 'Quota exceeded', raw: err, status };
  }
  if (status === 503 || status === 502 || status === 504) {
    return { type: ERROR_TYPES.MODEL_UNAVAILABLE, message: 'Model temporarily unavailable', raw: err, status };
  }
  if (status === 400) {
    return { type: ERROR_TYPES.BAD_REQUEST, message: 'Invalid request', raw: err, status };
  }
  if (status === 401 || status === 403) {
    return { type: ERROR_TYPES.AUTH_ERROR, message: 'Authentication failed - check API key', raw: err, status };
  }
  if (status >= 500) {
    return { type: ERROR_TYPES.SERVER_ERROR, message: 'Server error', raw: err, status };
  }

  return { type: ERROR_TYPES.UNKNOWN, message: err?.message || 'Unknown error', raw: err, status };
}

/**
 * Safe fetch wrapper - never throws, always returns a result object.
 * Use this instead of raw fetch() everywhere in provider adapters.
 */
export async function safeFetch(url, options = {}, timeoutMs = 30000) {
  return withTimeout(async () => {
    const response = await fetch(url, options);
    if (!response.ok) {
      let bodyText = '';
      try {
        bodyText = await response.text();
      } catch (_) {
        // ignore body read failure
      }
      const err = new Error(`HTTP ${response.status}: ${bodyText || response.statusText}`);
      err.status = response.status;
      throw err;
    }
    return response.json();
  }, timeoutMs);
}
