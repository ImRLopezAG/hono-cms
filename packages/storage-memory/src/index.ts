import { assertStorageKey } from "@hono-cms/core";

export type MemoryStorageConfig = {
  provider: "memory";
  publicBaseUrl?: string;
};

export class MemoryStorageAdapter implements StorageAdapter {
  readonly provider = "memory";
  private readonly objects = new Map<string, { body: Uint8Array; contentType?: string; metadata?: Record<string, string> }>();
  private readonly publicBaseUrl: string;

  constructor(config: MemoryStorageConfig = { provider: "memory" }) {
    this.publicBaseUrl = config.publicBaseUrl ?? "memory://objects";
  }

  async put(key: string, body: Blob | ArrayBuffer | Uint8Array | string, options: StoragePutOptions = {}): Promise<StoredObject> {
    assertStorageKey(key);
    const bytes = await toBytes(body);
    const entry: { body: Uint8Array; contentType?: string; metadata?: Record<string, string> } = { body: bytes };
    if (options.contentType) entry.contentType = options.contentType;
    if (options.metadata) entry.metadata = options.metadata;
    this.objects.set(key, entry);
    const stored: StoredObject = { key, url: `${this.publicBaseUrl}/${encodeURIComponent(key)}`, size: bytes.byteLength };
    if (options.contentType) stored.contentType = options.contentType;
    if (options.metadata) stored.metadata = options.metadata;
    return stored;
  }

  async createSignedUploadUrl(options: StorageSignedUploadOptions): Promise<StorageSignedUpload> {
    assertStorageKey(options.key);
    return {
      uploadUrl: `${this.publicBaseUrl}/upload/${encodeURIComponent(options.key)}?expires=${Date.now() + options.expiresInSeconds * 1000}`,
      method: "PUT",
      headers: { "content-type": options.contentType }
    };
  }

  publicUrl(key: string): string {
    assertStorageKey(key);
    return `${this.publicBaseUrl}/${encodeURIComponent(key)}`;
  }

  async head(key: string): Promise<StoredObject | null> {
    assertStorageKey(key);
    const object = this.objects.get(key);
    if (!object) return null;
    const stored: StoredObject = { key, url: this.publicUrl(key), size: object.body.byteLength };
    if (object.contentType) stored.contentType = object.contentType;
    if (object.metadata) stored.metadata = object.metadata;
    return stored;
  }

  async get(key: string): Promise<Response | null> {
    assertStorageKey(key);
    const object = this.objects.get(key);
    if (!object) return null;
    const init: ResponseInit = {};
    if (object.contentType) init.headers = { "content-type": object.contentType };
    return new Response(new Uint8Array(object.body), init);
  }

  async delete(key: string): Promise<void> {
    assertStorageKey(key);
    this.objects.delete(key);
  }

  async health(): Promise<{ ok: boolean; details: { objects: number } }> {
    return { ok: true, details: { objects: this.objects.size } };
  }
}

export function createMemoryStorage(config: MemoryStorageConfig): MemoryStorageAdapter {
  return new MemoryStorageAdapter(config);
}

async function toBytes(body: Blob | ArrayBuffer | Uint8Array | string): Promise<Uint8Array> {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(await body.arrayBuffer());
}


/** Preferred factory name per U24 — explicit alias of `createMemoryStorage`. */
export const memoryStorage = createMemoryStorage;
