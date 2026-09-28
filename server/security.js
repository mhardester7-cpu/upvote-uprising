// Security policy shared by the HTTP and WebSocket boundaries.
//
// Keep this module free of server state so the rules can be tested without
// opening a port. The game intentionally serves source modules directly, but
// that does not mean every file in the repository belongs on the public web.

const PUBLIC_FILES = new Set([
  'icon.svg',
  'index.html',
  'manifest.webmanifest',
  'privacy.html',
  'terms.html',
]);

const PUBLIC_DIRS = new Set(['assets', 'src', 'vendor']);

// Public files use stable, human-readable names rather than content hashes.
// Revalidate them on an ordinary reload so a deploy cannot leave a browser on
// yesterday's GLB or JavaScript; serveFile's ETag keeps unchanged responses at
// a cheap 304 instead of retransmitting the file.
export const PUBLIC_CACHE_CONTROL = 'no-cache';

/**
 * Turn a request target into a repository-relative public asset path.
 *
 * Returns null for malformed escapes, dotfiles, backslashes, control
 * characters, traversal, and repository-only paths such as .git or server/.
 */
export function publicPath(requestTarget) {
  if (typeof requestTarget !== 'string') return null;

  let pathname;
  try {
    pathname = decodeURIComponent(requestTarget.split(/[?#]/, 1)[0]);
  } catch {
    return null;
  }

  if (!pathname.startsWith('/') || pathname.includes('\\')) return null;
  if (/[\x00-\x1f\x7f]/.test(pathname)) return null;
  if (pathname === '/') return 'index.html';

  const parts = pathname.slice(1).split('/');
  if (!parts.length || parts.some((part) => !part || part === '..' || part.startsWith('.'))) {
    return null;
  }

  const rel = parts.join('/');
  if (PUBLIC_FILES.has(rel)) return rel;
  return PUBLIC_DIRS.has(parts[0]) ? rel : null;
}

/** A resolved path is inside root, not merely sharing its string prefix. */
export function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(root + '/');
}

/**
 * Pick a text encoding the client actually accepts.
 *
 * A substring check is not enough here: `gzip;q=0` explicitly forbids gzip,
 * and quality weights let a client prefer gzip over Brotli. Sending a refused
 * encoding produces a response some intermediaries and HTTP clients cannot
 * decode at all.
 */
export function acceptedEncoding(raw = '') {
  const quality = new Map();
  let wildcard = null;

  for (const entry of String(raw).toLowerCase().split(',')) {
    const [rawName, ...params] = entry.split(';');
    const name = rawName.trim();
    if (!name) continue;

    let q = 1;
    const qualityParam = params.find((param) => /^\s*q\s*=/.test(param));
    if (qualityParam) {
      const value = Number(qualityParam.split('=', 2)[1]?.trim());
      q = Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0;
    }

    if (name === '*') wildcard = q;
    else if (name === 'br' || name === 'gzip') quality.set(name, q);
  }

  const br = quality.has('br') ? quality.get('br') : (wildcard ?? 0);
  const gzip = quality.has('gzip') ? quality.get('gzip') : (wildcard ?? 0);
  if (br <= 0 && gzip <= 0) return null;
  return br >= gzip ? 'br' : 'gzip';
}

/** Metadata shared by every variant of a potentially compressed response. */
export function compressionMetadata(enabled, acceptEncoding = '') {
  return enabled
    ? { encoding: acceptedEncoding(acceptEncoding), vary: 'Accept-Encoding' }
    : { encoding: null, vary: null };
}

/** HTTP conditional-request freshness, with If-None-Match taking precedence. */
export function requestIsFresh(req, etag, mtimeMs) {
  const noneMatch = req?.headers?.['if-none-match'];
  if (noneMatch !== undefined) {
    const weak = (value) => String(value).trim().replace(/^W\//i, '');
    return String(noneMatch).split(',').some((candidate) => (
      candidate.trim() === '*' || weak(candidate) === weak(etag)
    ));
  }

  const since = Date.parse(req?.headers?.['if-modified-since'] || '');
  return Number.isFinite(since) && Math.floor(mtimeMs / 1000) <= Math.floor(since / 1000);
}

/** Read a JSON request with a byte ceiling, not a JavaScript-character ceiling. */
export async function readJsonBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += bytes.length;
    if (size > maxBytes) {
      const err = new Error('Too large');
      err.status = 413;
      throw err;
    }
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

/**
 * Browser WebSockets must come from the host serving the page.
 *
 * Non-browser clients generally omit Origin and remain usable for tests and
 * native tooling. A browser cannot forge this header, which is the property
 * needed to prevent another website from quietly opening sockets to the game.
 */
export function sameHostOrigin(req) {
  const raw = req?.headers?.origin;
  if (!raw) return true;

  try {
    const origin = new URL(raw);
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return false;

    const forwarded = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
    const expected = (forwarded || String(req.headers.host || '')).toLowerCase();
    return !!expected && origin.host.toLowerCase() === expected;
  } catch {
    return false;
  }
}

/** Install headers that should be present on every response, errors included. */
export function applySecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self'",
    "font-src 'self' data:",
    // GLTFLoader's ImageBitmap path fetches embedded GLB textures through a
    // temporary blob URL. `img-src blob:` only covers HTML image decoding;
    // the fetch itself is governed by connect-src.
    "connect-src 'self' blob: https://*.supabase.co ws: wss:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "form-action 'self'",
  ].join('; '));
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), fullscreen=(self)');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
}
