// Server side of the "DOM regions" text detection (src/lib/svg-text-detect.ts).
//
// The browser has already found candidate text regions by measuring the rendered SVG —
// live <text> elements, and clusters of outlined glyph paths — and numbered them. It
// posts two renders (clean, and annotated with a numbered magenta box per region) plus
// a short brief per region. This route asks Claude to read each numbered region and
// returns { regions: [{ region, is_text, text_content, role, words, ... }] } — the model
// half of the reference format; the client adds the DOM half (layer, xpaths, bbox, …).
//
// Unlike /api/claude, the caller never supplies a prompt: the upstream body is built
// here from a fixed prompt, a capped max_tokens and the validated inputs. The only
// choices left to the client are the model, from the same allowlist as /api/claude, and
// the effort; both default to Sonnet 5 at low effort.
// Spend is bounded in server/index.mjs by the same throttle, budget and concurrency cap.
import { base64Bytes, isAllowedModel, isCrossSite, MAX_IMAGE_BYTES } from '@/lib/ai-guard';

const DEFAULT_MODEL = 'claude-sonnet-5';
const DEFAULT_EFFORT = 'low';
const MAX_TOKENS = 8192;

// Regions come from clustering glyphs, so a busy pattern could produce hundreds. Far
// more than any real artwork's text, and it keeps the brief (and the answer) bounded.
const MAX_REGIONS = 150;
const MAX_SVG_TEXT = 2000;

type BriefRegion = {
  region: number; source: string; fill: string; glyph_paths?: number; word_count?: number; svg_text?: string;
};

const bad = (message: string, status = 400) => Response.json({ error: { message } }, { status });

const PROMPT = (brief: BriefRegion[]) => `You are given two renders of the same vector artwork.

Image 1 is the artwork as-is. Image 2 is the same artwork with numbered magenta boxes drawn around candidate regions. The boxes and numbers are annotations, not part of the artwork.

The candidates were found by measuring the SVG, not by reading it:
- "live_text": a real <text> element; svg_text is its content in the file.
- "outlined_paths": same-coloured shapes laid out like glyphs. It may be lettering converted to outlines, or an icon, decoration or texture.
glyph_paths is how many shapes the region holds.

Candidate regions:
${JSON.stringify(brief)}

For EVERY numbered region, look at it in both images and describe it. Return JSON only, no markdown, in exactly this shape:
{"regions":[{"region":1,"is_text":true,"text_content":"…","font_weight":"light|regular|medium|bold|black","italic":false,"font_category":"sans|serif|script|display|mono|handwritten","font_guess":"short description of the typeface, e.g. Geometric sans (Gotham / Montserrat style)","effects":["…"],"role":"logo|headline|subheading|tagline|body|placeholder|decorative","replaceable":true,"confidence":0.0,"words":[{"text_content":"…","font_weight":"…"}]}]}

Rules:
- One entry per numbered region, using its number. Do not add regions that are not boxed.
- A letter or monogram used as a logo mark — however it is styled, extruded or drawn — IS text: is_text true, text_content the letter(s), role "logo". Only pictures and symbols (icons, arrows, ornaments) are not text.
- text_content is exactly what the region reads, with its case. When is_text is false, text_content is "" and add "note" naming what the region is (e.g. "phone handset icon"); it still gets role (usually "decorative"), replaceable and confidence; omit italic, font_guess, effects and words.
- For live_text, trust the render over svg_text if they disagree.
- effects lists visible styling: all caps, 3D extrusion, outline, shadow, gradient, arc, mixed weights, and so on; [] when plain.
- role "placeholder" is template filler text (lorem ipsum, 1234-5678, example emails/URLs); replaceable is whether a user would want to retype it — true for names, contact details, placeholders and logo lettering (people swap in their own initial or brand), false for icons and ornaments.
- words: include ONLY when the words of the region differ in weight or style — one entry per word, in reading order. Otherwise omit it. When words is present, the region's own font_weight is the first word's.
- confidence is 0–1 for is_text and the reading together.`;

