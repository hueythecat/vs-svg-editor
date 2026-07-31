// POST /api/review/check/<uuid> — server-side proxy for the upstream review check,
// API_HOST/review/svg/check/<uuid>. Given the uuid that appears in the app's own path
// (http://localhost/<uuid>) the upstream answers with the numeric asset id, an edit
// flag and a csrf pair:
//
//   { message: "success", id: 36247309, can_edit: 1, digest: {},
//     csrf_name: "csrf…", csrf_value: "…" }
//
// An asset that has already been through the customise pass also carries
// has_customised: 1 and customise_next (when it may be customised again). The client
// needs API_COOLDOWN to judge that, and API_COOLDOWN is server-only, so one derived
// field — cooldown_hours — is added to the body on the way back. Everything the
// upstream sent is still passed through untouched beside it.
//
// It runs here rather than in the browser for the same reason as review/[id]: the
// review host sends no CORS headers, so a client fetch is blocked before the response
// can be read. API_HOST has no EXPO_PUBLIC_ prefix, so it is server-only anyway.
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
  // doesn't depend on how the router hands params over (same shape as review/[id]).
  const routed = params?.uuid;
  const uuid =
    (typeof routed === 'string' ? routed : Array.isArray(routed) ? routed[0] : undefined) ??
    new URL(request.url).pathname.split('/').filter(Boolean).pop() ??
    '';

  if (!UUID_RE.test(uuid)) {
    return Response.json({ error: { message: 'Invalid or missing uuid' } }, { status: 400 });
  }

  const url = `${host.replace(/\/+$/, '')}/review/svg/check/${uuid}`;

  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { accept: 'application/json' },
    });

    // Read as text first: an error page arrives as HTML and would blow up .json().
    const raw = await upstream.text();
    console.log(`[review/check] POST ${url} -> ${upstream.status}`, raw.slice(0, 500));

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
    // response, not a reshaped one — with cooldown_hours added beside it so the client
    // can measure customise_next without needing the server-only API_COOLDOWN.
    const cooldownHours = Number(process.env.API_COOLDOWN ?? 24);
    const body =
      data && typeof data === 'object' && !Array.isArray(data)
        ? { ...(data as Record<string, unknown>), cooldown_hours: cooldownHours }
        : data;

    return Response.json(body, { status: upstream.ok ? 200 : upstream.status });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Review check failed';
    console.log(`[review/check] POST ${url} failed:`, message);
    return Response.json({ error: { message } }, { status: 500 });
  }
}
