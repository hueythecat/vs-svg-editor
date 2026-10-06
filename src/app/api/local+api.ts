// Dev-only: the "Local" entry in the AI tools Model dropdown, for every AI action that
// goes through callLlmVision. Same contract as /api/claude and /api/kimi — the browser
// POSTs an Anthropic Messages body and reads `data.content[0].text` — answered by an
// Ollama model on this machine instead (src/lib/ollama.ts), so nothing is billed.
//
// The text-detection call has its own route (/api/svg-text), which takes the same model
// id and branches to Ollama itself.
import { guardAiRequest, isCrossSite } from '@/lib/ai-guard';
import { LOCAL_MODEL, localModelEnabled, ollamaChat, respondWhenDone } from '@/lib/ollama';

// Every prompt sent here asks for one JSON object and nothing else, so the answer can be
// started for the model — which is what stops it reasoning for minutes first.
const PREFILL = '{';

export async function POST(request: Request): Promise<Response> {
  if (!localModelEnabled()) return new Response(null, { status: 404 });
  if (isCrossSite(request)) {
    return Response.json({ error: { message: 'Cross-site requests are not accepted' } }, { status: 403 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: { message: 'Expected a JSON body' } }, { status: 400 });
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (raw as { model?: unknown }).model !== LOCAL_MODEL) {
    return Response.json({ error: { message: `model must be ${LOCAL_MODEL}` } }, { status: 400 });
  }

  // Held to the same shape as the paid routes — size caps, one user turn, no system
  // prompt — so a body that works here works there. The guard only knows Claude ids, and
  // the model is pinned above anyway, so it is checked under one of those.
  const guarded = guardAiRequest({ ...raw, model: 'claude-sonnet-5' });
  if (!guarded.ok) {
    console.log('[local] rejected:', guarded.message);
    return Response.json({ error: { message: guarded.message } }, { status: 400 });
  }
  const { max_tokens, messages } = guarded.body;
  const blocks = messages[0].content;
  const prompt = blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
  const images = blocks.flatMap((b) => (b.type === 'image' ? [b.source.data] : []));

  const started = Date.now();
  console.log(`[local] ${LOCAL_MODEL}: ${prompt.length} prompt chars, ${images.length} image(s)`);
  return respondWhenDone(
    ollamaChat({ prompt, images, prefill: PREFILL, maxTokens: max_tokens }).then(({ text, stats }) => {
      console.log(`[local] answered in ${((Date.now() - started) / 1000).toFixed(1)}s, ${text.length} chars`);
      return { content: [{ type: 'text', text }], model: LOCAL_MODEL, usage: stats };
    }),
  );
}
