// Server-side proxy for the Anthropic Messages API.
//
// The browser POSTs the exact Messages API request body to /api/claude; this
// handler injects the secret key and forwards it to Anthropic. The key lives in
// CLAUDE_API_KEY (no EXPO_PUBLIC_ prefix), so it is never included in the client
// bundle — only this server route can read it.
export async function POST(request: Request): Promise<Response> {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: { message: 'CLAUDE_API_KEY is not set on the server' } },
      { status: 500 },
    );
  }

  // Forward the raw body verbatim so the request is byte-for-byte what the
  // client built (model, max_tokens, messages, …).
  const body = await request.text();

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body,
  });

  // Pass Anthropic's response body and status straight back to the client.
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
