// Dev-only route backing the "Dev — Downloads" id box: GET /api/review/<id>. It asks
// the upstream review endpoint (also path-style — /review/svg/<id>) for the asset, reads
// the `url` node off the JSON, downloads that SVG and returns it — same { svg } /
// { svg: null } / { error } contract as download+api.ts, so the rail can treat both
// sources identically.
//
// This runs server-side rather than in the rail because dev.vectorstock.com sends no
// CORS headers: a browser fetch would be blocked before the response was readable.

// Only digits — the id is interpolated into the upstream URL.
const ID_RE = /^\d+$/;

const REVIEW_BASE = 'https://dev.vectorstock.com/review/svg';

export async function GET(
  request: Request,
  params?: Record<string, string | string[] | undefined>,
): Promise<Response> {
  // Prefer the routed [id] param; fall back to the last path segment so the handler
  // doesn't depend on how the router hands params over.
  const routed = params?.id;
  const id =
    (typeof routed === 'string' ? routed : Array.isArray(routed) ? routed[0] : undefined) ??
    new URL(request.url).pathname.split('/').filter(Boolean).pop() ??
    '';

  if (!ID_RE.test(id)) {
    return Response.json({ error: { message: 'Invalid or missing id' } }, { status: 400 });
  }

  try {
    const lookup = await fetch(`${REVIEW_BASE}/${id}`, {
      headers: { accept: 'application/json' },
    });
    if (!lookup.ok) {
      return Response.json(
        { error: { message: `Review lookup failed (${lookup.status})` } },
        { status: 502 },
      );
    }

    // Documented shape is a `url` node; tolerate it being nested under `data` since the
    // endpoint is still in flux.
    const payload = (await lookup.json()) as
      | { url?: unknown; data?: { url?: unknown } }
      | null;
    const url = typeof payload?.url === 'string'
      ? payload.url
      : typeof payload?.data?.url === 'string'
        ? payload.data.url
        : null;

    if (!url) return Response.json({ svg: null });

    // Only follow http(s) — the response drives an outbound request from the server, so
    // file:/data: and friends stay out of it.
    let assetUrl: URL;
    try {
      assetUrl = new URL(url);
    } catch {
      return Response.json({ error: { message: `Malformed asset url: ${url}` } }, { status: 502 });
    }
    if (assetUrl.protocol !== 'https:' && assetUrl.protocol !== 'http:') {
      return Response.json(
        { error: { message: `Unsupported asset protocol: ${assetUrl.protocol}` } },
        { status: 502 },
      );
    }

    const asset = await fetch(assetUrl);
    if (!asset.ok) {
      return Response.json(
        { error: { message: `Asset download failed (${asset.status})` } },
        { status: 502 },
      );
    }

    const svg = await asset.text();
    // Guard against an HTML error page arriving with a 200.
    if (!svg.includes('<svg')) return Response.json({ svg: null });

    return Response.json({ svg });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Review fetch failed';
    return Response.json({ error: { message } }, { status: 500 });
  }
}
