// GET /api/version — which commit this deployment is actually serving.
//
//   curl -s https://<host>/api/version
//   {"codeVersion":"0b6fc4e"}
//
// The deploy hook pulls main and then re-runs `expo export` (pull-and-restart.sh). When
// the pull succeeds and the export doesn't, git HEAD on the box moves forward while
// dist/ stays where it was — production looks healthy and serves last week's code. That
// is the failure this endpoint exists to catch.
//
// So it must not shell out to git: git would report the new HEAD and hide exactly that
// case. It reports EXPO_PUBLIC_CODE_VERSION, which app.config.js stamped in at export
// time and babel substituted into this bundle — the version of the code answering the
// request, not the version sitting in the checkout. Answering from the wrong source
// here would make the check worse than useless, since it would read as reassurance.
//
// `buildEnv` reports the EXPO_PUBLIC_* values the export was built with, for the same
// reason and against a failure the commit hash cannot show. Those values are substituted
// into the client bundle at export time, so an edited .env changes nothing until a
// re-export — and a warm Metro cache will re-emit the previous bundle unchanged when no
// .ts moved alongside the .env. Right commit, healthy /health, previous build's flags.
//
// It comes from the generated module for the same reason CODE_VERSION does, and this is
// the one part that is easy to get wrong: babel only substitutes process.env.EXPO_PUBLIC_*
// into the *client* bundle. In this server bundle those stay live lookups, so reading
// them here — directly or through src/lib/env.ts, which does exactly that — would report
// pm2's current environment rather than the build's. After a `pm2 reload --update-env`
// that reads back the .env you just edited and confirms a change that never shipped to
// anyone. A generated literal is the same value in both bundles, so it cannot.
//
// Raw strings, as the build read them, not the booleans src/lib/env.ts derives: see
// app.config.js for why a second copy of that derivation would be worse than none.
//
// Public and unauthenticated, so it does disclose the deployed commit hash and these
// flags. That is the trade for being able to check it from anywhere without credentials
// — and the same values are already readable in the client bundle, which is served to
// anyone regardless. Block /api/version at the edge in the Caddyfile if that isn't
// wanted.

import { BUILD_ENV, CODE_VERSION } from '@/lib/code-version';

export function GET(): Response {
  return Response.json({ codeVersion: CODE_VERSION, buildEnv: BUILD_ENV });
}
