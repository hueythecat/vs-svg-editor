// Server-side proxy for Moonshot's Kimi API, exposed with the SAME contract as
// /api/claude so the client can swap endpoints and change nothing else.
//
// The browser POSTs an Anthropic Messages API body; this handler translates it to
// Moonshot's OpenAI-compatible /chat/completions shape, and translates the reply
// back into `{ content: [{ type: 'text', text }] }` so every existing caller's
// `data.content[0].text` parsing keeps working. The key lives in KIMI_API_KEY
// (no EXPO_PUBLIC_ prefix), so only this server route can read it.

// The same request guard as /api/claude, for the same reason: this route also spends
// real money on an unauthenticated call, so the body has to be worth little rather than
// trusted. Sharing the guard is the point — the two routes advertise one contract, and a
// limit tightened for one cannot quietly stay loose on the other. See src/lib/ai-guard.ts.
import { guardAiRequest, isCrossSite, type GuardedBlock } from '@/lib/ai-guard';

// The client hardcodes Claude model ids at each call site; this route ignores the
// incoming model and pins the Kimi model, keeping one source of truth here.
const KIMI_MODEL = 'kimi-k2.6';
const KIMI_URL = 'https://api.moonshot.ai/v1/chat/completions';

// Every caller's prompt ends by demanding strict JSON, and Kimi honours that far
// more reliably when it is also stated as a system message. Anthropic puts `system`
// at the top level of the body; OpenAI makes it the first message.
//
// Always this string now. The route used to fall back to it only when the caller sent no
// `system` of its own — but a caller-supplied system prompt is the whole of what turns a
// narrow SVG-analysis endpoint into a general-purpose one, so the guard rejects the field
// outright and this is the only system message there is.
const SYSTEM = 'You are a precise SVG analyzer. Return only valid JSON.';

// K2.6 reasons before answering and bills that thinking against max_tokens, so the
// callers' budgets — sized for Claude, which does not reason — get spent entirely on
// reasoning, leaving an empty answer. Add headroom on top of whatever the caller asked
// for. It is a ceiling, not a spend: unused tokens cost nothing.
const KIMI_REASONING_HEADROOM = 16384;

// Anthropic content blocks → OpenAI content parts. Base64 images become data URIs.
// The guard has already narrowed these to text and base64-image blocks, so there is no
// string-content case left to handle.
const toOpenAiContent = (content: GuardedBlock[]) =>
  content.map((block) =>
    block.type === 'image'
      ? { type: 'image_url', image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } }
      : { type: 'text', text: block.text },
  );

export async function POST(request: Request): Promise<Response> {
  const apiKey = process.env.KIMI_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: { message: 'KIMI_API_KEY is not set on the server' } },
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
    console.log('[kimi] rejected:', guarded.message);
    return Response.json({ error: { message: guarded.message } }, { status: 400 });
  }
  const body = guarded.body;

  const upstream = await fetch(KIMI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: KIMI_MODEL,
      // The guard requires max_tokens, so there is no absent case to default.
      max_tokens: body.max_tokens + KIMI_REASONING_HEADROOM,
      // Streamed because K2.6 reasons before it answers: a non-streamed call leaves the
      // socket idle for the whole think, and the dev server kills an idle outbound
      // request at 30s ("Request timed out" from node:_http_client). Streaming keeps
      // bytes flowing so the timer never fires; the deltas are re-joined below, so
      // callers still receive one plain JSON body.
      stream: true,
      messages: [
        { role: 'system', content: SYSTEM },
        ...body.messages.map((m) => ({ role: m.role, content: toOpenAiContent(m.content) })),
      ],
    }),
  });

  // Errors arrive as a normal JSON body, not a stream.
  if (!upstream.ok || !upstream.body) {
    const err = await upstream.json().catch(() => null) as { error?: { message?: string } } | null;
    return Response.json(
      { error: { message: err?.error?.message ?? `Kimi API error ${upstream.status}` } },
      { status: upstream.ok ? 502 : upstream.status },
    );
  }

  // Streaming upstream only fixed the outbound leg. The inbound leg — browser →
  // this route — is idle for exactly as long, because the deltas are aggregated
  // here and nothing is written until the last one lands. The browser (and any
  // proxy in between) drops that silent socket mid-think: "NetworkError when
  // attempting to fetch resource". So answer with a stream as well, dripping a
  // newline every few seconds while the aggregation runs. Callers still do
  // `await res.json()` and are none the wiser: JSON ignores leading whitespace,
  // so the padding parses away and the single object at the end is the value.
  //
  // The cost is that the status code is committed before the outcome is known:
  // headers go out with the first byte. Upstream failures are already handled
  // above with a real status; the only case left — an empty completion — ships
  // as 200 with an `error` body. No caller inspects `res.status`; they read
  // `data.content[0].text` and throw when it is missing, which still happens.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode('\n')); } catch { /* client hung up */ }
      }, 5000);

      // Aggregate the SSE deltas into the full completion.
      let text = '';
      let finishReason: string | undefined;
      const reader = upstream.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';           // keep the trailing partial line
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === '[DONE]') continue;
            try {
              const chunk = JSON.parse(payload) as {
                choices?: Array<{ finish_reason?: string; delta?: { content?: string } }>;
              };
              const c = chunk.choices?.[0];
              text += c?.delta?.content ?? '';   // reasoning_content deltas are deliberately dropped
              if (c?.finish_reason) finishReason = c.finish_reason;
            } catch { /* ignore keep-alive and malformed frames */ }
          }
        }

        const body = text.trim()
          ? { content: [{ type: 'text', text }] }
          : {
              error: {
                message: finishReason === 'length'
                  ? 'Kimi hit the token limit while reasoning and returned no answer — raise max_tokens.'
                  : 'Kimi returned an empty response.',
              },
            };
        controller.enqueue(encoder.encode(JSON.stringify(body)));
      } catch (err) {
        controller.enqueue(encoder.encode(JSON.stringify({
          error: { message: err instanceof Error ? err.message : 'Kimi stream failed' },
        })));
      } finally {
        clearInterval(heartbeat);
        reader.cancel().catch(() => {});
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/json',
      // Stop dev-server/proxy buffering from swallowing the heartbeat, which
      // would leave the socket just as silent as before.
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
