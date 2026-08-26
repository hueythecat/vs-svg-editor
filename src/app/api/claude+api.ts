// Server-side proxy for the Anthropic Messages API.
//
// The browser POSTs a Messages API request body to /api/claude; this handler validates
// it, injects the secret key and forwards it to Anthropic. The key lives in
// CLAUDE_API_KEY (no EXPO_PUBLIC_ prefix), so it is never included in the client
// bundle — only this server route can read it.
//
// The body is no longer forwarded verbatim. It used to be, which made this a free
// general-purpose Claude endpoint for anyone who could reach the origin: any model, any
// max_tokens, any system prompt, any number of turns, all billed to us. Production has no
// session to authenticate against — anyone may drop an SVG and run a pass — so the guard
// is on the shape of the request instead. See src/lib/ai-guard.ts for what it allows and
// why each limit is where it is.
//
// Spend itself is bounded a layer up, in server/index.mjs: a per-IP throttle, a global
// daily budget that trips regardless of how many IPs are involved, and a cap on how many
// passes can be in flight at once.
import { guardAiRequest, isCrossSite } from '@/lib/ai-guard';

export async function POST(request: Request): Promise<Response> {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: { message: 'CLAUDE_API_KEY is not set on the server' } },
      { status: 500 },
    );
  }

  if (isCrossSite(request)) {
    return Response.json({ error: { message: 'Cross-site requests are not accepted' } }, { status: 403 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: { message: 'Expected a JSON body' } }, { status: 400 });
  }

  const guarded = guardAiRequest(raw);
  if (!guarded.ok) {
    console.log('[claude] rejected:', guarded.message);
    return Response.json({ error: { message: guarded.message } }, { status: 400 });
  }

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    // The re-serialised body from the guard, not the caller's bytes — so nothing that
    // wasn't inspected reaches Anthropic on our key.
    body: JSON.stringify(guarded.body),
  });

  // Pass Anthropic's response body and status straight back to the client.
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
