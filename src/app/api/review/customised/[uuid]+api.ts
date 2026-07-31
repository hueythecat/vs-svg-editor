// POST /api/review/customised/<uuid> — server-side proxy for the upstream
// "this asset has been customised" notification, API_HOST/review/svg/customised/<uuid>.
// Fired once the AI customise pass has completed successfully, with the uuid from the
// app's own path (http://localhost/<uuid>). The upstream answers:
//
//   { message: "success" }
//
// Same shape and same reasons as review/check/[uuid]: it runs here because the review
// host sends no CORS headers, so a client fetch is blocked before the response can be
// read, and API_HOST has no EXPO_PUBLIC_ prefix so it is server-only anyway.
//
// Both the upstream status and body are logged and passed straight back, so whatever
// the endpoint says is visible in the dev server terminal and in the caller.

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export async function POST(
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

  // Prefer the routed [uuid] param; fall back to the last path segment so the handler
  // doesn't depend on how the router hands params over (same shape as review/check).
  const routed = params?.uuid;
  const uuid =
    (typeof routed === 'string' ? routed : Array.isArray(routed) ? routed[0] : undefined) ??
    new URL(request.url).pathname.split('/').filter(Boolean).pop() ??
    '';

  if (!UUID_RE.test(uuid)) {
    return Response.json({ error: { message: 'Invalid or missing uuid' } }, { status: 400 });
  }

  const url = `${host.replace(/\/+$/, '')}/review/svg/customised/${uuid}`;

  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { accept: 'application/json' },
    });

    // Read as text first: an error page arrives as HTML and would blow up .json().
    const raw = await upstream.text();
    console.log(`[review/customised] POST ${url} -> ${upstream.status}`, raw.slice(0, 500));

    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return Response.json(
        { error: { message: `Non-JSON response (${upstream.status})`, body: raw.slice(0, 500) } },
        { status: 502 },
      );
    }

    // Pass the upstream body and status through untouched — the caller debugs the real
    // response, not a reshaped one.
    return Response.json(data, { status: upstream.ok ? 200 : upstream.status });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Customised notification failed';
    console.log(`[review/customised] POST ${url} failed:`, message);
    return Response.json({ error: { message } }, { status: 500 });
  }
}
