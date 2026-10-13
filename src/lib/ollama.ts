/// <reference types="node" />
// Server side of the "Local" entries in the AI tools Model dropdown: one vision turn to a
// model that costs nothing per call, in place of the paid API — a vLLM server in AWS when
// it can be reached and is serving the model, otherwise Ollama on this machine.
//
// The vLLM server is a GPU machine of ours and answers in production like the paid
// routes do. Ollama is dev tooling only: measured on an M2 Air against Sonnet 5 on the
// text-detection call, qwen3-vl:8b takes one to two minutes where Sonnet takes under ten
// seconds, reads simple artwork correctly, loses track of which box is which on busy
// artwork, and answers "Montserrat" for every font. It exists so a pass can be exercised
// with no tunnel open, and it is never tried on a server.
import fs from 'node:fs';
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

// First choice: a vLLM server (OpenAI-style API) on a GPU machine in AWS, which answers
// far faster than the laptop does. From a laptop it is reached through an ssh tunnel on
// port 9006; the EC2 instance the site is deployed on sits in the same network and
// calls it directly. It is asked before every call whether it is up and serving the
// model, so opening or closing the tunnel takes effect on the next call with no restart.
// On a laptop anything short of a yes goes to Ollama as before.
//
// EC2 says what it is in the machine's DMI strings (Nitro) or its hypervisor uuid (Xen),
// so being there is read off the machine rather than set in .env, where forgetting it
// would leave the server knocking on a tunnel that only exists on a laptop.
const onEc2 = (() => {
  const read = (path: string) => { try { return fs.readFileSync(path, 'utf8'); } catch { return ''; } };
  return /amazon ec2/i.test(read('/sys/devices/virtual/dmi/id/sys_vendor'))
    || /^ec2/i.test(read('/sys/hypervisor/uuid'));
})();
const VLLM_URL = new URL(
  process.env.LOCAL_LLM_HOST || (onEc2 ? 'http://172.30.3.230:8000' : 'http://127.0.0.1:9006'),
);
const VLLM_PROBE_MS = 1500;

// Prompt + two 1800px renders is about 4,300 tokens for this model, and the answer is
// capped by the caller; this leaves room for both without the memory a larger window
// would take on a laptop.
const NUM_CTX = 16384;

// Whether a call the vLLM server can't take may go to Ollama instead. Only under the dev
// server on a laptop: a deployed build has no Ollama beside it, and nothing there should
// be able to reach one by asking. There the call fails and says the server is down.
const OLLAMA_FALLBACK = process.env.NODE_ENV !== 'production' && !onEc2;

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
export type LocalStats = {
  input_tokens: number;   // prompt + images, as the model counted them
  output_tokens: number;
  load_ms: number;        // getting the model into memory (near zero when already loaded)
  read_ms: number;        // taking in the prompt and images
  write_ms: number;       // writing the answer
};
type ChatOpts = { model: LocalModel; prompt: string; images: string[]; prefill: string; maxTokens: number };
type ChatResult = { text: string; stats: LocalStats | null };

export async function localChat(opts: ChatOpts): Promise<ChatResult & { backend: 'vllm' | 'ollama' }> {
  const prefill = LOCAL_MODELS[opts.model].prefill ? opts.prefill : '';
  const served = await vllmServes(opts.model);
  if (served) return { ...(await vllmChat(served, opts, prefill)), backend: 'vllm' };
  if (!OLLAMA_FALLBACK) throw new Error(`The AWS model server at ${VLLM_URL.host} is not answering for ${opts.model}`);
  return { ...(await ollamaChat(opts, prefill)), backend: 'ollama' };
}

// POSTs `payload` and hands back the response a line at a time, resolving with the status
// once it ends.
//
// node:http rather than fetch, and streamed: the model is silent for as long as it takes
// to read the images (tens of seconds), then slow to write. fetch gives up after five
// minutes without headers, and the dev server drops an outbound request that sits idle;
// a streamed request on a socket with no timeout has neither problem.
function postLines(
  to: { host: string; port: string | number; path: string }, payload: string, onLine: (line: string) => void,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const req = http.request(
      {
        ...to, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';   // keep the trailing partial line
          for (const line of lines) if (line.trim()) onLine(line);
        });
        res.on('error', reject);
        res.on('end', () => {
          if (buffer.trim()) onLine(buffer);
          resolve(res.statusCode ?? 0);
        });
      },
    );
    req.setTimeout(0);
    req.on('error', reject);
    req.end(payload);
  });
}

