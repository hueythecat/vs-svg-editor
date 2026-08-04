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

// The list reports customised_at as "YYYY-MM-DD HH:MM:SS" with no timezone, in the
// host's local time — art 10383776 reads "2026-08-03 18:39:24" here while the check
// endpoint gives the same moment as epoch 1785800364, i.e. 23:39:24 UTC. Parsing the
// string directly would read it as the *browser's* local time and land hours out, so
// the offset is applied here, once, where it can be stated rather than guessed.
//
// To re-derive it: call review/svg/check/<uuid> for an asset that has been customised
// and compare its epoch customised_at against the string this endpoint returns.
const HOST_UTC_OFFSET_HOURS = Number(process.env.API_TZ_OFFSET_HOURS ?? -5);

const toEpochMs = (local: unknown): number | null => {
  if (typeof local !== 'string') return null;
  const m = local.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const asUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  return asUtc - HOST_UTC_OFFSET_HOURS * 3_600_000;
};

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
    // response, not a reshaped one — with two derived fields beside it:
    //
    //   last_customised  the most recent customised_at across rows that aren't
    //                    cancelled, as an epoch. This is the cooldown's basis: one
    //                    customise puts every asset on cooldown, so it's a single
    //                    account-level value rather than something per row.
    //   cooldown_hours   API_COOLDOWN, which is server-only, same as review/check adds.
    let body: unknown = data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const rows = (data as { uuids?: Record<string, unknown>[] }).uuids;
      const lastCustomised = Array.isArray(rows)
        ? rows.reduce<number | null>((latest, row) => {
            if (row.cancelled) return latest;                 // a cancelled run doesn't count
            const ms = toEpochMs(row.customised_at);
            return ms !== null && (latest === null || ms > latest) ? ms : latest;
          }, null)
        : null;

      body = {
        ...(data as Record<string, unknown>),
        last_customised: lastCustomised,
        cooldown_hours: Number(process.env.API_COOLDOWN ?? 24),
      };
      console.log(`[review/list] last_customised (non-cancelled) -> ${lastCustomised}`);
    }

    return Response.json(body, { status: upstream.ok ? 200 : upstream.status });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Review list failed';
    console.log(`[review/list] GET ${url} failed:`, message);
    return Response.json({ error: { message } }, { status: 500 });
  }
}
