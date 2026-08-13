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
// Public and unauthenticated, so it does disclose the deployed commit hash. That is the
// trade for being able to check it from anywhere without credentials; block /api/version
// at the edge in the Caddyfile if that isn't wanted.

import { CODE_VERSION } from '@/lib/env';

export function GET(): Response {
  return Response.json({ codeVersion: CODE_VERSION });
}
