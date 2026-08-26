// Shared request validation for the two AI proxies, /api/claude and /api/kimi.
//
// Both routes inject a server-side API key and forward to a paid upstream, and neither
// can be authenticated: production lets anyone drop an SVG and run a Customise pass, so
// there is no session to check. What is left is to make an abusive request worth very
// little — the difference between "a free general-purpose Claude endpoint" and "a free
// way to have one PNG of artwork described".
//
// That is what this file enforces. It does NOT stop someone spending our credits; the
// per-IP throttle in server/index.mjs and the global daily budget beside it bound that.
// This bounds what each call can be *made to do*:
//
//   • the model is one of the two the client actually asks for, not opus-with-thinking
//   • max_tokens is capped, so a single call can't bill a 64k completion
//   • exactly one user turn with at most one image, so it can't be used as a chat
//     endpoint or to batch a hundred images through on one request
//   • the caller cannot supply its own `system`, so the request stays an SVG-analysis
//     request rather than whatever prompt the caller would rather run
//
// Deliberately an allowlist, not a blocklist. A new model or a new call shape has to be
// added here on purpose; the failure mode of forgetting is a 400 during development, not
// an open endpoint in production.

// The model ids the client hardcodes at its call sites (svg-drop-zone.web.tsx). Kimi
// ignores the incoming model and pins its own, but it is validated the same way so the
// two routes can't drift into accepting different bodies.
const ALLOWED_MODELS = new Set(['claude-sonnet-5', 'claude-sonnet-4-6']);

// The largest budget any call site asks for is 8192 (the customise and strip-text
// passes). Headroom over that, but nowhere near a model's ceiling.
const MAX_TOKENS_CAP = 12_000;

// One canvas render as base64 PNG. Caddy caps the whole body at 10MB; this is the same
// bound expressed where the dev server can also see it, since Caddy isn't in front of
// `expo start`.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// The prompts are built client-side, and the two that matter — the customise and
// strip-text passes — embed the ENTIRE SVG source in the prompt (`contentXml` /
// `markedSvgString` in svg-drop-zone.web.tsx). So this is not bounded by prompt wording;
// it is bounded by how big a vector file can be.
//
// Measured, not guessed. Across public/samples the largest is vectorstock_956069.svg at
// 757,363 characters of source, giving a ~759KB prompt. An earlier 32,000 here was set
// from an assumption that the prompts "run to a few thousand characters" and rejected
// every real customise pass on artwork of any size.
//
// 2MB is ~2.6x the largest sample, leaving room for artwork bigger than anything bundled.
// Be honest about what it is worth at this size: it is a sanity bound, not a meaningful
// restriction on abuse. What actually keeps this endpoint narrow is the model allowlist,
// the single user turn, the refusal of caller-supplied `system`, and the max_tokens cap —
// plus MAX_BODY_BYTES in server/index.mjs, which bounds image and text together and is
// the real outer limit on any one request.
//
// Note the upstream ceiling this does NOT replace: a 757KB XML prompt is roughly 200k+
// tokens, at or past the model's context window, so the largest files may fail at
// Anthropic with a context-length error rather than here. That is a pre-existing property
// of sending whole SVG source to a vision model, not something this guard introduces.
const MAX_TEXT_CHARS = 2_000_000;

const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export type GuardedBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

export type GuardedBody = {
  model: string;
  max_tokens: number;
  messages: [{ role: 'user'; content: GuardedBlock[] }];
};

// A rejection carries the reason so a developer adding a call site sees what tripped.
// Safe to return to the client: every one of these describes the caller's own request,
// not anything about the server.
export type GuardResult =
  | { ok: true; body: GuardedBody }
  | { ok: false; message: string };

const fail = (message: string): GuardResult => ({ ok: false, message });

// base64 decodes to 3 bytes per 4 chars, minus padding. Measuring the encoded length
// avoids decoding several megabytes just to find out it is too big.
const base64Bytes = (data: string): number => {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
};

