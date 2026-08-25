// What counts as a review uuid, for the two routes that can open one: the /<uuid> deep
// link and /?uuid=<uuid>.
//
// Shared rather than written out in both, so the two forms cannot disagree about which
// values are worth resolving. A link that opens the asset in one form and a blank editor
// in the other is the kind of difference that gets reported as "the editor is broken",
// with no clue pointing at the URL.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// `unknown` because the router hands back `string | string[] | undefined` — a repeated
// ?uuid=a&uuid=b arrives as an array, which is a malformed request rather than a choice
// to make on the caller's behalf, and falls through to undefined like any other non-uuid.
export const asReviewUuid = (value: unknown): string | undefined =>
  typeof value === 'string' && UUID_RE.test(value) ? value : undefined;
