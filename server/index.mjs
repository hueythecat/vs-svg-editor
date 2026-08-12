// Production HTTP entrypoint. Serves the `npx expo export --platform web` output:
// static assets from dist/client, then Expo Router's html + API routes from dist/server.
//
// This exists instead of `npx expo serve` for one reason: rate limiting. The API routes
// include two open proxies that spend real money (/api/claude, /api/kimi) and one that
// returns whole SVGs off an enumerable numeric id (/api/review/<id>). Caddy has no
// built-in limit_req, so the throttle has to live here — which is the better place for
// it anyway, since only this layer can tell those routes apart.
//
// Run it via pm2 (see ecosystem.config.example.js), behind Caddy, bound to loopback.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import fs from 'node:fs';

import express from 'express';
import { rateLimit } from 'express-rate-limit';

// expo-server@56.0.5 ships an ESM build whose internal imports are extensionless
// ('./abstract' rather than './abstract.js'), which Node's ESM resolver rejects — a
// plain `import` of this adapter dies at startup with ERR_MODULE_NOT_FOUND. The CJS
// build is intact, so pull it through require. Revert to a normal import if a later
// SDK 56 patch fixes the packaging.
const require = createRequire(import.meta.url);
const { createRequestHandler } = require('expo-server/adapter/express');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_CLIENT = path.join(ROOT, 'dist/client');
const DIST_SERVER = path.join(ROOT, 'dist/server');

const PORT = Number(process.env.PORT ?? 8081);
// Loopback only. Caddy is the only thing that should be able to reach this; binding
// 0.0.0.0 would expose the app on :8081 with no TLS and none of the edge rules.
const HOST = process.env.HOST ?? '127.0.0.1';

// Fail loudly at boot rather than 404ing every request. A missing dist/ means the
// export step was skipped, which is exactly the deploy bug pull-and-restart.sh had.
for (const dir of [DIST_CLIENT, DIST_SERVER]) {
  if (!fs.existsSync(dir)) {
    console.error(`[server] missing ${dir} — run: npx expo export --platform web`);
    process.exit(1);
  }
}

const app = express();

// Caddy sits in front, so the socket peer is always 127.0.0.1 and the real client is in
// X-Forwarded-For. 'loopback' trusts only that hop — a client-supplied X-Forwarded-For
// arriving from anywhere else is ignored, so the rate limiter can't be evaded by
// spoofing the header.
app.set('trust proxy', 'loopback');
app.disable('x-powered-by');

// Health check — before the limiters, so monitoring can never be throttled, and cheap
// enough to poll every few seconds.
app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()) });
});

// --- Rate limits ------------------------------------------------------------------
//
// In-memory counters: correct for a single pm2 process, which is what this runs as. If
// this ever scales to cluster mode or a second host, these need a shared store (Redis)
// or each worker will independently allow the full budget.

const limiterOptions = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { message: 'Too many requests' } },
};

// The AI proxies inject server-side API keys and forward to Anthropic / Moonshot. Every
// call costs money, and a real user triggers at most a handful per minute.
const aiLimiter = rateLimit({
  ...limiterOptions,
  windowMs: 60_000,
  limit: 10,
});

// The review routes hand back complete SVGs. /api/review/<id> takes any digits, so this
// is the throttle standing between a scraper and the whole library. It is a mitigation,
// not a fix — the route still needs authenticating.
const reviewLimiter = rateLimit({
  ...limiterOptions,
  windowMs: 60_000,
  limit: 30,
});

// Backstop for anything else under /api.
const apiLimiter = rateLimit({
  ...limiterOptions,
  windowMs: 60_000,
  limit: 100,
});

app.use('/api/claude', aiLimiter);
app.use('/api/kimi', aiLimiter);
app.use('/api/review', reviewLimiter);
app.use('/api', apiLimiter);

// Dev scaffolding that must never answer in production. Blocked at the edge in the
// Caddyfile too — belt and braces, because this one survives a Caddyfile mistake.
app.all(/^\/api\/download/, (_req, res) => res.status(404).end());

// --- Static assets ----------------------------------------------------------------

// Bundles and assets under /_expo are content-hashed, so they can be cached hard.
app.use(
  '/_expo',
  express.static(path.join(DIST_CLIENT, '_expo'), {
    immutable: true,
    maxAge: '1y',
    index: false,
  }),
);

// Everything else in dist/client. `index: false` so directory requests fall through to
// the Expo handler, which owns document routes — otherwise a stale prerendered
// index.html would shadow the server-rendered one.
app.use(
  express.static(DIST_CLIENT, {
    index: false,
    maxAge: '1h',
    setHeaders(res, filePath) {
      // Artwork is the product. Don't let a shared cache hold copies of it.
      if (filePath.endsWith('.svg')) res.setHeader('cache-control', 'private, max-age=0');
    },
  }),
);

// --- Expo Router (html routes + API routes) ----------------------------------------

app.use(
  createRequestHandler({
    build: DIST_SERVER,
    environment: 'production',
  }),
);

// Last-resort error handler. Log the detail, return none of it — stack traces and
// upstream URLs are not the client's business.
app.use((err, _req, res, _next) => {
  console.error('[server] unhandled error:', err);
  if (res.headersSent) return;
  res.status(500).json({ error: { message: 'Internal server error' } });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`[server] listening on http://${HOST}:${PORT}`);
});

// pm2 reload sends SIGINT, then SIGKILL after a grace period. Stop accepting new
// connections and let in-flight requests finish — an AI pass can take many seconds, and
// killing it mid-flight bills the tokens and returns nothing.
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${signal} — draining`);
    server.close(() => {
      console.log('[server] closed');
      process.exit(0);
    });
    // Don't hang forever on a stuck upstream.
    setTimeout(() => {
      console.warn('[server] drain timed out — forcing exit');
      process.exit(0);
    }, 15_000).unref();
  });
}
