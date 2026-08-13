// /api/auth — the credential check behind the dev-build login gate.
//
//   GET     → { authed: boolean }   session check, run once on load
//   POST    → { username, password }, sets the session cookie on a match
//   DELETE  → clears it (sign out)
//
// The comparison happens here, never in the browser: EXPO_ADMIN carries no EXPO_PUBLIC_
// prefix, so it stays server-only and is never substituted into the client bundle. A
// client-side check would have to ship the password to every visitor to do its job.
//
// What this is worth: it keeps a publicly reachable dev deployment out of strangers'
// hands. It is not a security boundary for the app as a whole — the JS bundle and the
// other /api routes are still served to anyone who asks, since only the UI is gated. Put
// basic auth in Caddy (see Caddyfile.example) if the whole origin needs closing off.

// Accepted as `user:password`, or as a bare `password` when there is no colon — in which
// case whatever is typed in the username box is ignored. A colon in the password itself
// is fine: only the first one splits.
const readAdmin = (): { user: string | null; pass: string } | null => {
  const raw = process.env.EXPO_ADMIN;
  if (!raw) return null;
  const at = raw.indexOf(':');
  return at === -1 ? { user: null, pass: raw } : { user: raw.slice(0, at), pass: raw.slice(at + 1) };
};

const COOKIE = 'svgedit_dev_auth';
const TTL_MS = 12 * 60 * 60 * 1000;

const enc = new TextEncoder();

// Length-independent comparison, so a wrong password can't be narrowed down by timing
// how long the reply took. Cheap enough to be worth doing even here.
const safeEqual = (a: string, b: string): boolean => {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
};

// The cookie is `<expiry>.<hmac of expiry>`, signed with EXPO_ADMIN itself rather than a
// second secret to configure. Changing the password therefore invalidates every session
// that was issued under the old one, which is the behaviour you'd want anyway.
//
// Web Crypto rather than node:crypto: it is present in every runtime this can be bundled
// for, and needs no import that Metro has to resolve for the server bundle.
const sign = async (payload: string, secret: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const issue = async (secret: string): Promise<string> => {
  const expiry = String(Date.now() + TTL_MS);
  return `${expiry}.${await sign(expiry, secret)}`;
};

const verify = async (token: string | null, secret: string): Promise<boolean> => {
  if (!token) return false;
  const at = token.indexOf('.');
  if (at === -1) return false;
  const expiry = token.slice(0, at);
  // Expiry first: an expired token is rejected whether or not the signature holds, and
  // the signature still has to be checked to know the expiry wasn't simply edited.
  if (!/^\d+$/.test(expiry) || Number(expiry) < Date.now()) return false;
  return safeEqual(token.slice(at + 1), await sign(expiry, secret));
};

const readCookie = (request: Request, name: string): string | null => {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    if (part.slice(0, at).trim() === name) return decodeURIComponent(part.slice(at + 1).trim());
  }
  return null;
};

// Secure is set only over TLS — flagging it on plain http://localhost would make the
// browser drop the cookie and the login would never stick. Caddy terminates TLS and
// forwards over loopback, so the header is what tells us, not the request's own scheme.
const cookieAttrs = (request: Request, maxAgeSeconds: number): string => {
  const https =
    request.headers.get('x-forwarded-proto') === 'https' ||
    new URL(request.url).protocol === 'https:';
  return [
    `Path=/`,
    `Max-Age=${maxAgeSeconds}`,
    'HttpOnly',            // the token is never readable from JS, so an XSS can't lift it
    'SameSite=Lax',        // still sent when following a /<uuid> link in from elsewhere
    https ? 'Secure' : null,
  ].filter(Boolean).join('; ');
};

const notConfigured = () =>
  Response.json(
    { authed: false, error: { message: 'EXPO_ADMIN is not set on the server' } },
    { status: 503 },
  );

export async function GET(request: Request): Promise<Response> {
  const admin = readAdmin();
  if (!admin) return notConfigured();
  return Response.json({ authed: await verify(readCookie(request, COOKIE), admin.pass) });
}

export async function POST(request: Request): Promise<Response> {
  const admin = readAdmin();
  if (!admin) return notConfigured();

  let body: { username?: unknown; password?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: { message: 'Expected a JSON body' } }, { status: 400 });
  }

  const username = typeof body.username === 'string' ? body.username : '';
  const password = typeof body.password === 'string' ? body.password : '';

  // Both halves are always compared, even when one has already failed, so the reply
  // takes the same time either way and doesn't reveal which half was wrong.
  const userOk = admin.user === null || safeEqual(username, admin.user);
  const passOk = safeEqual(password, admin.pass);

  if (!userOk || !passOk) {
    // A small fixed delay on failure. The express rate limiter in server/index.mjs caps
    // /api at 100/min in production; this is the part that also applies under the dev
    // server, and it costs a legitimate typo half a second.
    await new Promise((r) => setTimeout(r, 500));
    console.log('[auth] failed sign-in attempt');
    return Response.json({ error: { message: 'Incorrect credentials' } }, { status: 401 });
  }

  console.log('[auth] signed in');
  return Response.json(
    { authed: true },
    {
      status: 200,
      headers: {
        'set-cookie': `${COOKIE}=${await issue(admin.pass)}; ${cookieAttrs(request, TTL_MS / 1000)}`,
      },
    },
  );
}

export async function DELETE(request: Request): Promise<Response> {
  return Response.json(
    { authed: false },
    { status: 200, headers: { 'set-cookie': `${COOKIE}=; ${cookieAttrs(request, 0)}` } },
  );
}
