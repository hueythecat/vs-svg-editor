// Build-environment flag.
//
// Some surfaces are internal scaffolding rather than product: the dark dev rail of
// sample/download vectors, and the AI tools panel (model picker, per-layer actions,
// taxonomy) that hangs off the Customise pill's caret. In a production build the
// Customise pill is a plain button that runs the pass, and neither of those exists.
//
// EXPO_PUBLIC_APP_ENV decides it. Left unset it follows the bundler, so `expo start`
// keeps the dev surfaces and a production export drops them without any configuration.
// Set it explicitly to force either way — e.g. EXPO_PUBLIC_APP_ENV=production while
// running locally, to see exactly what ships.
//
// The name must be read as a literal `process.env.EXPO_PUBLIC_…` expression: Expo
// inlines these at build time by static substitution, so a computed key reads undefined.
const APP_ENV = process.env.EXPO_PUBLIC_APP_ENV;

export const IS_PRODUCTION_UI = APP_ENV ? APP_ENV === 'production' : !__DEV__;

// Convenience inverse — most call sites read better as "show the dev thing".
export const SHOW_DEV_UI = !IS_PRODUCTION_UI;

// Whether the dev build's sign-in wall is armed.
//
// Its own switch rather than a second reading of APP_ENV. Flipping APP_ENV to production
// does open the gate, but it also drops the dev rail, the AI tools panel, the
// has_customised override and the AI response cache — so "stop asking me for the
// password" quietly costs a 24h cooldown on every asset customised and a live call on
// every pass. Those are separate questions, so they get separate answers.
//
// This only ever loosens: a production build has no gate to arm and this cannot add one.
// Anything other than an explicit off value leaves it armed, so a typo here fails closed
// rather than silently exposing a dev deployment.
//
// As with APP_ENV the name must appear as a literal `process.env.EXPO_PUBLIC_…`
// expression to be inlined, and changing it needs a dev-server restart.
const DEV_AUTH = process.env.EXPO_PUBLIC_DEV_AUTH;

export const REQUIRE_DEV_AUTH =
  SHOW_DEV_UI && !(DEV_AUTH === 'off' || DEV_AUTH === '0' || DEV_AUTH === 'false');

// The commit this bundle was built from — short hash, +dirty when the build machine had
// uncommitted changes. Re-exported from the module app.config.js generates at build time;
// see that file for why it arrives as a generated literal rather than an env var. Shown
// in the dev rail's title and served by /api/version, so a deployment that quietly failed
// to rebuild can be spotted by its hash rather than by its behaviour.
//
// Frozen when the bundler starts, not when the page loads: committing while a dev server
// is running won't change what it reports until Metro restarts.
//
// 'nogit' means the build machine had no git to ask.
export { CODE_VERSION } from './code-version';

// How many font suggestions an AI pass asks for, and how many it keeps.
//
// One number for both, because they used to disagree: the customise pass asked for "2–4"
// and then capped the result at 6, so the cap could never bind, while the standalone
// suggestion asked for 5 and capped nothing at all. Tuning that meant editing three
// literals in two prompts and hoping they stayed in step.
//
// EXPO_PUBLIC_ prefixed because this is read in the browser — the prompts are built
// client-side. An unprefixed FONT_SUGGESTION_LIMIT is server-only in Expo and would read
// undefined here, silently falling back to the default. As with APP_ENV above, the name
// has to appear as a literal `process.env.EXPO_PUBLIC_…` expression to be inlined.
const RAW_FONT_LIMIT = process.env.EXPO_PUBLIC_FONT_SUGGESTION_LIMIT;

export const FONT_SUGGESTION_LIMIT = (() => {
  const n = Number(RAW_FONT_LIMIT);
  // A non-numeric, zero or negative value is a misconfiguration, not an instruction to
  // ask for no fonts — fall back rather than quietly disabling the feature.
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
})();
