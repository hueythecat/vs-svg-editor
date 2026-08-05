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
