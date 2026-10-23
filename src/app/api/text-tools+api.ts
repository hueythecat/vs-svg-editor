// The "Python text service" Text detection choice. Forwards the artwork to the svg-text
// service (assets/ai-tools/INTEGRATION.md), which does its own geometry, asks qwen3-vl on
// the vLLM server what each piece says, matches a Google Font per item and hands back an
// editable SVG. Proxied rather than called from the browser so the service needs no CORS
// setup and is never exposed to the internet on its own port.
//
// SVGTEXT_URL points at the service; it defaults to one on this machine.
import { isCrossSite } from '@/lib/ai-guard';
import { IS_PRODUCTION_UI } from '@/lib/env';

const SVGTEXT_URL = (process.env.SVGTEXT_URL || 'http://127.0.0.1:8010').replace(/\/$/, '');
// The service quotes 5–15s per SVG; past this the model is stuck, not thinking.
const TIMEOUT_MS = 90_000;

const fail = (status: number, message: string) => Response.json({ error: { message } }, { status });

// The model server the service says it uses, as reachable from here. The service reports
// it from its own side, so a loopback address in it means the service's machine — which
// is only this one when SVGTEXT_URL is loopback too.
function modelServerUrl(reported: string): string {
  try {
    const url = new URL(reported);
    const service = new URL(SVGTEXT_URL);
    const loopback = (h: string) => h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
    if (loopback(url.hostname) && !loopback(service.hostname)) url.hostname = service.hostname;
    return url.toString().replace(/\/$/, '');
  } catch {
    return reported;
  }
}

// Whether the service is up, and whether the model server behind it is too — the service's
// own /health says ok with no model server at all, and then fails every /detect with a
// 502. Nothing is sent to a model: the model server is only asked what it serves.
export async function GET(): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store' };
  let health: { model?: unknown; server?: unknown };
  try {
    const res = await fetch(`${SVGTEXT_URL}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return Response.json({ host: SVGTEXT_URL, up: false }, { headers });
    health = await res.json().catch(() => ({}));
  } catch {
    return Response.json({ host: SVGTEXT_URL, up: false }, { headers });
  }
  const model = typeof health.model === 'string' ? health.model : null;
  if (typeof health.server !== 'string') {
    return Response.json({ host: SVGTEXT_URL, up: true, model, modelServer: null, modelUp: null }, { headers });
  }
  const modelServer = modelServerUrl(health.server);
  let modelUp = false;
  try {
    const res = await fetch(`${modelServer}/v1/models`, { signal: AbortSignal.timeout(3000) });
    const body = (await res.json().catch(() => null)) as { data?: { id?: unknown }[] } | null;
    const served = (body?.data ?? []).map((m) => m.id);
    modelUp = res.ok && (model === null || served.includes(model));
  } catch { /* not answering: modelUp stays false */ }
  return Response.json({ host: SVGTEXT_URL, up: true, model, modelServer, modelUp }, { headers });
}

export async function POST(request: Request): Promise<Response> {
  if (isCrossSite(request)) return fail(403, 'Cross-site requests are not accepted');
  // ?op=design-fonts asks the service's /design-fonts instead: the font suggestions for the
  // design as a whole, a short model call of their own that runs alongside /detect.
  const params = new URL(request.url).searchParams;
  const op = params.get('op') === 'design-fonts' ? 'design-fonts' : 'detect';
  // ?fresh=1 makes /detect skip the service's cache and re-run the model. The dev build
  // asks for it when its own AI-response cache is switched off; a production build never
  // passes it on, so the public endpoint can't be made to bypass the cache.
  const fresh = op === 'detect' && params.get('fresh') === '1' && !IS_PRODUCTION_UI;
  // ?outlines= names the outlines /detect stored for this artwork (its result's `outlines`),
  // so /design-fonts can retry the guessed fonts against its suggestions. Passed on only in
  // the shape the service gives it.
  const outlines = op === 'design-fonts' ? params.get('outlines') ?? '' : '';
  // ?local=1 asks for the service's local model instead of Claude (when Claude is its provider).
  const parts = [
    fresh && 'fresh=1',
    /^(\d{5,20}|file)_[0-9a-f]{12}$/.test(outlines) && `outlines=${outlines}`,
    params.get('local') === '1' && 'local=1',
  ].filter(Boolean);
  const query = parts.length ? `?${parts.join('&')}` : '';

  let svg: unknown, filename: unknown;
  try {
    ({ svg, filename } = (await request.json()) as { svg?: unknown; filename?: unknown });
  } catch {
    return fail(400, 'Expected a JSON body');
  }
  if (typeof svg !== 'string' || !svg.includes('<svg')) return fail(415, "That file isn't a valid SVG");

  const form = new FormData();
  form.append('file', new Blob([svg], { type: 'image/svg+xml' }),
    typeof filename === 'string' && filename ? filename : 'design.svg');

  const started = Date.now();
  console.log(`[text-tools] ${SVGTEXT_URL}/${op}${query}: ${svg.length} chars`);
  let res: Response;
  try {
    res = await fetch(`${SVGTEXT_URL}/${op}${query}`, {
      method: 'POST', body: form, signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    console.log(`[text-tools] ${timedOut ? 'timed out' : 'unreachable'}:`, err instanceof Error ? err.message : err);
    return timedOut
      ? fail(504, 'The text service took too long to answer')
      : fail(502, `The text service at ${SVGTEXT_URL} is not answering`);
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { detail?: unknown };
    const detail = typeof body.detail === 'string' ? body.detail : null;
    console.log(`[text-tools] ${res.status}:`, detail ?? '(no detail)');
    return fail(res.status,
      res.status === 502 ? "The text service can't reach the vision model" :
      res.status === 415 ? (detail?.includes('entity')
        ? 'SVGs that declare XML entities are not accepted'
        : "That file isn't a valid SVG") :
      // Either the file is over 20 MB, or it has more outline pieces than the service will
      // take on (SVGTEXT_MAX_PIECES) — the detail says which.
      res.status === 413 ? (detail && detail !== 'SVG too large'
        ? `The SVG is too complex for the text service (${detail})`
        : 'The SVG is too large for the text service (20 MB max)') :
      detail ?? `Text service error ${res.status}`);
  }

  const result = await res.text();
  // X-Cache is the service's own: "hit" served a stored result, "miss" ran the model.
  console.log(`[text-tools] answered in ${((Date.now() - started) / 1000).toFixed(1)}s, ${result.length} chars, ` +
    `cache ${res.headers.get('x-cache') ?? 'n/a'}`);
  // X-Cache passed on so the dev stats can say a result was stored, not a fresh model run.
  return new Response(result, { headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Cache': res.headers.get('x-cache') ?? 'n/a',
  } });
}