// The model sometimes wraps its JSON in a ```json fence despite being told not to.
const extractJson = (raw: string): string => {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = (fenced ? fenced[1] : raw).trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
};

const validImage = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(v.slice(-64));

export async function POST(request: Request): Promise<Response> {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) return bad('CLAUDE_API_KEY is not set on the server', 500);
  if (isCrossSite(request)) return bad('Cross-site requests are not accepted', 403);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return bad('Expected a JSON body');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('Expected a JSON object body');
  const body = raw as Record<string, unknown>;

  const model = body.model ?? DEFAULT_MODEL;
  if (!isAllowedModel(model)) return bad('Unsupported model');
  // How hard the model thinks (output_config.effort). Low matched Opus's answers on the
  // reference file with Sonnet 5 at about half the cost — see the model benchmark.
  const effort = body.effort ?? DEFAULT_EFFORT;
  if (effort !== 'low' && effort !== 'medium' && effort !== 'high') {
    return bad('effort must be low, medium or high');
  }

  for (const key of ['clean', 'annotated'] as const) {
    const img = body[key];
    if (!validImage(img)) return bad(`${key} must be a base64 PNG`);
    if (base64Bytes(img) > MAX_IMAGE_BYTES) return bad(`${key} exceeds ${MAX_IMAGE_BYTES / (1024 * 1024)}MB`);
  }

  // Rebuilt field by field, so nothing the caller adds rides into the prompt unexamined.
  if (!Array.isArray(body.regions) || body.regions.length === 0) return bad('regions must be a non-empty array');
  if (body.regions.length > MAX_REGIONS) return bad(`At most ${MAX_REGIONS} regions`);
  const brief: BriefRegion[] = [];
  for (const entry of body.regions) {
    const r = entry as Record<string, unknown>;
    if (!r || typeof r.region !== 'number' || !Number.isInteger(r.region)) return bad('Each region needs an integer region number');
    if (r.source !== 'live_text' && r.source !== 'outlined_paths') return bad('Unknown region source');
    if (typeof r.fill !== 'string' || r.fill.length > 64) return bad('Each region needs a fill');
    const out: BriefRegion = { region: r.region, source: r.source, fill: r.fill };
    for (const key of ['glyph_paths', 'word_count'] as const) {
      const v = r[key];
      if (v === undefined) continue;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 10_000) return bad(`${key} must be a count`);
      out[key] = v;
    }
    if (r.svg_text !== undefined) {
      if (typeof r.svg_text !== 'string' || r.svg_text.length > MAX_SVG_TEXT) return bad('svg_text is too long');
      out.svg_text = r.svg_text;
    }
    brief.push(out);
  }

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      ...(effort ? { output_config: { effort } } : {}),
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: body.clean } },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: body.annotated } },
          { type: 'text', text: PROMPT(brief) },
        ],
      }],
    }),
  });

  const text = await upstream.text();
  if (!upstream.ok) {
    // Anthropic's error body is already { error: { message } }; pass it through.
    return new Response(text, { status: upstream.status, headers: { 'Content-Type': 'application/json' } });
  }

  const data = JSON.parse(text) as {
    model?: string; content?: Array<{ type: string; text?: string }>; stop_reason?: string; usage?: unknown;
  };
  const answer = data.content?.find((b) => b.type === 'text')?.text ?? '';
  try {
    const parsed = JSON.parse(extractJson(answer)) as { regions?: unknown };
    if (!Array.isArray(parsed.regions)) throw new Error('no regions array');
    // usage alongside the regions so a debug run can price itself; the client ignores it.
    return Response.json({ regions: parsed.regions, model: data.model, usage: data.usage });
  } catch (err) {
    console.log('[svg-text] unparseable answer:', data.stop_reason, answer.slice(0, 500));
    return bad(`Model returned unparseable JSON (${(err as Error).message}, stop_reason ${data.stop_reason})`, 502);
  }
}
