import { assertStorageKey } from "@hono-cms/core";

export type R2BucketBinding = {
  put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
  get(key: string): Promise<R2ObjectBody | null>;
  head?(key: string): Promise<R2ObjectBody | null>;
  delete(key: string): Promise<void>;
};

export type R2ObjectBody = {
  body: ReadableStream;
  size: number;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
};

export type R2StorageConfig = {
  provider: "r2";
  bucket: R2BucketBinding;
  publicBaseUrl?: string;
  signedUploadUrl?: (options: StorageSignedUploadOptions) => Promise<StorageSignedUpload> | StorageSignedUpload;
};

export class R2StorageAdapter implements StorageAdapter {
  readonly provider = "r2";
  private readonly bucket: R2BucketBinding;
  private readonly publicBaseUrl: string | undefined;
  private readonly signedUploadUrl?: R2StorageConfig["signedUploadUrl"];

  constructor(config: R2StorageConfig) {
    this.bucket = config.bucket;
    this.publicBaseUrl = config.publicBaseUrl;
    this.signedUploadUrl = config.signedUploadUrl;
  }

  async put(key: string, body: Blob | ArrayBuffer | Uint8Array | string, options: StoragePutOptions = {}): Promise<StoredObject> {
    assertStorageKey(key);
    const bytes = await toBytes(body);
    const putOptions: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> } = {};
    if (options.contentType) putOptions.httpMetadata = { contentType: options.contentType };
    if (options.metadata) putOptions.customMetadata = options.metadata;
    await this.bucket.put(key, bytes, putOptions);
    const stored: StoredObject = { key, url: this.publicUrl(key), size: bytes.byteLength };
    if (options.contentType) stored.contentType = options.contentType;
    if (options.metadata) stored.metadata = options.metadata;
    return stored;
  }

  async createSignedUploadUrl(options: StorageSignedUploadOptions): Promise<StorageSignedUpload> {
    assertStorageKey(options.key);
    if (this.signedUploadUrl) return await this.signedUploadUrl(options);
    return {
      uploadUrl: this.publicUrl(options.key),
      method: "PUT",
      headers: { "content-type": options.contentType }
    };
  }

  publicUrl(key: string): string {
    assertStorageKey(key);
    return `${this.publicBaseUrl?.replace(/\/$/, "") ?? "r2://bucket"}/${encodePath(key)}`;
  }

  async head(key: string): Promise<StoredObject | null> {
    assertStorageKey(key);
    const object = this.bucket.head ? await this.bucket.head(key) : await this.bucket.get(key);
    if (!object) return null;
    const stored: StoredObject = { key, url: this.publicUrl(key), size: object.size };
    if (object.httpMetadata?.contentType) stored.contentType = object.httpMetadata.contentType;
    if (object.customMetadata) stored.metadata = object.customMetadata;
    return stored;
  }

  async get(key: string): Promise<Response | null> {
    assertStorageKey(key);
    const object = await this.bucket.get(key);
    if (!object) return null;
    const headers = new Headers();
    if (object.httpMetadata?.contentType) headers.set("content-type", object.httpMetadata.contentType);
    return new Response(object.body, { headers });
  }

  async delete(key: string): Promise<void> {
    assertStorageKey(key);
    await this.bucket.delete(key);
  }

  async health(): Promise<{ ok: boolean; details: { provider: string } }> {
    return { ok: true, details: { provider: this.provider } };
  }
}

export function createR2Storage(config: R2StorageConfig): R2StorageAdapter {
  return new R2StorageAdapter(config);
}

async function toBytes(body: Blob | ArrayBuffer | Uint8Array | string): Promise<Uint8Array> {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(await body.arrayBuffer());
}

function encodePath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}


/** Preferred factory name per U24 — explicit alias of `createR2Storage`. */
export const r2Storage = createR2Storage;
