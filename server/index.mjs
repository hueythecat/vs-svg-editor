// Production HTTP entrypoint. Serves the `npx expo export --platform web` output:
// static assets from dist/client, then Expo Router's html + API routes from dist/server.
//
// This exists instead of `npx expo serve` because several things have to happen in front
// of the routes, and only this layer can tell the routes apart:
//
//   • rate limiting — two proxies spend real money (/api/claude, /api/kimi) and one
//     returns whole SVGs off an enumerable numeric id (/api/review/<id>). Caddy has no
//     built-in limit_req.
//   • a global daily AI budget and an in-flight cap, which bound spend across all
//     clients rather than per client — see the aiBudget block below for why per-IP
//     limiting alone is the wrong shape for an open paid endpoint.
//   • a body size ceiling that does not depend on Caddy being correctly configured.
//   • 404ing the dev-only routes, which ship in every export because Expo Router exports
//     every +api.ts regardless of the build's UI flags.
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

// Whether the routes that only ever backed the dev rail are allowed to answer. Off
// unless explicitly turned on, because the failure mode of the two settings is not
// symmetric:
//
//   /api/review/list returns every asset the review host knows about, each with its
//   edit_uuid. That uuid IS the capability for the /<uuid> deep link — it is the whole
//   reason check/[uuid] and review/[id] can be unauthenticated. Serving the list to
//   anyone hands out the keys to the entire library in one request, and no amount of
//   throttling the routes it unlocks makes up for that.
//
//   /api/review/test/<id> makes the upstream create a review entry for an arbitrary art
//   id. /api/download unzips out of assets/downloads.
//
// Only an explicit on value opens them, so a typo or a half-finished edit leaves a
// production deployment closed — the opposite default to EXPO_PUBLIC_DEV_AUTH, which
// fails closed by staying armed. Both fail towards "less is exposed".
//
// A deployment that genuinely wants the dev rail (see DEPLOY.md) sets this AND removes
// the matching block from the Caddyfile. Two deliberate acts, neither sufficient alone.
const DEV_API_ROUTES = ['1', 'on', 'true'].includes(
  String(process.env.DEV_API_ROUTES ?? '').toLowerCase(),
);

// Largest request body any route legitimately takes. /api/claude carries a base64 PNG of
// the canvas, so a few MB is normal; src/lib/ai-guard.ts caps the image itself at 8MB.
// Caddy enforces the same bound at the edge, but Caddy is not the only way in — a
// misconfigured Caddyfile, or a future deployment that fronts this differently, would
// leave the app unbounded. One place that is always in the path.
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? 10 * 1024 * 1024);

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

// --- Body size --------------------------------------------------------------------
//
// Enforced from Content-Length rather than by counting bytes off the stream, and that is
// a real constraint rather than a shortcut: the Expo adapter downstream turns `req` into
// a web Request and reads the body itself, so anything here that attached a 'data'
// listener would switch the stream to flowing mode and consume the bytes the handler
// needs. There is no non-destructive way to meter it in the middle.
//
// Which leaves the header — and a body sent with `Transfer-Encoding: chunked` has none.
// Rather than let that case through unbounded, it is refused with 411. Nothing in this
// app sends one: `fetch` with a string body always sets Content-Length, and Caddy
// preserves it. A chunked body reaching here is a client this app didn't write, which is
// exactly the traffic the limit is for. The failure is loud and says why, so if some
// future caller does stream a body, it surfaces as a clear 411 rather than a truncation.
const bodyLimit = (maxBytes) => (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE') return next();

  const length = req.headers['content-length'];

  if (length === undefined) {
    // No body at all is fine — a POST with nothing in it (e.g. /api/review/check).
    if (!req.headers['transfer-encoding']) return next();
    return res.status(411).json({ error: { message: 'Content-Length required' } });
  }

  const bytes = Number(length);
  if (!Number.isFinite(bytes) || bytes < 0) {
    return res.status(400).json({ error: { message: 'Malformed Content-Length' } });
  }
  if (bytes > maxBytes) {
    return res.status(413).json({ error: { message: 'Request body too large' } });
  }
  return next();
};

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

// --- Global AI budget --------------------------------------------------------------
//
// The per-IP limiter above bounds what one client can spend. It does nothing about a
// hundred clients, which is the shape abuse of an open paid proxy actually takes — the
// endpoint is worth automating precisely because it costs the caller nothing, and IPs are
// the cheapest thing to acquire. Nothing in the per-IP design notices that.
//
// So: one counter for the whole process, over a rolling 24h window, with no key. When it
// trips every AI call is refused until the window rolls, and the log says so. That is a
// deliberate outage rather than a surprise invoice — an editor whose Customise button
// says "try again later" is recoverable; a drained API account at 3am is not.
//
// Sized from real use: a working session runs a handful of passes, so the default leaves
// ordinary use nowhere near it while capping the day's exposure at a knowable number.
// Raise AI_DAILY_LIMIT once there is traffic to size it against.
const AI_DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT ?? 500);

const aiBudget = rateLimit({
  ...limiterOptions,
  windowMs: 24 * 60 * 60 * 1000,
  limit: AI_DAILY_LIMIT,
  // One bucket for everyone. `validate` off because express-rate-limit rightly warns
  // about a constant key — here it is the entire point, not a misconfiguration.
  keyGenerator: () => 'global',
  validate: false,
  message: { error: { message: 'The daily AI budget for this deployment is spent' } },
  handler: (_req, res, _next, options) => {
    console.error(`[server] AI daily budget of ${AI_DAILY_LIMIT} spent — refusing until the window rolls`);
    res.status(options.statusCode).json(options.message);
  },
});

// Each AI pass holds a socket open for tens of seconds while the model thinks. Enough of
// them at once and the process is out of memory and file descriptors long before either
// counter above notices — the limiters count requests over a window, not requests still
// running. This counts the ones still running.
const AI_MAX_CONCURRENT = Number(process.env.AI_MAX_CONCURRENT ?? 12);
let aiInFlight = 0;

const aiConcurrency = (_req, res, next) => {
  if (aiInFlight >= AI_MAX_CONCURRENT) {
    console.warn(`[server] ${aiInFlight} AI requests in flight — shedding`);
    res.set('retry-after', '30');
    return res.status(503).json({ error: { message: 'Too many passes running — try again shortly' } });
  }
  aiInFlight++;
  // 'close' rather than 'finish': a client that hangs up mid-pass must release its slot
  // too, or an abandoned tab permanently costs one.
  res.on('close', () => { aiInFlight--; });
  next();
};

// --- Route gating ------------------------------------------------------------------
//
// Order matters: the 404s come first, so a blocked route costs nothing and never
// consumes a limiter's budget. A scraper hammering /api/review/list must not be able to
// exhaust the review limiter for real users.

// Dev scaffolding. Blocked at the edge in the Caddyfile too — belt and braces, because
// this layer survives a Caddyfile mistake and the Caddyfile survives an env one.
if (!DEV_API_ROUTES) {
  for (const pattern of [/^\/api\/download/, /^\/api\/review\/list/, /^\/api\/review\/test/]) {
    app.all(pattern, (_req, res) => res.status(404).end());
  }
} else {
  console.warn('[server] DEV_API_ROUTES is on — /api/review/list, /api/review/test and /api/download will answer');
}

app.use('/api', bodyLimit(MAX_BODY_BYTES));
app.use('/api/claude', aiLimiter, aiBudget, aiConcurrency);
app.use('/api/kimi', aiLimiter, aiBudget, aiConcurrency);
app.use('/api/review', reviewLimiter);
app.use('/api', apiLimiter);

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
