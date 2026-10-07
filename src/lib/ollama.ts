/// <reference types="node" />
// Server side of the "Local" entries in the AI tools Model dropdown: one vision turn to an
// Ollama model running on this machine, in place of the paid API.
//
// Dev tooling, not a product path. Measured on an M2 Air against Sonnet 5 on the
// text-detection call, qwen3-vl:8b takes one to two minutes where Sonnet takes under ten
// seconds, reads simple artwork correctly, loses track of which box is which on busy
// artwork, and answers "Montserrat" for every font. It exists so a pass can be exercised
// for free, and it only answers where the dev routes do.
import http from 'node:http';

// The models this will run, and whether each needs its answer started for it (see
// ollamaChat). Two builds of the same model: the default tag reasons before it answers
// and the -instruct one answers directly. Against Sonnet 5 on four samples the instruct
// build scored a little higher overall (159 of 192 fields to 143) but they fail on
// different artwork — it placed a badge's single letter where the other could not, and
// missed a business card's monogram the other read — so both are offered.
//
// The ids are repeated in components/editor-types.ts for the dropdown, which can't import
// this module (node:http); the two lists must match.
const LOCAL_MODELS = {
  'qwen3-vl:8b': { prefill: true },
  'qwen3-vl:8b-instruct': { prefill: false },
} as const;
export type LocalModel = keyof typeof LOCAL_MODELS;

export const isLocalModel = (model: unknown): model is LocalModel =>
  typeof model === 'string' && Object.hasOwn(LOCAL_MODELS, model);

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
// `prefill` is the start of the answer, written for the model, and is used only for a
// build that needs it. For the reasoning build it is not a nicety: that build reasons
// before it answers whatever it is told (`think: false` and /no_think are both ignored),
// which on the text-detection call was seventeen minutes of reasoning that then used up
// the token budget before any JSON appeared. Starting the answer skips the reasoning
// entirely. It has to commit the model to the shape, too — a bare `{"regions":[` was
// closed straight away as an empty list. The instruct build gets the bare prompt, which
// is how it was measured.
//
// node:http rather than fetch, and streamed: the model is silent for as long as it takes
// to read the images (tens of seconds), then slow to write. fetch gives up after five
// minutes without headers, and the dev server drops an outbound request that sits idle;
// a streamed request on a socket with no timeout has neither problem.
export type OllamaStats = {
  input_tokens: number;   // prompt + images, as the model counted them
  output_tokens: number;
  load_ms: number;        // getting the model into memory (near zero when already loaded)
  read_ms: number;        // taking in the prompt and images
  write_ms: number;       // writing the answer
};

export function ollamaChat(opts: {
  model: LocalModel; prompt: string; images: string[]; prefill: string; maxTokens: number;
}): Promise<{ text: string; stats: OllamaStats | null }> {
  const prefill = LOCAL_MODELS[opts.model].prefill ? opts.prefill : '';
  const payload = JSON.stringify({
    model: opts.model,
    stream: true,
    think: false,
    options: { temperature: 0, num_ctx: NUM_CTX, num_predict: opts.maxTokens },
    messages: [
      { role: 'user', content: opts.prompt, images: opts.images },
      ...(prefill ? [{ role: 'assistant', content: prefill }] : []),
    ],
  });

  return new Promise<{ text: string; stats: OllamaStats | null }>((resolve, reject) => {
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
        let stats: OllamaStats | null = null;
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
                prompt_eval_count?: number; eval_count?: number;
                load_duration?: number; prompt_eval_duration?: number; eval_duration?: number;
              };
              if (frame.error) failure = frame.error;
              text += frame.message?.content ?? '';   // `thinking` deltas are deliberately dropped
              if (frame.done && frame.done_reason === 'length') truncated = true;
              // The closing frame carries the same figures `ollama run --verbose` prints,
              // durations in nanoseconds.
              if (frame.done) {
                const ms = (ns?: number) => Math.round((ns ?? 0) / 1e6);
                stats = {
                  input_tokens: frame.prompt_eval_count ?? 0, output_tokens: frame.eval_count ?? 0,
                  load_ms: ms(frame.load_duration), read_ms: ms(frame.prompt_eval_duration),
                  write_ms: ms(frame.eval_duration),
                };
              }
            } catch { /* a malformed frame is not worth failing the answer over */ }
          }
        });
        res.on('error', reject);
        res.on('end', () => {
          if (failure) {
            // Ollama's own wording for a model that was never pulled is accurate but
            // doesn't say what to do about it.
            reject(new Error(/not found/i.test(failure)
              ? `${opts.model} is not installed — run: ollama pull ${opts.model}`
              : `Ollama: ${failure}`));
          } else if (truncated) {
            reject(new Error(`${opts.model} hit the ${opts.maxTokens}-token limit before finishing its answer`));
          } else {
            resolve({ text: prefill + text, stats });
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
