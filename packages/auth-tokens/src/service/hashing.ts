/**
 * Generate a fresh `sk_<48-hex>` API token.
 *
 * 24 random bytes → 48 hex chars → prefixed with `sk_` for a final length of
 * 51 characters. The prefix is fixed so downstream auth layers can quickly
 * filter "looks like an API key" candidates before calling {@link hashToken}.
 */
export function generateToken(prefix = "sk_"): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}${hex}`;
}

/**
 * SHA-256 hex digest of the token. Stored in `api_keys.tokenHash` so we never
 * keep raw tokens at rest. Uses Web Crypto so it works on Node, Bun, Workers,
 * Deno, and Edge runtimes identically.
 */
export async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Public-display prefix for a token, e.g. `sk_abcd...wxyz`.
 *
 * The full token is only ever shown to the user at creation time; everything
 * after that — list views, logs, audit entries — uses this short form. Tokens
 * shorter than 13 characters are returned unchanged (defensive: nothing
 * produced by {@link generateToken} ever falls into that branch).
 */
export function getTokenPrefix(token: string): string {
  if (token.length <= 12) return token;
  return `${token.slice(0, 7)}...${token.slice(-4)}`;
}
