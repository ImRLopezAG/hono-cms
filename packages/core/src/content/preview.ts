import type { CacheAdapter } from "../types/providers";

export type PreviewTokenPayload = {
  documentId: string;
  collection: string;
  createdAt: string;
};

export type PreviewTokenResult = {
  token: string;
  expiresAt: string;
  previewUrl: string;
};

const PREVIEW_TOKEN_BYTES = 32;
const PREVIEW_TOKEN_TTL_SECONDS = 60 * 60;

export async function generatePreviewToken(
  cache: CacheAdapter,
  input: { documentId: string; collection: string; previewUrlBase: string; now?: Date }
): Promise<PreviewTokenResult> {
  const now = input.now ?? new Date();
  const token = randomHex(PREVIEW_TOKEN_BYTES);
  const payload: PreviewTokenPayload = {
    documentId: input.documentId,
    collection: input.collection,
    createdAt: now.toISOString()
  };
  await cache.set(`preview:${token}`, payload, { ttl: PREVIEW_TOKEN_TTL_SECONDS });
  const expiresAt = new Date(now.getTime() + PREVIEW_TOKEN_TTL_SECONDS * 1000).toISOString();
  return {
    token,
    expiresAt,
    previewUrl: appendPreviewToken(input.previewUrlBase, token)
  };
}

export async function verifyPreviewToken(cache: CacheAdapter | null, token: string | null | undefined): Promise<PreviewTokenPayload | null> {
  if (!cache || !token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const payload = await cache.get<PreviewTokenPayload>(`preview:${token}`);
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.documentId !== "string" || typeof payload.collection !== "string") return null;
  return payload;
}

export async function revokePreviewToken(cache: CacheAdapter | null, token: string): Promise<void> {
  if (!cache || !/^[a-f0-9]{64}$/.test(token)) return;
  await cache.delete(`preview:${token}`);
}

function randomHex(bytesLength: number): string {
  const bytes = new Uint8Array(bytesLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function appendPreviewToken(base: string, token: string): string {
  const url = new URL(base);
  url.searchParams.set("preview", token);
  return url.toString();
}
