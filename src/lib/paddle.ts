// Paddle Billing overlay checkout, behind the dev rail's Buy button.
//
// Checkout only: this opens Paddle's hosted overlay against a price and leaves the
// transaction there. Nothing here records a purchase, grants anything, or listens for
// the result — a completed payment reaches nobody in this app. Fulfilment would need a
// webhook endpoint with signature verification and somewhere to keep entitlement, which
// is a deliberate non-goal at this stage.
//
// Three build-time vars configure it, EXPO_PUBLIC_ prefixed because all three are read
// in the browser. As everywhere else, the names must appear as literal
// `process.env.EXPO_PUBLIC_…` expressions to be inlined, and changing one needs a
// re-export rather than a restart — see src/lib/env.ts.
//
//   EXPO_PUBLIC_PADDLE_ENV        'sandbox' (default) or 'production'
//   EXPO_PUBLIC_PADDLE_TOKEN      client-side token from Paddle > Developer tools
//   EXPO_PUBLIC_PADDLE_PRICE_ID   the pri_… to put in the basket
//
// The token is a client-side token and belongs in the bundle — that is what it is for.
// It is not the API key: an API key (server-side, full account access) must never be
// given an EXPO_PUBLIC_ name, which would inline it into a bundle served to everyone.
import { initializePaddle, type Environments, type Paddle } from '@paddle/paddle-js';

const RAW_ENV = process.env.EXPO_PUBLIC_PADDLE_ENV;
const TOKEN = process.env.EXPO_PUBLIC_PADDLE_TOKEN;
const PRICE_ID = process.env.EXPO_PUBLIC_PADDLE_PRICE_ID;

// Production only when asked for by that exact name. Anything else — unset, a typo, a
// half-finished edit — resolves to sandbox, so the failure mode of a misconfiguration is
// a checkout that cannot take money rather than one that can. The opposite default would
// put real charges one stray character away.
export const PADDLE_ENV: Environments = RAW_ENV === 'production' ? 'production' : 'sandbox';

// Both are needed to open anything, so the button can say which one is missing rather
// than failing at the click.
export const paddleConfigError = (): string | null => {
  if (!TOKEN) return 'EXPO_PUBLIC_PADDLE_TOKEN is not set in this build';
  if (!PRICE_ID) return 'EXPO_PUBLIC_PADDLE_PRICE_ID is not set in this build';
  return null;
};

// Paddle.js is fetched from cdn.paddle.com on first use rather than at module load: the
// rail mounts on every dev page view and most of them never reach for billing.
//
// The promise is memoised so repeated clicks share one script load, but a *failed* load
// is not — a rejected promise kept here would make the first failure permanent for the
// page, and the usual causes (an ad blocker, a CSP that doesn't allow the CDN yet, a
// dropped connection) are all things the user can fix and retry without a reload.
let paddlePromise: Promise<Paddle | undefined> | null = null;

const getPaddle = (): Promise<Paddle | undefined> => {
  paddlePromise ??= initializePaddle({ token: TOKEN!, environment: PADDLE_ENV }).catch((err) => {
    paddlePromise = null;
    throw err;
  });
  return paddlePromise;
};

// Rejects rather than reporting into the UI itself, so the caller owns how a failure is
// shown. Resolves as soon as the overlay is asked to open — Paddle owns everything after
// that, and there is no result to wait for.
export const openPaddleCheckout = async (): Promise<void> => {
  const configError = paddleConfigError();
  if (configError) throw new Error(configError);

  const paddle = await getPaddle();
  // initializePaddle resolves undefined rather than throwing when the script didn't
  // load, which would otherwise surface as a bare "cannot read property Checkout".
  if (!paddle) {
    throw new Error('Paddle.js did not load — check CSP (cdn.paddle.com) or an ad blocker');
  }

  paddle.Checkout.open({
    settings: { displayMode: 'overlay', theme: 'dark' },
    items: [{ priceId: PRICE_ID!, quantity: 1 }],
  });
};
