import { assertStorageKey } from "@hono-cms/core";
import { del, head, put } from "@vercel/blob";

export type VercelBlobClient = {
  put: typeof put;
  head: typeof head;
  del: typeof del;
};

export type VercelBlobStorageConfig = {
  provider: "vercel-blob";
  token?: string;
  access?: "public" | "private";
  multipart?: boolean;
  client?: VercelBlobClient;
};

export class VercelBlobStorageAdapter implements StorageAdapter {
  readonly provider = "vercel-blob";
  private readonly token: string | undefined;
  private readonly access: "public" | "private";
  private readonly multipart: boolean;
  private readonly client: VercelBlobClient;

  constructor(config: VercelBlobStorageConfig = { provider: "vercel-blob" }) {
    this.token = config.token;
    this.access = config.access ?? "public";
    this.multipart = config.multipart ?? true;
    this.client = config.client ?? { put, head, del };
  }

  async put(key: string, body: Blob | ArrayBuffer | Uint8Array | string, options: StoragePutOptions = {}): Promise<StoredObject> {
    assertStorageKey(key);
    const putOptions: Parameters<VercelBlobClient["put"]>[2] = {
      access: this.access,
      allowOverwrite: true,
      multipart: this.multipart
    };
    if (this.token) putOptions.token = this.token;
    if (options.contentType) putOptions.contentType = options.contentType;
    const result = await this.client.put(key, toPutBody(body), putOptions);
    const stored: StoredObject = {
      key: result.pathname,
      url: result.url,
      size: "contentLength" in result && typeof result.contentLength === "number" ? result.contentLength : await sizeOf(body)
    };
    if (options.contentType ?? result.contentType) stored.contentType = options.contentType ?? result.contentType;
    if (options.metadata) stored.metadata = options.metadata;
    return stored;
  }

  async createSignedUploadUrl(options: StorageSignedUploadOptions): Promise<StorageSignedUpload> {
    assertStorageKey(options.key);
    return {
      uploadUrl: this.publicUrl(options.key),
      method: "PUT",
      headers: { "content-type": options.contentType }
    };
  }

  publicUrl(key: string): string {
    assertStorageKey(key);
    return key;
  }

  async head(key: string): Promise<StoredObject | null> {
    assertStorageKey(key);
    try {
      const metadata = await this.client.head(key, this.token ? { token: this.token } : undefined);
      const stored: StoredObject = {
        key,
        url: metadata.url,
        size: metadata.size
      };
      if (metadata.contentType) stored.contentType = metadata.contentType;
      return stored;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async get(key: string): Promise<Response | null> {
    assertStorageKey(key);
    try {
      const headOptions = this.token ? { token: this.token } : undefined;
      const metadata = await this.client.head(key, headOptions);
      return await fetch(metadata.downloadUrl ?? metadata.url);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    assertStorageKey(key);
    await this.client.del(key, this.token ? { token: this.token } : undefined);
  }

  async health(): Promise<{ ok: boolean; details: { provider: string } }> {
    return { ok: true, details: { provider: this.provider } };
  }
}

export function createVercelBlobStorage(config: VercelBlobStorageConfig): VercelBlobStorageAdapter {
  return new VercelBlobStorageAdapter(config);
}

function toPutBody(body: Blob | ArrayBuffer | Uint8Array | string): string | Blob | ArrayBuffer {
  if (body instanceof Uint8Array) return new Blob([new Uint8Array(body)]);
  return body;
}

async function sizeOf(body: Blob | ArrayBuffer | Uint8Array | string): Promise<number> {
  if (typeof body === "string") return new TextEncoder().encode(body).byteLength;
  if (body instanceof Uint8Array) return body.byteLength;
  if (body instanceof ArrayBuffer) return body.byteLength;
  return (await body.arrayBuffer()).byteLength;
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybe = error as { status?: number; statusCode?: number; name?: string };
  return maybe.status === 404 || maybe.statusCode === 404 || maybe.name === "BlobNotFoundError";
}


/** Preferred factory name per U24 — explicit alias of `createVercelBlobStorage`. */
export const vercelBlobStorage = createVercelBlobStorage;
