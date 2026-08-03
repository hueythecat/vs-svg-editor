// GET /api/review/list — server-side proxy for the review asset list,
// API_HOST/review/svg/list. Backs the dev rail's vector dropdown: every asset the
// review host knows about, each with the uuid that the /<uuid> deep link resolves.
//
//   { message: "success", uuids: [ { name, id, edit_uuid, art_id, can_customise,
//     has_customised, customised_at, … } ], csrf_name: "csrf…", csrf_value: "…" }
//
// Same reasons as the other review routes: the host sends no CORS headers, so a client
// fetch is blocked before the response can be read, and API_HOST is server-only.
//
// Both the upstream status and body are logged and passed straight back, so whatever
// the endpoint says is visible in the dev server terminal and in the caller.

export async function GET(): Promise<Response> {
  const host = process.env.API_HOST;
  if (!host) {
    return Response.json(
      { error: { message: 'API_HOST is not set on the server' } },
      { status: 500 },
    );
  }

  const url = `${host.replace(/\/+$/, '')}/review/svg/list`;

  try {
    const upstream = await fetch(url, { headers: { accept: 'application/json' } });

    // Read as text first: an error page arrives as HTML and would blow up .json().
    const raw = await upstream.text();
    console.log(`[review/list] GET ${url} -> ${upstream.status}`, raw.slice(0, 200));

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
    const message = err instanceof Error ? err.message : 'Review list failed';
    console.log(`[review/list] GET ${url} failed:`, message);
    return Response.json({ error: { message } }, { status: 500 });
  }
}
