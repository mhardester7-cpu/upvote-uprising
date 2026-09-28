// Static file server plus the multiplayer WebSocket endpoint, on one port.
//
// ES modules require http:// (not file://), so the game is served from here
// rather than opened from disk. The same server carries the /ws upgrade for
// co-op, which keeps deployment to a single process on a single port.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompress, gzip, constants as zlibConstants } from 'node:zlib';

import { GameServer } from './server/gameserver.js';
import { PlayCounter } from './server/playcounter.js';
import { sanitizeClientId } from './src/net/protocol.js';
import {
  applySecurityHeaders, compressionMetadata, isInside, PUBLIC_CACHE_CONTROL,
  publicPath, readJsonBody, requestIsFresh, sameHostOrigin,
} from './server/security.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REAL_ROOT = fs.realpathSync(ROOT);
// Managed hosts inject the port to listen on; the local default is for dev.
const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.gltf': 'model/gltf+json',
  '.glb': 'model/gltf-binary',
  '.obj': 'text/plain; charset=utf-8',
  '.mtl': 'text/plain; charset=utf-8',
  '.fbx': 'application/octet-stream',
  '.hdr': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  // Served as octet-stream a browser ignores the manifest outright, which
  // silently costs Add to Home Screen -- the only way to lose Safari's chrome
  // on an iPhone.
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.obj', '.mtl']);
/** Compressed source is tiny enough to retain for the lifetime of one deploy. */
const compressed = new Map();

const game = new GameServer();
const playCounter = new PlayCounter();

