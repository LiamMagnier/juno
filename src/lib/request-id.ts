/**
 * The request-correlation header, in one place.
 *
 * Separate from @/lib/logger because middleware runs on the Edge runtime and
 * cannot import a `server-only` module — but both ends must agree on the name
 * or the id silently never arrives.
 */

/** Lower-case: what middleware sets on the REQUEST, read back via next/headers. */
export const REQUEST_ID_HEADER = "x-juno-request-id";

/** Canonical casing for the RESPONSE header the client sees. */
export const RESPONSE_REQUEST_ID_HEADER = "X-Juno-Request-Id";
