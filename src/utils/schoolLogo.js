/**
 * Signed logo URLs for a handful of schools at once.
 *
 * WHY THE SERVER SIGNS THESE AND NOT THE CLIENT. There is already a per-school
 * route for this — GET /platform/schools/:id/logo-url — and the school detail
 * page calls it once, for the one school it is showing. The Messages list shows
 * a logo on every row, so the same approach would be one round trip per
 * conversation, fired from a browser on a phone, to render an avatar. Signing
 * the distinct schools server-side turns that into one request.
 *
 * DISTINCT SCHOOLS, not distinct rows. Five schools exist on the platform; a
 * list of thirty conversations still resolves to at most five signatures.
 *
 * A FAILURE IS A NULL, NEVER A THROW. Every caller renders a placeholder when
 * the URL is missing, and an avatar is not worth failing an inbox over —
 * storage being unconfigured, a signing error, or a school saved with no logo
 * all arrive at the same harmless answer.
 */
const { supabase, BUCKET } = require('./storage');

/** How long a signed URL lasts. One hour, matching /platform/schools/:id/logo-url. */
const SIGNED_URL_TTL_SECONDS = 3600;

/**
 * @param {Array<{id:number, logo:string|null}>} schools
 * @returns {Promise<Map<number, string|null>>} schoolId -> URL, or null.
 */
async function signLogoUrls(schools) {
  const out = new Map();
  const toSign = [];

  for (const s of schools ?? []) {
    if (!s || !Number.isInteger(s.id)) continue;
    if (out.has(s.id)) continue;

    const logo = String(s.logo ?? '').trim();
    if (!logo) {
      // A school with no logo. Not an error, and the placeholder is the
      // designed answer rather than a fallback for something going wrong.
      out.set(s.id, null);
    } else if (!logo.startsWith('schools/')) {
      // Already an absolute URL — seeded rows and older uploads hold one.
      // Nothing to sign. Same passthrough as the single-school route.
      out.set(s.id, logo);
    } else {
      out.set(s.id, null);
      toSign.push({ id: s.id, path: logo });
    }
  }

  if (!toSign.length || !supabase) return out;

  await Promise.all(toSign.map(async ({ id, path }) => {
    try {
      const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
      if (!error && data?.signedUrl) out.set(id, data.signedUrl);
    } catch {
      // Left null. Logged nowhere on purpose: a storage hiccup would otherwise
      // write one line per school per inbox load, and the visible consequence
      // — a placeholder avatar — is already the whole story.
    }
  }));

  return out;
}

module.exports = { signLogoUrls, SIGNED_URL_TTL_SECONDS };
