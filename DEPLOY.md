# Deploying vs-svg-editor

Expo Router web app with `web.output: "server"` (`app.json`), so it has a real server
build: `npx expo export --platform web` produces `dist/client` (static assets) and
`dist/server` (the `+api.ts` routes). **That export is what production runs** — not
`expo start`, which is the Metro dev server.

```
internet → Caddy :80/:443            TLS, security headers, CSP, access logs
              ↓ 127.0.0.1:8081
           server/index.mjs          static assets, rate limiting, /health, graceful drain
              ↓
           dist/server               Expo Router html + API routes
              ↑ pm2                  supervision, restart, log rotation
```

No nginx, no certbot — Caddy issues and renews certificates itself.

## 1. Install

| Thing | Version | Why |
|---|---|---|
| Node.js | **≥ 20.19**, use 22 LTS | Expo SDK 56's stated minimum |
| git | any | deploy pulls |
| pm2 | latest, global | process supervision |
| Caddy | v2 | TLS + reverse proxy; automatic HTTPS, nothing to renew |
| build-essential, python3 | distro | native rebuilds during `npm ci` |
| ufw | distro | firewall |
| unattended-upgrades | distro | automatic security patches |

Ubuntu 22.04/24.04:

```bash
sudo apt update && sudo apt install -y git curl build-essential python3 ufw \
  unattended-upgrades debian-keyring debian-archive-keyring apt-transport-https

curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2

curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

RHEL/Amazon Linux: `dnf`, `gcc-c++ make` for build-essential, `firewalld` for ufw, and the
`rpm.nodesource.com/setup_22.x` / Caddy `rpm.txt` variants.

**Size the box for the build, not the serving.** `expo export` runs Metro over the whole tree
and is the memory spike — **≥ 2 GB RAM, ideally 4 GB**. A 1 GB box OOMs during export; add swap
or build elsewhere and rsync `dist/`. Disk: ~1.5 GB.

## 2. Harden the host

Do this before the domain resolves, not after.

```bash
# Dedicated unprivileged service user — the app never runs as root or as your login.
sudo adduser --system --group --home /srv/vs-svg-editor svgapp

# Firewall: SSH + HTTP + HTTPS only. :8081 stays unreachable from outside; the app
# binds 127.0.0.1 anyway, and this is the second lock.
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
sudo ufw enable

# Automatic security patches
sudo dpkg-reconfigure --priority=low unattended-upgrades

# pm2 log rotation — without this the logs grow until the disk fills
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
```

Also worth doing: disable SSH password auth (`PasswordAuthentication no` in
`/etc/ssh/sshd_config`), and install `fail2ban`.

## 3. Configure

Three things a fresh clone needs that are **not in git**:

```bash
git clone <repo> /srv/vs-svg-editor/app && cd /srv/vs-svg-editor/app
cp ecosystem.config.example.js ecosystem.config.js
sudo cp Caddyfile.example /etc/caddy/Caddyfile    # then set the domain and email
```

And `.env`, created by hand:

```
CLAUDE_API_KEY=...
KIMI_API_KEY=...
API_HOST=https://dev.vectorstock.com
API_COOLDOWN=...
EXPO_ADMIN=user:password
EXPO_PUBLIC_FONT_SUGGESTION_LIMIT=5
```

`EXPO_ADMIN` is the credential behind the sign-in gate on non-production builds
(`src/app/api/auth+api.ts`). `user:password`, or a bare value to accept any username with that
password. Unset, `/api/auth` answers 503 and nobody can get past the gate. It also signs the
session cookie, so changing it signs everyone out — which is what you'd want.

```bash
chmod 600 .env && sudo chown svgapp:svgapp .env
```

### Build-time vs runtime env

The two fail in completely different ways, which is what makes this confusing:

- **`EXPO_PUBLIC_*` is inlined into the client bundle at export time.** Changing one needs a
  re-export; a restart does nothing. Expo substitutes these statically, so the name must appear
  as a literal `process.env.EXPO_PUBLIC_…` expression — see `src/lib/env.ts`.
- **Unprefixed vars are read at runtime** by the API routes. A missing one doesn't fail at boot,
  it fails on the first request that needs it. `ecosystem.config.example.js` parses `.env` and
  hands the whole lot to pm2, because pm2 does not read `.env` itself. Adding a new server-only
  var therefore means editing `.env` and nothing else — but the running process still has to be
  given the new environment, see §6.
- `EXPO_PUBLIC_APP_ENV` can stay unset — `src/lib/env.ts:17` falls back to `!__DEV__`, so a
  production export already drops the dev rail and AI tools panel. Set it to `production` if
  you'd rather that not depend on the bundler.

`API_HOST` is deliberately unprefixed so it stays server-side only.

## 4. Build and run

```bash
npm ci                          # devDeps included — TypeScript is needed for the export
npx expo export --platform web  # → dist/client + dist/server
pm2 start ecosystem.config.js && pm2 save && pm2 startup   # run the command it prints
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

## 5. Enforce the CSP

`Caddyfile.example` ships the policy as **`Content-Security-Policy-Report-Only`** so a wrong
policy degrades reporting rather than breaking the editor. It is not protecting anything until
you enforce it.