// The ids the vLLM server is serving, or null when it isn't there to ask.
function vllmModels(): Promise<string[] | null> {
  return new Promise<string[] | null>((resolve) => {
    const req = http.get(
      { host: VLLM_URL.hostname, port: VLLM_URL.port || 80, path: '/v1/models', timeout: VLLM_PROBE_MS },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { body += chunk; });
        res.on('error', () => resolve(null));
        res.on('end', () => {
          try {
            const { data } = JSON.parse(body) as { data?: { id?: string }[] };
            resolve(Array.isArray(data) ? data.flatMap((m) => (typeof m.id === 'string' ? [m.id] : [])) : null);
          } catch { resolve(null); }
        });
      },
    );
    // A tunnel whose far end has gone still accepts the connection, then says nothing.
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

// vLLM names can't hold Ollama's colon, so `qwen3-vl:8b-instruct` is served as
// `qwen3-vl-8b-instruct`.
const vllmId = (model: LocalModel) => model.replace(':', '-');

// The id the vLLM server knows `model` by, or null when it is down or isn't serving it.
async function vllmServes(model: LocalModel): Promise<string | null> {
  const id = vllmId(model);
  return (await vllmModels())?.includes(id) ? id : null;
}

// Where a call made right now would go, for the dev rail: whether the vLLM server
// answered, which of the dropdown's models it would take, and whether the rest have
// Ollama to go to. Ollama itself is not asked.
export type LocalStatus = { host: string; up: boolean; models: LocalModel[]; fallback: boolean };
export async function localStatus(): Promise<LocalStatus> {
  const served = await vllmModels();
  return {
    host: VLLM_URL.host,
    up: served !== null,
    models: (Object.keys(LOCAL_MODELS) as LocalModel[]).filter((m) => served?.includes(vllmId(m))),
    fallback: OLLAMA_FALLBACK,
  };
}

async function vllmChat(served: string, opts: ChatOpts, prefill: string): Promise<ChatResult> {
  const mime = (data: string) =>
    data.startsWith('/9j/') ? 'image/jpeg' : data.startsWith('UklGR') ? 'image/webp' : 'image/png';
  const payload = JSON.stringify({
    model: served,
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0,
    max_tokens: opts.maxTokens,
    messages: [
      {
        role: 'user',
        // Images first, which is where Ollama's template puts them.
        content: [
          ...opts.images.map((data) => ({ type: 'image_url', image_url: { url: `data:${mime(data)};base64,${data}` } })),
          { type: 'text', text: opts.prompt },
        ],
      },
      ...(prefill ? [{ role: 'assistant', content: prefill }] : []),
    ],
    ...(prefill ? { continue_final_message: true, add_generation_prompt: false } : {}),
  });

  let text = '';
  let raw = '';   // whatever arrived outside the event stream: an error body
  let truncated = false;
  let usage: { prompt_tokens?: number; completion_tokens?: number } | null = null;
  const sent = Date.now();
  let firstToken = 0;
  let status: number;
  try {
    status = await postLines(
      { host: VLLM_URL.hostname, port: VLLM_URL.port || 80, path: '/v1/chat/completions' }, payload,
      (line) => {
        if (!line.startsWith('data:')) { raw += line; return; }
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        try {
          const frame = JSON.parse(data) as {
            choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
            usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
          };
          const delta = frame.choices?.[0]?.delta?.content ?? '';
          if (delta && !firstToken) firstToken = Date.now();
          text += delta;
          if (frame.choices?.[0]?.finish_reason === 'length') truncated = true;
          if (frame.usage) usage = frame.usage;
        } catch { /* a malformed frame is not worth failing the answer over */ }
      },
    );
  } catch (err) {
    throw new Error(`vLLM request to ${VLLM_URL.host} failed: ${err instanceof Error ? err.message : err}`);
  }
  if (status !== 200) {
    let message = raw.slice(0, 300);
    try {
      const body = JSON.parse(raw) as { message?: string; error?: { message?: string } };
      message = body.error?.message ?? body.message ?? message;
    } catch { /* not JSON: show it as it came */ }
    throw new Error(`vLLM (${status}): ${message}`);
  }
  if (truncated) throw new Error(`${opts.model} hit the ${opts.maxTokens}-token limit before finishing its answer`);
  // vLLM reports token counts but no timings, so those are the clock's: up to the first
  // token is reading, the rest is writing. The model is always loaded.
  const done = Date.now();
  const u = usage as { prompt_tokens?: number; completion_tokens?: number } | null;
  return {
    text: prefill + text,
    stats: u && {
      input_tokens: u.prompt_tokens ?? 0, output_tokens: u.completion_tokens ?? 0,
      load_ms: 0, read_ms: (firstToken || done) - sent, write_ms: firstToken ? done - firstToken : 0,
    },
  };
}

async function ollamaChat(opts: ChatOpts, prefill: string): Promise<ChatResult> {
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

  let text = '';
  let failure: string | null = null;
  let truncated = false;
  let stats: LocalStats | null = null;
  try {
    await postLines(
      { host: OLLAMA_URL.hostname, port: OLLAMA_URL.port || 11434, path: '/api/chat' }, payload,
      (line) => {
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
      },
    );
  } catch (err) {
    throw new Error((err as NodeJS.ErrnoException).code === 'ECONNREFUSED'
      ? `Ollama is not running at ${OLLAMA_URL.host} — start it, then try again`
      : `Ollama request failed: ${err instanceof Error ? err.message : err}`);
  }
  // `failure` is assigned in the callback, which the compiler can't see from here.
  const failed = failure as string | null;
  if (failed) {
    // Ollama's own wording for a model that was never pulled is accurate but doesn't say
    // what to do about it.
    throw new Error(/not found/i.test(failed)
      ? `${opts.model} is not installed — run: ollama pull ${opts.model}`
      : `Ollama: ${failed}`);
  }
  if (truncated) throw new Error(`${opts.model} hit the ${opts.maxTokens}-token limit before finishing its answer`);
  return { text: prefill + text, stats };
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
