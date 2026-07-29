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
