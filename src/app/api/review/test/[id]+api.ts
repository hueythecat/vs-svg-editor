// GET /api/review/test/<id> — server-side proxy for the review host's "make a review
// entry for this art id" endpoint, API_HOST/review/svg/test/<id>. Backs the dev rail's
// id box: given a vectorstock art id it registers the asset for review, after which it
// appears in /review/svg/list with its own edit_uuid and can be opened like any other.
//
//   { message: "success", csrf_name: "csrf…", csrf_value: "…" }
//
// message: "failed" comes back when the id already has an entry — not fatal, since the
// caller can still find and open the existing one from the refreshed list.
//
// Note the path: /review/svg/test/<id>, the same base as check/customised/list. A bare
// /svg/test/<id> answers 404.
//
// Same reasons as the other review routes: the host sends no CORS headers, so a client
// fetch is blocked before the response can be read, and API_HOST is server-only.

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

  const url = `${host.replace(/\/+$/, '')}/review/svg/test/${id}`;

  try {
    const upstream = await fetch(url, { headers: { accept: 'application/json' } });

    // Read as text first: an error page arrives as HTML and would blow up .json().
    const raw = await upstream.text();
    console.log(`[review/test] GET ${url} -> ${upstream.status}`, raw.slice(0, 300));

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
    const message = err instanceof Error ? err.message : 'Review test failed';
    console.log(`[review/test] GET ${url} failed:`, message);
    return Response.json({ error: { message } }, { status: 500 });
  }
}
