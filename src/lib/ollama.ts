/// <reference types="node" />
// Server side of the "Local" entry in the AI tools Model dropdown: one vision turn to an
// Ollama model running on this machine, in place of the paid API.
//
// Dev tooling, not a product path. Measured on an M2 Air against Sonnet 5 on the
// text-detection call, qwen3-vl:8b takes one to two minutes where Sonnet takes under ten
// seconds, reads simple artwork correctly, loses track of which box is which on busy
// artwork, and answers "Montserrat" for every font. It exists so a pass can be exercised
// for free, and it only answers where the dev routes do.
import http from 'node:http';

export const LOCAL_MODEL = 'qwen3-vl:8b';

const OLLAMA_URL = new URL(process.env.OLLAMA_HOST || 'http://127.0.0.1:11434');

// Prompt + two 1800px renders is about 4,300 tokens for this model, and the answer is
// capped by the caller; this leaves room for both without the memory a larger window
// would take on a laptop.
const NUM_CTX = 16384;

// The same switch that opens the other dev routes on a production host, and always on
// under the dev server. A production build without it answers 404: there is no Ollama
// on the server, and nothing there should be able to reach one by asking.
export const localModelEnabled = (): boolean =>
  process.env.NODE_ENV !== 'production'
  || ['1', 'on', 'true'].includes(String(process.env.DEV_API_ROUTES ?? '').toLowerCase());

// One user turn — text plus base64 images — answered as plain text.
//
// `prefill` is the start of the answer, written for the model. It is not a nicety: this
// build reasons before it answers whatever it is told (`think: false` and /no_think are
// both ignored), which on the text-detection call was seventeen minutes of reasoning that
// then used up the token budget before any JSON appeared. Starting the answer skips the
// reasoning entirely. It has to commit the model to the shape, too — a bare
// `{"regions":[` was closed straight away as an empty list.
//
// node:http rather than fetch, and streamed: the model is silent for as long as it takes
// to read the images (tens of seconds), then slow to write. fetch gives up after five
// minutes without headers, and the dev server drops an outbound request that sits idle;
// a streamed request on a socket with no timeout has neither problem.
export function ollamaChat(opts: {
  prompt: string; images: string[]; prefill: string; maxTokens: number;
}): Promise<string> {
  const payload = JSON.stringify({
    model: LOCAL_MODEL,
    stream: true,
    think: false,
    options: { temperature: 0, num_ctx: NUM_CTX, num_predict: opts.maxTokens },
    messages: [
      { role: 'user', content: opts.prompt, images: opts.images },
      { role: 'assistant', content: opts.prefill },
    ],
  });

  return new Promise<string>((resolve, reject) => {
    const req = http.request(
      {
        host: OLLAMA_URL.hostname, port: OLLAMA_URL.port || 11434, path: '/api/chat', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        let buffer = '';
        let text = '';
        let failure: string | null = null;
        let truncated = false;
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';   // keep the trailing partial line
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const frame = JSON.parse(line) as {
                error?: string; done?: boolean; done_reason?: string; message?: { content?: string };
              };
              if (frame.error) failure = frame.error;
              text += frame.message?.content ?? '';   // `thinking` deltas are deliberately dropped
              if (frame.done && frame.done_reason === 'length') truncated = true;
            } catch { /* a malformed frame is not worth failing the answer over */ }
          }
        });
        res.on('error', reject);
        res.on('end', () => {
          if (failure) {
            // Ollama's own wording for a model that was never pulled is accurate but
            // doesn't say what to do about it.
            reject(new Error(/not found/i.test(failure)
              ? `${LOCAL_MODEL} is not installed — run: ollama pull ${LOCAL_MODEL}`
              : `Ollama: ${failure}`));
          } else if (truncated) {
            reject(new Error(`${LOCAL_MODEL} hit the ${opts.maxTokens}-token limit before finishing its answer`));
          } else {
            resolve(opts.prefill + text);
          }
        });
      },
    );
    req.setTimeout(0);
    req.on('error', (err: NodeJS.ErrnoException) => {
      reject(new Error(err.code === 'ECONNREFUSED'
        ? `Ollama is not running at ${OLLAMA_URL.host} — start it, then try again`
        : `Ollama request failed: ${err.message}`));
    });
    req.end(payload);
  });
}

// Answers with `work`'s JSON once it settles, and a newline every few seconds until then.
//
// The browser's request to this route is otherwise silent for the minute or two the model
// takes, and a silent socket gets dropped ("NetworkError when attempting to fetch
// resource") — the same thing /api/kimi found. JSON ignores leading whitespace, so the
// caller's `await res.json()` reads the object at the end and never sees the padding.
//
// The cost is that the status is committed with the first byte: a failure arrives as a
// 200 carrying `{ error: { message } }`, so callers have to look for `error` in the body
// rather than trust `res.ok`.
export function respondWhenDone(work: Promise<unknown>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode('\n')); } catch { /* client hung up */ }
      }, 5000);
      let body: unknown;
      try {
        body = await work;
      } catch (err) {
        body = { error: { message: err instanceof Error ? err.message : 'Local model failed' } };
      }
      clearInterval(heartbeat);
      try {
        controller.enqueue(encoder.encode(JSON.stringify(body)));
        controller.close();
      } catch { /* client hung up */ }
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/json',
      // Stop dev-server/proxy buffering from swallowing the heartbeat.
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
