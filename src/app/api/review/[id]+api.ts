// Dev-only route backing the "Dev — Downloads" id box: GET /api/review/<id>. It asks
// the upstream review endpoint (also path-style — /review/svg/<id>) for the asset, reads
// the `url` node off the JSON, downloads that SVG and returns it — same { svg } /
// { svg: null } / { error } contract as download+api.ts, so the rail can treat both
// sources identically. It's also step 2 of the /<uuid> deep link, after
// review/check/[uuid] has turned the uuid into this numeric id.
//
// This runs server-side rather than in the rail because the review host sends no
// CORS headers: a browser fetch would be blocked before the response was readable.
// The host comes from API_HOST — no EXPO_PUBLIC_ prefix, so it's server-only, and one
// place to repoint both this and review/check/[uuid].

// Only digits — the id is interpolated into the upstream URL.
const ID_RE = /^\d+$/;

export async function GET(
  request: Request,
  params?: Record<string, string | string[] | undefined>,
): Promise<Response> {
  const host = process.env.API_HOST;
  if (!host) {
    return Response.json(
      { error: { message: 'API_HOST is not set on the server' } },
      { status: 500 },
    );
  }
  const reviewBase = `${host.replace(/\/+$/, '')}/review/svg`;

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

  // ?fresh=1 — the caller knows this asset has been customised, so the copy upstream
  // has been rewritten and any cached one is the wrong artwork. Bypass the cache on
  // both hops: the lookup (whose `url` may itself have changed) and the asset download.
  const fresh = new URL(request.url).searchParams.get('fresh') === '1';
  const noStore: RequestInit = fresh ? { cache: 'no-store' } : {};

  try {
    const lookup = await fetch(`${reviewBase}/${id}`, {
      ...noStore,
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

    const asset = await fetch(assetUrl, noStore);
    if (!asset.ok) {
      return Response.json(
        { error: { message: `Asset download failed (${asset.status})` } },
        { status: 502 },
      );
    }

    const svg = await asset.text();
    // Guard against an HTML error page arriving with a 200.
    if (!svg.includes('<svg')) return Response.json({ svg: null });

    // Tell the browser not to keep a fresh response either — the next selection of a
    // customised asset must reach the server again rather than replay this body.
    return Response.json({ svg }, fresh ? { headers: { 'cache-control': 'no-store' } } : {});
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Review fetch failed';
    return Response.json({ error: { message } }, { status: 500 });
  }
}