const server = http.createServer((req, res) => {
  applySecurityHeaders(res);
  handleRequest(req, res).catch((err) => {
    console.error('  request failed:', err?.message ?? err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    if (!res.writableEnded) res.end('Internal server error');
  });
});

async function handleRequest(req, res) {
  const rawTarget = req.url;
  let url;
  try {
    url = decodeURIComponent(String(rawTarget || '').split(/[?#]/, 1)[0]);
  } catch {
    sendText(res, 400, 'Bad request');
    return;
  }

  if (!url.startsWith('/') || /[\x00-\x1f\x7f]/.test(url)) {
    sendText(res, 400, 'Bad request');
    return;
  }

  // Health check, so a platform can tell a live process from a wedged one.
  if (url === '/healthz') {
    if (!allow(req, res, ['GET', 'HEAD'])) return;
    sendJson(req, res, 200, { ok: true, rooms: game.rooms.size, uptime: process.uptime() });
    return;
  }

  // Lobby browser: which rooms currently have players in them.
  if (url === '/api/rooms') {
    if (!allow(req, res, ['GET', 'HEAD'])) return;
    sendJson(req, res, 200, { rooms: game.listRooms() });
    return;
  }

  // How many people are playing right now. Public, because the menu shows the
  // number to every player -- see the counter in index.html.
  if (url === '/api/live') {
    if (!allow(req, res, ['GET', 'HEAD'])) return;
    sendLive(req, res);
    return;
  }

  // A solo client checking in. Solo play never opens a socket, so this is the
  // only evidence the server gets that those players exist at all.
  if (url === '/api/beat') {
    await handleBeat(req, res);
    return;
  }

  // One durable increment when a player actually enters a run. The random run
  // id makes retries idempotent; it contains no player or browser identity.
  if (url === '/api/play') {
    await handlePlay(req, res);
    return;
  }

  // The dashboard. Served by an explicit route rather than as a static file so
  // the URL is /live and stays that way.
  if (url === '/live') {
    if (!allow(req, res, ['GET', 'HEAD'])) return;
    await serveFile(req, res, path.join(ROOT, 'server', 'live.html'), 'server/live.html', 'no-store');
    return;
  }

  // Browsers ask for this unprompted; answering with an empty 204 keeps a
  // harmless request out of the error log.
  if (url === '/favicon.ico') {
    if (!allow(req, res, ['GET', 'HEAD'])) return;
    res.writeHead(204).end();
    return;
  }

  if (!allow(req, res, ['GET', 'HEAD'])) return;
  const rel = publicPath(rawTarget);
  if (!rel) {
    sendText(res, 404, 'Not found');
    return;
  }

  const filePath = path.resolve(ROOT, rel);
  if (!isInside(ROOT, filePath)) {
    sendText(res, 404, 'Not found');
    return;
  }
  await serveFile(req, res, filePath, rel, PUBLIC_CACHE_CONTROL);
}

/** The live headcount, as JSON. */
function sendLive(req, res) {
  sendJson(req, res, 200, { ...game.live(), plays: playCounter.total });
}

/** Record a gameplay start in durable storage. */
async function handlePlay(req, res) {
  if (!allow(req, res, ['POST'])) return;
  if (!sameHostOrigin(req)) {
    sendText(res, 403, 'Origin refused');
    return;
  }

  let msg;
  try {
    msg = await readJsonBody(req, 1024);
  } catch (err) {
    sendText(res, err?.status === 413 ? 413 : 400,
      err?.status === 413 ? 'Too large' : 'Bad body');
    return;
  }

  try {
    const plays = await playCounter.record(msg?.runId);
    sendJson(req, res, 200, { plays });
  } catch (err) {
    const status = err?.status === 400 ? 400 : 503;
    if (status === 503) console.warn('  play counter unavailable:', err?.message ?? err);
    sendText(res, status, status === 400 ? 'Bad run id' : 'Play counter unavailable');
  }
}

/**
 * Take one heartbeat.
 *
 * Answers with the fresh count, so the client's menu counter costs one request
 * rather than a beat followed by a poll. `gone` is the goodbye a client sends
 * when it closes or joins a room, which drops it from the number immediately
 * instead of leaving a ghost for the rest of the TTL.
 *
 * The body is capped hard: this endpoint is public and unauthenticated, and an
 * unbounded read on such a thing is a way to be handed a gigabyte.
 */
async function handleBeat(req, res) {
  if (!allow(req, res, ['POST'])) return;
  if (!sameHostOrigin(req)) {
    sendText(res, 403, 'Origin refused');
    return;
  }

  let msg;
  try {
    msg = await readJsonBody(req, 1024);
  } catch (err) {
    sendText(res, err?.status === 413 ? 413 : 400,
      err?.status === 413 ? 'Too large' : 'Bad body');
    return;
  }

  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    sendText(res, 400, 'Bad body');
    return;
  }

  // The same sanitiser guards the join path. That is not tidiness: if the two
  // disagreed about which ids are acceptable, a client could be counted under
  // one id while beating under another, and the de-duplication between solo
  // and co-op -- the whole reason the id is sent -- would quietly stop working.
  const cid = sanitizeClientId(msg.id);
  if (!cid) {
    sendText(res, 400, 'Bad client id');
    return;
  }

  // sendBeacon fires during page teardown and nobody reads the reply, so a
  // goodbye is acknowledged with 204 and nothing else.
  if (msg.gone) {
    game.presence.forget(cid);
    res.writeHead(204).end();
    return;
  }

  game.presence.beat(cid);
  sendLive(req, res);
}

function sendJson(req, res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : data);
}

function sendText(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(message);
}

function allow(req, res, methods) {
  if (methods.includes(req.method)) return true;
  res.writeHead(405, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    Allow: methods.join(', '),
  });
  res.end('Method not allowed');
  return false;
}

/** Serve one verified regular file with validators and text compression. */
async function serveFile(req, res, requestedPath, rel, cacheControl) {
  let realPath;
  let stat;
  try {
    realPath = await fs.promises.realpath(requestedPath);
    if (!isInside(REAL_ROOT, realPath)) throw new Error('outside public root');
    stat = await fs.promises.stat(realPath);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    sendText(res, 404, 'Not found');
    return;
  }

  const ext = path.extname(realPath).toLowerCase();
  const etag = `W/"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
  const compression = compressionMetadata(
    stat.size >= 1024 && COMPRESSIBLE.has(ext),
    req.headers['accept-encoding'],
  );
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': cacheControl,
    ETag: etag,
    'Last-Modified': stat.mtime.toUTCString(),
    ...(compression.vary ? { Vary: compression.vary } : {}),
    ...(compression.encoding ? { 'Content-Encoding': compression.encoding } : {}),
  };

  if (requestIsFresh(req, etag, stat.mtimeMs)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  if (req.method === 'HEAD' && !compression.encoding) {
    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    res.end();
    return;
  }

  const raw = await fs.promises.readFile(realPath);
  if (!compression.encoding) {
    res.writeHead(200, { ...headers, 'Content-Length': raw.length });
    res.end(raw);
    return;
  }

  const key = `${rel}:${etag}:${compression.encoding}`;
  let pending = compressed.get(key);
  if (!pending) {
    pending = compress(raw, compression.encoding);
    compressed.set(key, pending);
  }
  const body = await pending;
  res.writeHead(200, {
    ...headers,
    'Content-Length': body.length,
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function compress(raw, encoding) {
  return new Promise((resolve, reject) => {
    const done = (err, out) => (err ? reject(err) : resolve(out));
    if (encoding === 'br') {
      brotliCompress(raw, {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 },
      }, done);
    } else {
      gzip(raw, { level: 6 }, done);
    }
  });
}

game.attach(server);

// Startup never waits on an analytics dependency. The first successful play
// still hydrates the total if Supabase is waking up during a cold deploy.
playCounter.init().then((total) => {
  if (total != null) console.log(`  play counter ready (${total.toLocaleString()} total)`);
}).catch((err) => {
  console.warn('  play counter initial load failed:', err?.message ?? err);
});
if (!playCounter.writeConfigured) {
  console.warn('  play counter writes disabled: SUPABASE_SECRET_KEY is not configured');
}

// Keep slow or malicious clients from holding resources indefinitely.
server.headersTimeout = 10_000;
server.requestTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 1_000;
server.on('clientError', (_err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});

server.listen(PORT, HOST, () => {
  console.log(`\n  UPVOTE UPRISING listening on http://${HOST}:${PORT}  (ws on /ws)\n`);
});

// Managed platforms stop a container with SIGTERM and expect it to go quietly.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`\n  ${sig} -- shutting down`);
    game.close();
    server.close(() => process.exit(0));
    // Do not let a lingering keep-alive socket hold the shutdown open forever.
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
