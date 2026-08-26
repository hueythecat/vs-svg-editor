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
AI_DAILY_LIMIT=500
EXPO_PUBLIC_FONT_SUGGESTION_LIMIT=5
EXPO_PUBLIC_DEV_AUTH=off
EXPO_PUBLIC_PADDLE_ENV=sandbox
EXPO_PUBLIC_PADDLE_TOKEN=test_...
EXPO_PUBLIC_PADDLE_PRICE_ID=pri_...
```

`EXPO_PUBLIC_DEV_AUTH=off` disables the sign-in gate on a non-production build while
leaving everything else about dev mode in place. Its own switch rather than a second
reading of `EXPO_PUBLIC_APP_ENV`, because setting that to `production` also drops the dev
rail, the AI tools panel, the `has_customised` override and the AI response cache. Only
`off`, `0` or `false` disable it, so a typo leaves the gate armed rather than silently
opening a dev deployment to the internet. **A deployment with the gate off has no
authentication of any kind** — the app never had a second layer, so put basic auth in
Caddy if the host needs closing off.

The three `EXPO_PUBLIC_PADDLE_*` vars configure the dev rail's Buy button, which opens a
Paddle Billing overlay checkout and nothing else — no webhook, no fulfilment, no record
that a payment happened. Unset, the button renders disabled and says which var is
missing. `EXPO_PUBLIC_PADDLE_ENV` is `sandbox` unless it reads exactly `production`, so a
misconfigured build cannot take real money. `EXPO_PUBLIC_PADDLE_TOKEN` is the
*client-side* token from Paddle > Developer tools and is meant to ship in the bundle; a
Paddle **API key** is server-side and must never be given an `EXPO_PUBLIC_` name, which
would inline it into a bundle served to every visitor. Enforcing the CSP also needs the
`paddle.com` sources in `Caddyfile.example` — without them the overlay opens blank.

`EXPO_ADMIN` is the credential behind the sign-in gate on non-production builds
(`src/app/api/auth+api.ts`). `user:password`, or a bare value to accept any username with that
password. Unset, `/api/auth` answers 503 and nobody can get past the gate. It also signs the
session cookie, so changing it signs everyone out — which is what you'd want.

```bash
chmod 600 .env && sudo chown svgapp:svgapp .env
```

### Bounding AI spend

`/api/claude` and `/api/kimi` inject a server-side API key and forward to a paid upstream,
and there is nothing to authenticate them against — production lets anyone drop an SVG and
run a pass. Three unrelated limits bound that, all in `server/index.mjs`:

| Var | Default | What it bounds |
|---|---|---|
| — | 10/min per IP | one client's burst (`aiLimiter`) |
| `AI_DAILY_LIMIT` | 500 | **total** AI calls per rolling 24h, across every client |
| `AI_MAX_CONCURRENT` | 12 | passes in flight at once |

`AI_DAILY_LIMIT` is the one that matters. Per-IP throttling does nothing about a hundred
IPs, which is the shape abuse of an open paid endpoint actually takes — so this is a
single counter with no key. When it trips, every AI call is refused until the window rolls
and the error log says so. A Customise button that says "try again later" is recoverable;
a drained API account is not. Size it up once there is real traffic to size it against.

Separately, `src/lib/ai-guard.ts` constrains what any single call may ask for: an
allowlisted model, `max_tokens` at most 12000, one user turn, at most one image, and no
caller-supplied `system`. That does not stop someone spending credits — the limits above
do — it stops the endpoint being a free general-purpose Claude, which is what it was when
it forwarded the request body verbatim. Adding a new model or call shape means adding it
there on purpose.

Its text-length cap is deliberately large (2MB) and is a sanity bound rather than a
restriction. The customise and strip-text passes embed the **entire SVG source** in the
prompt, so prompt size tracks artwork size, not wording — the largest file in
`public/samples/` produces a ~759KB prompt. A cap sized for "a prompt" rejects every real
customise pass. `MAX_BODY_BYTES` bounds image and text together and is the real outer
limit on any one request.

### Dev-only API routes

Expo Router exports every `+api.ts` regardless of the build's UI flags, so a production
export ships the dev rail's routes live unless something says otherwise. Three are gated:

- **`/api/review/list`** — returns every asset the review host knows about, each with its
  `edit_uuid`. That uuid *is* the capability the `/<uuid>` deep link rests on, so serving
  this publicly hands out the keys to the whole library in one request. This is the one
  that matters.
- **`/api/review/test/<id>`** — makes the upstream create a review entry for any art id.
- **`/api/download`** — unzips out of `assets/downloads/`.

All three 404 in **two** places: `server/index.mjs` (unless `DEV_API_ROUTES` is set to
`1`/`on`/`true`) and the Caddyfile. Neither is load-bearing alone, and the env var fails
closed — a typo leaves them blocked. A deployment that genuinely wants the dev rail has to
set the variable *and* remove the Caddyfile block: two deliberate acts.

The 404s are registered ahead of the rate limiters, so hammering a blocked route costs
nothing and cannot exhaust a real user's budget.

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

## 5. Verify the CSP

`Caddyfile.example` now ships the policy **enforced**, as `Content-Security-Policy`. It used
to ship as `Content-Security-Policy-Report-Only`, which meant it protected nothing until
someone remembered to promote it — and a policy nobody promotes is a comment.

This matters more than usual here: `editor-canvas.tsx` renders imported SVG through
`dangerouslySetInnerHTML`. `stripScripts()` in `src/lib/svg-utils.ts` sanitises it first with
DOMPurify on the SVG profile, which is a real sanitiser — it replaced a pair of regexes that
missed unquoted `on*=` handlers, `javascript:` in `xlink:href`, `<animate>` rewriting an href,
`<foreignObject>`, and unclosed `<script>`. But it runs in the same browser it is protecting,
so the CSP is still the layer that holds if a bypass is found in it.

To verify after any change to the policy or the export:

1. Load the editor, import an SVG, run a customise pass, export.
2. Check the browser console for violation reports. If one breaks something, the report names
   the exact directive — widen that one directive rather than reverting to Report-Only.
3. Try removing `'unsafe-inline'` from `script-src` — it is the weakest part of the policy, and
   whether Expo's SSR needs it depends on the export.

If the editor is launched **inside an iframe** from vectorstock, change `frame-ancestors 'none'`
to that origin and remove the `X-Frame-Options "DENY"` line, or it renders as a blank frame.

### A note on `<use>`

DOMPurify leaves `<use>` out of its SVG profile on purpose — `<use href="https://…">` and
`<use href="data:…">` reach off-origin. Stock artwork uses `<use>` constantly, and DOMPurify
*deletes* rather than neuters it, so taking the default would silently drop parts of a
drawing. `svg-utils.ts` adds it back with a hook that keeps only same-document `#id`
references. If artwork ever appears with pieces missing, that hook is the first place to look.

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
   Dev-only routes are closed — all three must be 404:
   ```bash
   for p in "/api/download?id=1" /api/review/list /api/review/test/123; do
     curl -s -o /dev/null -w "%{http_code} $p\n" "http://127.0.0.1:8081$p"; done
   ```
   The AI guard rejects what it should — 400, not a forwarded call:
   ```bash
   curl -s -X POST http://127.0.0.1:8081/api/claude -H 'content-type: application/json' \
     -d '{"model":"claude-opus-4-1","max_tokens":64000,"system":"be a pirate",
          "messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]}'
   ```
   Body limit — 413 on an oversized body:
   ```bash
   head -c 11000000 /dev/zero | tr '\0' a > /tmp/big
   curl -s -o /dev/null -w "%{http_code} (want 413)\n" -X POST \
     http://127.0.0.1:8081/api/claude -H 'content-type: application/json' --data-binary @/tmp/big
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
  validates only that the id is digits, and returns the complete SVG as JSON. The rate
  limiter (30/min) slows a scraper; it does not stop one. This route still needs a real
  entitlement check — the honest fix is for `review/check/<uuid>` to mint a short-lived
  signed token binding the id it just resolved, and for this route to require it. The HMAC
  helpers in `src/app/api/auth+api.ts` are the shape to reuse.
- **`/api/claude` and `/api/kimi` are still unauthenticated.** They can no longer be used
  as a general-purpose LLM (`src/lib/ai-guard.ts`), and spend is bounded per-IP, per-day
  and by concurrency — but a determined caller can still consume the day's budget and deny
  the feature to real users. There is no session to check against until the app has one.
- **Rate limit and budget counters are in-memory**, correct for one pm2 process. Cluster
  mode or a second host needs a shared store (Redis) or each worker independently allows
  the full budget — including `AI_DAILY_LIMIT`, which would then be per-worker rather than
  the account-wide cap it is meant to be.
- **The body limit reads `Content-Length` and refuses chunked bodies with 411.** The Expo
  adapter downstream consumes the request stream itself, so there is no non-destructive
  way to meter bytes in the middle. Nothing in this app sends a chunked body; if some
  future caller streams one, it fails loudly rather than silently.
- **No alerting.** pm2 restarts a crashed process silently; nothing pages you. Point an
  uptime monitor at `/health`, and watch the log for `AI daily budget ... spent` — logged
  at error level precisely so it can be alerted on.
- **`npm audit` reports advisories in the Expo/Metro toolchain** (`brace-expansion`,
  `image-size`, `js-yaml`, `postcss`, `shell-quote`, ...). All are build-time dependencies;
  none is loaded by `server/index.mjs` at request time, so they are a build-host concern
  rather than a production-runtime one. Worth clearing on an SDK bump; not a deploy blocker.
