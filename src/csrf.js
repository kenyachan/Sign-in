// CSRF protection: stops another website from making a signed-in visitor's
// browser send requests to our API (e.g. a hidden form that posts to /api/logout).
//
// Three layers:
// 1. The session cookie is SameSite=Lax, so browsers don't attach it to
//    cross-site POSTs at all (see sessions.js).
// 2. Modern browsers send Sec-Fetch-Site on every request. We refuse anything
//    that changes data unless it says "same-origin" (or "none": typed by the user).
// 3. Older browsers send an Origin header instead; it must match our own address.
// Requests with neither header come from tools like curl, not from a browser,
// so they can't carry a victim's cookies and are allowed.

import { appOrigin } from './config.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const fetchSite = req.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return res.status(403).json({ error: 'Request blocked: it came from another site.' });
  }

  const origin = req.get('origin');
  const expected = appOrigin ?? `${req.protocol}://${req.get('host')}`;
  if (origin && origin !== expected) {
    return res.status(403).json({ error: 'Request blocked: it came from another site.' });
  }

  next();
}

// Our API only accepts JSON. HTML forms on other sites can't send JSON
// without the browser asking our permission first, which we never give.
export function requireJson(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const hasBody = Number(req.get('content-length') ?? 0) > 0 || req.get('transfer-encoding');
  if (hasBody && !req.is('application/json')) {
    return res.status(415).json({ error: 'Send JSON (Content-Type: application/json).' });
  }
  next();
}
