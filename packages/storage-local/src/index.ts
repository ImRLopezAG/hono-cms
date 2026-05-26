import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { assertStorageKey, registerProvider, type StorageAdapter, type StoragePutOptions, type StorageSignedUpload, type StorageSignedUploadOptions, type StoredObject } from "@hono-cms/core";

export type LocalStorageConfig = {
  provider: "local";
  rootDir: string;
  publicBaseUrl?: string;
  /**
   * Local filesystem storage is not durable on serverless/edge hosts.
   * Production use requires an explicit opt-in to avoid silent data loss.
   */
  allowInProduction?: boolean;
};

type LocalMetadata = {
  contentType?: string;
  metadata?: Record<string, string>;
};

export class LocalStorageAdapter implements StorageAdapter {
  readonly provider = "local";
  private readonly rootDir: string;
  private readonly publicBaseUrl: string;

  constructor(config: LocalStorageConfig) {
    guardProductionLocalStorage(config);
    this.rootDir = resolve(config.rootDir);
    this.publicBaseUrl = config.publicBaseUrl ?? "/media";
  }

  async put(key: string, body: Blob | ArrayBuffer | Uint8Array | string, options: StoragePutOptions = {}): Promise<StoredObject> {
    const filePath = this.pathForKey(key);
    const bytes = await toBytes(body);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, bytes);
    await this.writeMetadata(key, options);
    const stored: StoredObject = { key, url: this.publicUrl(key), size: bytes.byteLength };
    if (options.contentType) stored.contentType = options.contentType;
    if (options.metadata) stored.metadata = options.metadata;
    return stored;
  }

  async createSignedUploadUrl(options: StorageSignedUploadOptions): Promise<StorageSignedUpload> {
    this.pathForKey(options.key);
    return {
      uploadUrl: `${this.publicBaseUrl.replace(/\/$/, "")}/upload/${encodePath(options.key)}?expires=${Date.now() + options.expiresInSeconds * 1000}`,
      method: "PUT",
      headers: { "content-type": options.contentType }
    };
  }

  publicUrl(key: string): string {
    this.pathForKey(key);
    return `${this.publicBaseUrl.replace(/\/$/, "")}/${encodePath(key)}`;
  }

  async head(key: string): Promise<StoredObject | null> {
    try {
      const [stats, metadata] = await Promise.all([
        stat(this.pathForKey(key)),
        this.readMetadata(key)
      ]);
      const stored: StoredObject = { key, url: this.publicUrl(key), size: stats.size };
      if (metadata.contentType) stored.contentType = metadata.contentType;
      if (metadata.metadata) stored.metadata = metadata.metadata;
      return stored;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async get(key: string): Promise<Response | null> {
    try {
      const [bytes, metadata] = await Promise.all([
        readFile(this.pathForKey(key)),
        this.readMetadata(key)
      ]);
      const init: ResponseInit = {};
      if (metadata.contentType) init.headers = { "content-type": metadata.contentType };
      return new Response(new Uint8Array(bytes), init);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await Promise.all([
      rm(this.pathForKey(key), { force: true }),
      rm(this.metadataPathForKey(key), { force: true })
    ]);
  }

  async health(): Promise<{ ok: boolean; details: { rootDir: string } }> {
    await mkdir(this.rootDir, { recursive: true });
    await stat(this.rootDir);
    return { ok: true, details: { rootDir: this.rootDir } };
  }

  private async writeMetadata(key: string, options: StoragePutOptions): Promise<void> {
    const metadataPath = this.metadataPathForKey(key);
    const metadata: LocalMetadata = {};
    if (options.contentType) metadata.contentType = options.contentType;
    if (options.metadata) metadata.metadata = options.metadata;
    await mkdir(dirname(metadataPath), { recursive: true });
    await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`);
  }

  private async readMetadata(key: string): Promise<LocalMetadata> {
    try {
      return JSON.parse(await readFile(this.metadataPathForKey(key), "utf8")) as LocalMetadata;
    } catch (error) {
      if (isNotFound(error)) return {};
      throw error;
    }
  }

  private pathForKey(key: string): string {
    return resolveInside(this.rootDir, key);
  }

  private metadataPathForKey(key: string): string {
    return resolveInside(this.rootDir, `.metadata/${key}.json`);
  }
}

export function createLocalStorage(config: LocalStorageConfig): LocalStorageAdapter {
  return new LocalStorageAdapter(config);
}

function guardProductionLocalStorage(config: LocalStorageConfig): void {
  const nodeEnv = globalThis.process?.env?.NODE_ENV;
  if (nodeEnv !== "production") return;
  if (config.allowInProduction === true) {
    console.warn("[hono-cms/storage-local] Local storage provider selected in production. Files may be ephemeral on serverless or edge hosts; use r2, s3, or vercel-blob for durable media.");
    return;
  }
  throw new Error("[hono-cms/storage-local] Local storage provider cannot be used in production unless allowInProduction is explicitly true. Use r2, s3, or vercel-blob for durable media.");
}

function resolveInside(rootDir: string, key: string): string {
  assertStorageKey(key);
  const resolved = resolve(rootDir, key);
  const rel = relative(rootDir, resolved);
  if (rel === "" || rel.startsWith("..") || rel.includes(`..${sep}`)) throw new Error("Storage key escapes the local storage root.");
  return resolved;
}

function encodePath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

async function toBytes(body: Blob | ArrayBuffer | Uint8Array | string): Promise<Uint8Array> {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(await body.arrayBuffer());
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

registerProvider<LocalStorageConfig, StorageAdapter>("storage", "local", createLocalStorage);

/** Preferred factory name per U24 — explicit alias of `createLocalStorage`. */
export const localStorage = createLocalStorage;
