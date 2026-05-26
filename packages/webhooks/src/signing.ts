/**
 * HMAC-SHA256 signing helpers for webhook deliveries.
 *
 * The signature covers `<timestamp>.<body>` (concatenated with a literal
 * `.`) so receivers can reject replays whose `X-Timestamp` falls outside
 * the configured `replayWindowMs`. This matches the Stripe-style scheme
 * documented in `docs/plans/2026-05-25-001-...md` §U17.
 *
 * Headers wired by the dispatcher:
 * - `X-Timestamp`: Unix epoch milliseconds (string)
 * - `X-CMS-Signature` / `x-cms-signature`: `sha256=<hex>` of HMAC over
 *   the signed-payload string.
 */
export async function createHmacSignature(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const hash = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${[...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Build the signed-payload string the HMAC covers.
 *
 * Receivers MUST reconstruct this exactly (`<timestamp>.<rawBody>`) before
 * verifying the signature so the body and timestamp are bound together —
 * preventing an attacker from replaying the body with a fresh timestamp.
 */
export function buildSignedPayload(timestamp: string, body: string): string {
  return `${timestamp}.${body}`;
}

/**
 * Convenience: produce the HMAC over `<timestamp>.<body>` in one step.
 */
export async function signTimestampedBody(secret: string, timestamp: string, body: string): Promise<string> {
  return await createHmacSignature(secret, buildSignedPayload(timestamp, body));
}
