import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.m4a': 'audio/mp4',
  '.webm': 'audio/webm',
};

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

export const sendError = (res, status, message) => sendJson(res, status, { error: message });

export function sendText(res, status, body, mime = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'content-type': mime, 'content-length': Buffer.byteLength(body), ...extra });
  res.end(body);
}

/** Collect a request body, refusing anything over `limit`. */
export function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req) {
  const buf = await readBody(req, 2 * 1024 * 1024);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw new Error('invalid JSON body'); }
}

/** Open a server-sent-events stream and return a writer plus a close hook. */
export function openSse(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': open\n\n');

  let closed = false;
  const send = (data, event) => {
    if (closed) return;
    try {
      if (event) res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch { closed = true; }
  };
  // Proxies and idle browsers drop silent streams; a comment every 15s keeps it alive.
  const ping = setInterval(() => { if (!closed) { try { res.write(': ping\n\n'); } catch { closed = true; } } }, 15000);
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    try { res.end(); } catch {}
  };
  req.on('close', close);
  return { send, close, isClosed: () => closed };
}

/** Serve a file from `root`, refusing anything that escapes it. */
export function serveStatic(res, root, urlPath, req) {
  const rel = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const full = path.resolve(root, rel);
  if (!full.startsWith(path.resolve(root) + path.sep) && full !== path.resolve(root, 'index.html')) {
    return sendError(res, 403, 'forbidden');
  }
  fs.stat(full, (err, stat) => {
    if (err || !stat.isFile()) return sendError(res, 404, 'not found');
    sendFile(res, full, stat, req);
  });
}

/** Send a file, honouring a single Range header so <audio> can seek. */
export function sendFile(res, full, stat, req) {
  const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
  const range = req?.headers?.range;
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());

  if (m) {
    let start = m[1] ? Number(m[1]) : 0;
    let end = m[2] ? Number(m[2]) : stat.size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
      res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
      return res.end();
    }
    end = Math.min(end, stat.size - 1);
    res.writeHead(206, {
      'content-type': type,
      'content-length': end - start + 1,
      'content-range': `bytes ${start}-${end}/${stat.size}`,
      'accept-ranges': 'bytes',
    });
    return fs.createReadStream(full, { start, end }).pipe(res);
  }

  res.writeHead(200, {
    'content-type': type,
    'content-length': stat.size,
    'accept-ranges': 'bytes',
    'cache-control': 'no-cache',
  });
  fs.createReadStream(full).pipe(res);
}
