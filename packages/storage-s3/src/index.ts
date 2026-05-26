import { assertStorageKey } from "@hono-cms/core";
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export type S3ClientLike = {
  send(command: unknown): Promise<unknown>;
};

export type S3StorageConfig = {
  provider: "s3";
  bucket: string;
  region?: string;
  endpoint?: string;
  publicBaseUrl?: string;
  forcePathStyle?: boolean;
  credentials?: S3ClientConfig["credentials"];
  client?: S3ClientLike;
  presigner?: (command: PutObjectCommand, options: { expiresIn: number }) => Promise<string>;
};

export class S3StorageAdapter implements StorageAdapter {
  readonly provider = "s3";
  private readonly bucket: string;
  private readonly client: S3ClientLike;
  private readonly publicBaseUrl: string | undefined;
  private readonly presigner?: S3StorageConfig["presigner"];

  constructor(config: S3StorageConfig) {
    this.bucket = config.bucket;
    this.publicBaseUrl = config.publicBaseUrl;
    this.presigner = config.presigner;
    const clientConfig: S3ClientConfig = { region: config.region ?? "auto" };
    if (config.endpoint) clientConfig.endpoint = config.endpoint;
    if (config.forcePathStyle !== undefined) clientConfig.forcePathStyle = config.forcePathStyle;
    if (config.credentials) clientConfig.credentials = config.credentials;
    this.client = config.client ?? new S3Client(clientConfig);
  }

  async put(key: string, body: Blob | ArrayBuffer | Uint8Array | string, options: StoragePutOptions = {}): Promise<StoredObject> {
    assertStorageKey(key);
    const bytes = await toBytes(body);
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: bytes,
      ContentType: options.contentType,
      Metadata: options.metadata
    }));
    const stored: StoredObject = { key, url: this.publicUrl(key), size: bytes.byteLength };
    if (options.contentType) stored.contentType = options.contentType;
    if (options.metadata) stored.metadata = options.metadata;
    return stored;
  }

  async createSignedUploadUrl(options: StorageSignedUploadOptions): Promise<StorageSignedUpload> {
    assertStorageKey(options.key);
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: options.key,
      ContentType: options.contentType,
      Metadata: options.metadata
    });
    const uploadUrl = this.presigner
      ? await this.presigner(command, { expiresIn: options.expiresInSeconds })
      : await getSignedUrl(this.client as S3Client, command, { expiresIn: options.expiresInSeconds });
    return { uploadUrl, method: "PUT", headers: { "content-type": options.contentType } };
  }

  publicUrl(key: string): string {
    assertStorageKey(key);
    if (this.publicBaseUrl) return `${this.publicBaseUrl.replace(/\/$/, "")}/${encodePath(key)}`;
    return `s3://${this.bucket}/${key}`;
  }

  async head(key: string): Promise<StoredObject | null> {
    assertStorageKey(key);
    try {
      const output = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key })) as { ContentLength?: number; ContentType?: string; Metadata?: Record<string, string> };
      const stored: StoredObject = { key, url: this.publicUrl(key), size: output.ContentLength ?? 0 };
      if (output.ContentType) stored.contentType = output.ContentType;
      if (output.Metadata) stored.metadata = output.Metadata;
      return stored;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async get(key: string): Promise<Response | null> {
    assertStorageKey(key);
    try {
      const output = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key })) as { Body?: unknown; ContentType?: string };
      if (!output.Body) return null;
      const headers = new Headers();
      if (output.ContentType) headers.set("content-type", output.ContentType);
      return new Response(await bodyToWebBody(output.Body), { headers });
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    assertStorageKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async health(): Promise<{ ok: boolean; details: { bucket: string } }> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    return { ok: true, details: { bucket: this.bucket } };
  }
}

export function createS3Storage(config: S3StorageConfig): S3StorageAdapter {
  return new S3StorageAdapter(config);
}

async function toBytes(body: Blob | ArrayBuffer | Uint8Array | string): Promise<Uint8Array> {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(await body.arrayBuffer());
}

async function bodyToWebBody(body: unknown): Promise<BodyInit> {
  if (body instanceof Uint8Array) return new Uint8Array(body).buffer;
  if (body instanceof ArrayBuffer || body instanceof Blob || body instanceof ReadableStream) return body;
  if (typeof body === "string") return body;
  if (body && typeof body === "object" && "transformToByteArray" in body && typeof body.transformToByteArray === "function") {
    const bytes = await body.transformToByteArray() as Uint8Array;
    return new Uint8Array(bytes).buffer;
  }
  if (body && typeof body === "object" && "transformToWebStream" in body && typeof body.transformToWebStream === "function") {
    return body.transformToWebStream() as ReadableStream;
  }
  return "";
}

function encodePath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybe = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return maybe.name === "NoSuchKey" || maybe.$metadata?.httpStatusCode === 404;
}


/** Preferred factory name per U24 — explicit alias of `createS3Storage`. */
export const s3Storage = createS3Storage;
