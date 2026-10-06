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
//
// The one exception to "asks Claude": the dev-only local model (LOCAL_MODEL, the "Local"
// entry in the AI tools Model dropdown) is answered by Ollama on this machine instead,
// from the same prompt and through the same parsing — see src/lib/ollama.ts.
// Spend is bounded in server/index.mjs by the same throttle, budget and concurrency cap.
import { base64Bytes, isAllowedModel, isCrossSite, MAX_IMAGE_BYTES } from '@/lib/ai-guard';
import { onlyGoogleFonts } from '@/lib/google-fonts';
import { LOCAL_MODEL, localModelEnabled, ollamaChat, respondWhenDone } from '@/lib/ollama';

const DEFAULT_MODEL = 'claude-sonnet-5';
const DEFAULT_EFFORT = 'low';
const MAX_TOKENS = 8192;

// Regions come from clustering glyphs, so a busy pattern could produce hundreds. Far
// more than any real artwork's text, and it keeps the brief (and the answer) bounded.
const MAX_REGIONS = 150;
const MAX_SVG_TEXT = 2000;
// Image-level font suggestions asked for alongside the regions. The client sends
// FONT_SUGGESTION_LIMIT; this bounds what any caller can make the answer carry.
const MAX_FONT_SUGGESTIONS = 20;
// The local model is asked for this many more than the caller wants. It names families
// Google doesn't serve (Avenir Next, Gotham, Arial…) often enough that, once those are
// filtered out, asking for exactly ten leaves seven or eight.
const LOCAL_FONT_SPARES = 5;

type BriefRegion = {
  region: number; source: string; fill: string; glyph_paths?: number; subpaths?: number; word_count?: number; svg_text?: string;
};

const bad = (message: string, status = 400) => Response.json({ error: { message } }, { status });

const PROMPT = (brief: BriefRegion[], fontCount: number) => `You are given two renders of the same vector artwork.

Image 1 is the artwork as-is. Image 2 is the same artwork with numbered magenta boxes drawn around candidate regions. The boxes and numbers are annotations, not part of the artwork.

The candidates were found by measuring the SVG, not by reading it:
- "live_text": a real <text> element; svg_text is its content in the file.
- "outlined_paths": same-coloured shapes laid out like glyphs. It may be lettering converted to outlines, or an icon, decoration or texture.
glyph_paths is how many shapes the region holds, and subpaths how many separate outlines those shapes draw. One shape can hold a whole word or several lines of lettering, so glyph_paths 1 does not mean a single letter — read what is inside the box.

Candidate regions:
${JSON.stringify(brief)}

For EVERY numbered region, look at it in both images and describe it. Return JSON only, no markdown, in exactly this shape:
{"regions":[{"region":1,"is_text":true,"text_content":"…","font_weight":"light|regular|medium|bold|black","italic":false,"font_category":"sans|serif|script|display|mono|handwritten","font_guess":"short description of the typeface, e.g. Geometric sans (Gotham / Montserrat style)","google_font":"Montserrat","google_font_weight":700,"color":"#1a2b3c","effects":["…"],"role":"logo|headline|subheading|tagline|body|placeholder|decorative","replaceable":true,"confidence":0.0,"words":[{"text_content":"…","font_weight":"…"}]}]${fontCount > 0 ? ',"fonts":["…"]' : ''}}

Rules:
- One entry per numbered region, using its number. Do not add regions that are not boxed.
- A letter or monogram used as a logo mark — however it is styled, extruded or drawn — IS text: is_text true, text_content the letter(s), role "logo". Only pictures and symbols (icons, arrows, ornaments) are not text.
- text_content is exactly what the region reads, with its case.
- A region that is NOT text gets the short form and nothing else: {"region":7,"is_text":false,"note":"phone icon"} — note names it in at most three words. Artwork can have a hundred such regions, so keep them to that.
- google_font is the Google Fonts family (fonts.google.com) whose letterforms are the nearest match to the region's lettering — its exact family name as Google lists it, never a commercial font. google_font_weight is the nearest weight (100–900) that family actually offers.
- color is the hex colour of the letters' main face — the front face of extruded or shadowed lettering, not its side, shadow or outline.
- For live_text, trust the render over svg_text if they disagree.
- effects lists visible styling: all caps, 3D extrusion, outline, shadow, gradient, arc, mixed weights, and so on; [] when plain.
- role "placeholder" is template filler text (lorem ipsum, 1234-5678, example emails/URLs); replaceable is whether a user would want to retype it — true for names, contact details, placeholders and logo lettering (people swap in their own initial or brand), false for icons and ornaments.
- words: include ONLY when the words of the region differ in weight or style — one entry per word, in reading order. Otherwise omit it. When words is present, the region's own font_weight is the first word's.
- confidence is 0–1 for is_text and the reading together.${fontCount > 0 ? `
- fonts: ${fontCount} Google Fonts families (exact names as Google lists them) that suit the style, mood and colour palette of the whole design — alternatives someone customising it might switch the text to. Names only, no duplicates.` : ''}`;

