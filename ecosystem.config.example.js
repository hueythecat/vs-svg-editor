// pm2 config template. Copy to `ecosystem.config.js` on the server — the real file is
// gitignored so each host keeps its own, and so a stray edit can't be committed.
//
//   cp ecosystem.config.example.js ecosystem.config.js
//
// This runs the PRODUCTION EXPORT, not the Metro dev server. `npx expo export
// --platform web` must have produced dist/ before pm2 starts (see DEPLOY.md); the
// server does not bundle on the fly, and server/index.mjs exits at boot with a clear
// message if dist/ is missing rather than 404ing every request.

const fs = require('node:fs');
const path = require('node:path');

// pm2 does not read .env, and the API routes in src/app/api/**/+api.ts read their
// secrets from process.env at request time — so an unexported var doesn't fail at
// boot, it fails on the first Customise pass with a confusing upstream error. Load
// the file here and hand the values over explicitly.
//
// Only unprefixed vars need this. EXPO_PUBLIC_* are inlined into the client bundle
// at export time and are already baked into dist/ by the time pm2 sees them.
function loadEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue; // comments and blanks
    out[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

const fileEnv = loadEnvFile(path.join(__dirname, '.env'));

module.exports = {
  apps: [
    {
      name: 'vs-svg-editor',
      // Not `expo serve` — server/index.mjs adds the rate limiting that the open AI
      // proxies and the enumerable /api/review/<id> route need, plus /health and a
      // graceful drain on reload.
      script: 'server/index.mjs',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        PORT: '8081',
        // Loopback only — Caddy is the sole ingress. Binding 0.0.0.0 would expose the
        // app with no TLS and none of the edge rules.
        HOST: '127.0.0.1',
        // Server-only — never prefix these with EXPO_PUBLIC_ or they end up in the
        // client bundle, readable by anyone who opens devtools.
        CLAUDE_API_KEY: fileEnv.CLAUDE_API_KEY,
        KIMI_API_KEY: fileEnv.KIMI_API_KEY,
        API_HOST: fileEnv.API_HOST,
        API_COOLDOWN: fileEnv.API_COOLDOWN,
      },
      max_memory_restart: '1G',
      autorestart: true,
      // Give the drain in server/index.mjs time to finish in-flight AI passes before
      // pm2 escalates to SIGKILL. Must exceed the 15s drain timeout there.
      kill_timeout: 20000,
      // A crash loop should stop and stay visible, not spin silently forever.
      max_restarts: 10,
      min_uptime: '10s',
      error_file: process.env.HOME + '/logs/vs-svg-editor-error.log',
      out_file: process.env.HOME + '/logs/vs-svg-editor-out.log',
    },
  ],
};

// Note: `pm2 reload vs-svg-editor` replays the config pm2 already has stored, so it
// will NOT pick up edits to .env. After changing a secret:
//
//   pm2 reload ecosystem.config.js --update-env
