// The "Local" entries in the AI tools Model dropdown, for every AI action that
// goes through callLlmVision. Same contract as /api/claude and /api/kimi — the browser
// POSTs an Anthropic Messages body and reads `data.content[0].text` — answered by an
// model that isn't billed per call instead — the vLLM server in AWS if it can be reached,
// else Ollama on this machine (src/lib/ollama.ts).
//
// The text-detection call has its own route (/api/svg-text), which takes the same model
// id and branches to the local model itself.
import { guardAiRequest, isCrossSite } from '@/lib/ai-guard';
import { isLocalModel, localChat, localStatus, respondWhenDone } from '@/lib/ollama';

// Every prompt sent here asks for one JSON object and nothing else, so the answer can be
// started for the model — which is what stops it reasoning for minutes first.
const PREFILL = '{';

// Whether the first-choice server is up and which local models it would answer — the dev
// rail's status line. Nothing is sent to a model.
export async function GET(): Promise<Response> {
  return Response.json(await localStatus(), { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request): Promise<Response> {
  if (isCrossSite(request)) {
    return Response.json({ error: { message: 'Cross-site requests are not accepted' } }, { status: 403 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: { message: 'Expected a JSON body' } }, { status: 400 });
  }
  const model = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { model?: unknown }).model : undefined;
  if (!isLocalModel(model)) {
    return Response.json({ error: { message: 'model must be one of the local models' } }, { status: 400 });
  }

  // Held to the same shape as the paid routes — size caps, one user turn, no system
  // prompt — so a body that works here works there. The guard only knows Claude ids, and
  // the model is pinned above anyway, so it is checked under one of those.
  const guarded = guardAiRequest({ ...(raw as object), model: 'claude-sonnet-5' });
  if (!guarded.ok) {
    console.log('[local] rejected:', guarded.message);
    return Response.json({ error: { message: guarded.message } }, { status: 400 });
  }
  const { max_tokens, messages } = guarded.body;
  const blocks = messages[0].content;
  const prompt = blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
  const images = blocks.flatMap((b) => (b.type === 'image' ? [b.source.data] : []));

  const started = Date.now();
  console.log(`[local] ${model}: ${prompt.length} prompt chars, ${images.length} image(s)`);
  return respondWhenDone(
    localChat({ model, prompt, images, prefill: PREFILL, maxTokens: max_tokens }).then(({ text, stats, backend }) => {
      console.log(`[local] ${backend} answered in ${((Date.now() - started) / 1000).toFixed(1)}s, ${text.length} chars`);
      return { content: [{ type: 'text', text }], model, usage: stats };
    }),
  );
}