// The model sometimes wraps its JSON in a ```json fence despite being told not to.
const extractJson = (raw: string): string => {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = (fenced ? fenced[1] : raw).trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
};

// The model's answer as the two things the client wants from it, or why it couldn't be
// read. Shared by both upstreams, so a region means the same whichever model wrote it.
const readAnswer = (answer: string): { regions: unknown[]; fonts: string[] } | { error: string } => {
  try {
    const parsed = JSON.parse(extractJson(answer)) as { regions?: unknown; fonts?: unknown };
    if (!Array.isArray(parsed.regions)) throw new Error('no regions array');
    const fonts = Array.isArray(parsed.fonts)
      ? [...new Set(parsed.fonts.filter((f): f is string => typeof f === 'string' && f.trim() !== '').map((f) => f.trim()))]
      : [];
    return { regions: parsed.regions, fonts };
  } catch (err) {
    return { error: (err as Error).message };
  }
};

// The image-level suggestions as they are handed back: only families Google actually
// serves, and no more than were asked for — the model is not bound by the number in the
// prompt, and not by "Google Fonts" either.
const offeredFonts = async (fonts: string[], fontCount: number): Promise<string[]> =>
  fontCount > 0 ? (await onlyGoogleFonts(fonts)).slice(0, fontCount) : [];

const validImage = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(v.slice(-64));

export async function POST(request: Request): Promise<Response> {
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
  const local = model === LOCAL_MODEL && localModelEnabled();
  if (!local && !isAllowedModel(model)) return bad('Unsupported model');
  // How hard the model thinks (output_config.effort). Low matched Opus's answers on the
  // reference file with Sonnet 5 at about half the cost — see the model benchmark.
  const effort = body.effort ?? DEFAULT_EFFORT;
  if (effort !== 'low' && effort !== 'medium' && effort !== 'high') {
    return bad('effort must be low, medium or high');
  }

  // How many image-level Google Font suggestions to ask for; absent asks for none.
  const fontCount = body.font_suggestions ?? 0;
  if (typeof fontCount !== 'number' || !Number.isInteger(fontCount) || fontCount < 0 || fontCount > MAX_FONT_SUGGESTIONS) {
    return bad(`font_suggestions must be a whole number from 0 to ${MAX_FONT_SUGGESTIONS}`);
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
    for (const key of ['glyph_paths', 'subpaths', 'word_count'] as const) {
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

  if (local) {
    // The answer is started for the model, down to the first region's number: that is
    // what stops this build reasoning for minutes before it writes anything, and a
    // shorter start (`{"regions":[`) gets closed straight away as an empty list.
    const prefill = `{"regions":[{"region":${brief[0].region},"is_text":`;
    const started = Date.now();
    console.log(`[svg-text] ${LOCAL_MODEL} (local): ${brief.length} regions`);
    return respondWhenDone(
      ollamaChat({
        prompt: PROMPT(brief, fontCount > 0 ? fontCount + LOCAL_FONT_SPARES : 0),
        images: [body.clean as string, body.annotated as string],
        prefill, maxTokens: MAX_TOKENS,
      }).then(async ({ text: answer, stats }) => {
        console.log(`[svg-text] ${LOCAL_MODEL} answered in ${((Date.now() - started) / 1000).toFixed(1)}s`);
        const read = readAnswer(answer);
        if ('error' in read) {
          console.log('[svg-text] unparseable local answer:', answer.slice(0, 500));
          throw new Error(`Model returned unparseable JSON (${read.error})`);
        }
        // usage in the shape Anthropic's takes (input_tokens / output_tokens), plus the
        // phase timings only a local run has, so the panel can show one or the other.
        return {
          regions: read.regions, fonts: await offeredFonts(read.fonts, fontCount), model: LOCAL_MODEL, usage: stats,
        };
      }),
    );
  }

  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) return bad('CLAUDE_API_KEY is not set on the server', 500);

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
          { type: 'text', text: PROMPT(brief, fontCount) },
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
  // Cut off at the token ceiling: the JSON is unfinished, and saying "unparseable" hides
  // the cause. Busy artwork does this — every candidate region costs answer tokens.
  if (data.stop_reason === 'max_tokens') {
    console.log(`[svg-text] answer cut off at max_tokens (${MAX_TOKENS}) with ${brief.length} regions`);
    return bad(`Answer cut off at the ${MAX_TOKENS}-token limit — ${brief.length} regions is more than one call can describe`, 502);
  }
  const read = readAnswer(answer);
  if ('error' in read) {
    console.log('[svg-text] unparseable answer:', data.stop_reason, answer.slice(0, 500));
    return bad(`Model returned unparseable JSON (${read.error}, stop_reason ${data.stop_reason})`, 502);
  }
  // usage alongside the regions so a debug run can price itself; the client ignores it.
  return Response.json({
    regions: read.regions, fonts: await offeredFonts(read.fonts, fontCount), model: data.model, usage: data.usage,
  });
}