This matters more than usual here: `editor-canvas.tsx:196` renders imported SVG through
`dangerouslySetInnerHTML`, and the only guard is the regex `stripScripts()` in
`svg-utils.ts:20`, which strips `<script>` tags and `on*=` attributes. That is not a complete
SVG sanitiser. The CSP is the backstop.

1. Load the editor, import an SVG, run a customise pass, export.
2. Check the browser console for CSP violation reports.
3. Try removing `'unsafe-inline'` from `script-src` — it is the weakest part of the policy, and
   whether Expo's SSR needs it depends on the export.
4. Rename the header to `Content-Security-Policy` and reload Caddy.

If the editor is launched **inside an iframe** from vectorstock, change `frame-ancestors 'none'`
to that origin and remove the `X-Frame-Options "DENY"` line, or it renders as a blank frame.

## 6. Subsequent deploys

`./pull-and-restart.sh` — pulls main, runs `npm ci` if the lockfile moved, exports into a
staging directory, swaps it into `dist/`, reloads pm2, then **polls `/health` and fails loudly
if the new build doesn't answer**. Every failure path leaves the previous build serving. Logs
to `~/logs/vs-svg-editor.log`. Safe for cron or a webhook.

It reloads via `pm2 reload ecosystem.config.js --update-env`, so a `.env` edit committed to the
server takes effect on the next deploy without any extra step.

### Rebuilding without a pull

A `git pull` is not the only thing that changes what's served — an edited `.env`, or a fix
applied directly on the box to try before committing it, moves nothing that the default run
would notice, and it exits with "No changes." and rebuilds nothing.

```bash
./pull-and-restart.sh --no-pull
```

Same export, swap, reload and health check, minus the pull, and it rebuilds unconditionally.
Prefer this over a hand-rolled rebuild script: the risky part is the swap, and a second copy of
it is a second chance to get it wrong. Output tees to the terminal as well as the log when run
by hand.

For an `EXPO_PUBLIC_*` change a rebuild is the only thing that works — those are inlined into
the client bundle at export time, and no amount of reloading will change them.

For an unprefixed, server-only var (`CLAUDE_API_KEY`, `API_HOST`, `EXPO_ADMIN`, …) the reload
alone is enough, since the routes read `process.env` at request time:

```bash
pm2 reload ecosystem.config.js --update-env
```

Use that exact form. `pm2 reload vs-svg-editor` replays the environment pm2 recorded at start
and will silently keep serving the old value.

## 7. Verify

1. `node -v` → ≥ 20.19; `pm2 -v`; `sudo caddy validate --config /etc/caddy/Caddyfile`
2. `dist/client/_expo/` and `dist/server/` both exist — that is all `server/index.mjs`
   checks before boot, and `expo-server` owns the layout inside `dist/server/`. Don't
   assert on files within it. Note there is **no `dist/client/index.html`**: with
   `web.output: "server"` the prerendered HTML lands in `dist/server/`, and
   `dist/client/` holds only hashed assets. The real proof the build is good is step 3
3. `curl -s http://127.0.0.1:8081/health` → `{"ok":true,...}`
4. `curl -s http://127.0.0.1:8081/api/review/list | head -c 200` → JSON, not a 500. Proves
   `API_HOST` reached the runtime process.
5. Rate limiting works — the 11th call in a minute must be 429:
   ```bash
   for i in $(seq 1 12); do curl -s -o /dev/null -w "%{http_code} " \
     -X POST http://127.0.0.1:8081/api/claude -d '{}'; done
   ```
6. `sudo ufw status` → only 22/80/443. From another host, `curl http://<ip>:8081/` must fail.
7. `sudo journalctl -u caddy -n 50` → certificate obtained, no ACME retry loop;
   `curl -I http://<domain>/` → 308 to HTTPS
8. Headers present: `curl -sI https://<domain>/ | grep -i "strict-transport\|x-content-type\|content-security"`
9. Over HTTPS: import an SVG, select a layer, run a customise pass (proves `CLAUDE_API_KEY` is
   live server-side), export the file
10. Dev rail and AI tools panel **absent** — confirms the production export took effect
11. `pm2 reload vs-svg-editor`, re-check step 3 — no downtime, no dropped in-flight request

## Known gaps

Not closed by this setup:

- **`GET /api/review/<id>` is unauthenticated and enumerable.** `src/app/api/review/[id]+api.ts`
  validates only `/^\d+$/` and returns the complete SVG as JSON. The rate limiter slows a
  scraper; it does not stop one. This route needs a real entitlement check.
- **`/api/claude` and `/api/kimi` are open proxies.** Anyone who can reach the origin can spend
  your API credits. Throttled to 10/min per IP, which bounds the damage rather than preventing
  it.
- **`stripScripts()` is not a sanitiser.** Consider DOMPurify with SVG profile on import.
- **Rate limit counters are in-memory**, correct for one pm2 process. Cluster mode or a second
  host needs a shared store or each worker allows the full budget independently.
- **No alerting.** pm2 restarts a crashed process silently; nothing pages you. Point an uptime
  monitor at `/health`.