export function guardAiRequest(raw: unknown): GuardResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('Expected a JSON object body');
  }
  const body = raw as Record<string, unknown>;

  // `system` is rejected rather than ignored. Silently dropping it would let a caller
  // believe it had taken effect and make a real bug here hard to see; the client never
  // sends one, so nothing legitimate hits this.
  if ('system' in body && body.system !== undefined) {
    return fail('system is set server-side and may not be supplied by the caller');
  }
  // Same for anything that changes what the upstream does rather than what it is asked.
  for (const key of ['tools', 'tool_choice', 'stream', 'thinking', 'metadata']) {
    if (key in body && body[key] !== undefined) return fail(`${key} is not accepted`);
  }

  if (typeof body.model !== 'string' || !ALLOWED_MODELS.has(body.model)) {
    return fail('Unsupported model');
  }

  const maxTokens = body.max_tokens;
  if (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens < 1) {
    return fail('max_tokens must be a positive integer');
  }
  if (maxTokens > MAX_TOKENS_CAP) {
    return fail(`max_tokens exceeds the ${MAX_TOKENS_CAP} cap`);
  }

  // Exactly one turn. Every call site is a single stateless image+text question, so a
  // conversation arriving here is not a call site that was forgotten — it is someone
  // using this as a chat endpoint.
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length !== 1) {
    return fail('Expected exactly one message');
  }
  const message = messages[0] as Record<string, unknown>;
  if (message?.role !== 'user') return fail('The message role must be "user"');

  const content = message.content;
  if (!Array.isArray(content) || content.length === 0 || content.length > 4) {
    return fail('Expected 1–4 content blocks');
  }

  const blocks: GuardedBlock[] = [];
  let images = 0;

  for (const entry of content) {
    if (!entry || typeof entry !== 'object') return fail('Malformed content block');
    const block = entry as Record<string, unknown>;

    if (block.type === 'text') {
      if (typeof block.text !== 'string') return fail('text block has no text');
      if (block.text.length > MAX_TEXT_CHARS) {
        return fail(`text block exceeds ${MAX_TEXT_CHARS} characters`);
      }
      blocks.push({ type: 'text', text: block.text });
      continue;
    }

    if (block.type === 'image') {
      if (++images > 1) return fail('At most one image per request');
      const source = block.source as Record<string, unknown> | undefined;
      if (!source || source.type !== 'base64') return fail('Images must be base64 sources');
      if (typeof source.media_type !== 'string' || !ALLOWED_IMAGE_TYPES.has(source.media_type)) {
        return fail('Unsupported image media_type');
      }
      if (typeof source.data !== 'string') return fail('image block has no data');
      if (base64Bytes(source.data) > MAX_IMAGE_BYTES) {
        return fail(`Image exceeds ${MAX_IMAGE_BYTES / (1024 * 1024)}MB`);
      }
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: source.media_type, data: source.data },
      });
      continue;
    }

    return fail(`Unsupported content block type: ${String(block.type)}`);
  }

  // Rebuilt from the validated parts rather than passed through, so an unrecognised
  // sibling key on a block cannot ride along to the upstream unexamined.
  return {
    ok: true,
    body: { model: body.model, max_tokens: maxTokens, messages: [{ role: 'user', content: blocks }] },
  };
}

// Cross-site use of the proxies. A browser attaches Origin to every cross-origin POST and
// Sec-Fetch-Site to same-origin ones too, so this refuses another site's page driving our
// credits from a visitor's browser.
//
// It stops exactly that and nothing else — curl sends whatever headers it likes, and this
// is not a substitute for the throttle or the budget. It is cheap and it closes the one
// abuse path that needs no infrastructure at all: an <script> on someone else's page.
//
// Requests with neither header (curl, a server-side caller, an old browser) are allowed
// through: rejecting them would break `curl /api/claude` in DEPLOY.md's verify steps and
// buys nothing, since anything that can omit a header can also forge one.
export function isCrossSite(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site) return site !== 'same-origin' && site !== 'none';

  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host !== new URL(request.url).host;
  } catch {
    return true;
  }
}
