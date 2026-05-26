---
title: "feat: Storage Adapters — R2, S3, Vercel Blob, Local + Media API"
date: 2026-05-16
type: feat
status: active
depth: deep
origin: docs/ideation/2026-05-15-hono-cms-rebuild-ideation.md
ideation-ideas: ["#9 Storage Adapter — Binary File Handling"]
---

# Plan 008 — Storage Adapters: R2, S3, Vercel Blob, Local + Media API

## Enhancement Summary

**Deepened on:** 2026-05-16
**Sections enhanced:** 2
**Research inputs used:** skill review, framework docs, performance review, security review

### Key Improvements

1. Make direct/presigned uploads the default path earlier and more explicitly.
2. Add pending/confirm lifecycle safeguards for media metadata creation.
3. Tighten confirm-flow verification and active-content protections.

## Overview

This plan covers the complete binary file handling layer for `@hono-cms`. It defines a typed `StorageAdapter` interface mirroring the `DatabaseAdapter` pattern from Plan 001, four concrete provider packages, the `media` table as a first-class DB relation, REST endpoints at `/api/media`, and the presigned upload flow for large files on edge runtimes.

The storage layer is a foundational concern: every `type: 'media'` field in a collection definition is a foreign key into the `media` table. The CMS cannot handle media without a storage adapter configured. The four concrete adapters cover all target runtimes — Cloudflare Workers (R2), AWS/any S3-compatible (S3), Vercel Edge (Vercel Blob), and local Node.js development (local).

### Scope

| Unit | Description |
|------|-------------|
| U1   | `StorageAdapter` interface, `UploadResult` type, multipart types, error types, factory in `createCMS` |
| U2   | `@hono-cms/storage-r2` — Cloudflare R2 via Workers binding |
| U3   | `@hono-cms/storage-s3` — AWS S3 via `@aws-sdk/client-s3` v3 |
| U4   | `@hono-cms/storage-vercel-blob` — Vercel Blob via `@vercel/blob` |
| U5   | `@hono-cms/storage-local` — Node.js local filesystem, dev only |
| U6   | Media routes — REST handlers at `/api/media` |
| U7   | Presigned upload flow — large file bypass for edge body limits |

### Key Technical Decisions

1. **Why the StorageAdapter interface mirrors the DB adapter pattern.** Both storage and database are provider-specific at the binding level but operationally identical at the application level. The interface forces every provider to implement the same methods regardless of the underlying SDK. `createCMS` has one code path for upload regardless of whether the active provider is R2, S3, or Blob. This is the same architectural decision that makes `DatabaseAdapter` work — provider diversity is contained to the implementation packages, not scattered through the CMS core.

2. **Why `media` is a first-class DB table, not raw URL strings in content fields.** A raw `url: string` field in a content row breaks in four ways: (a) deletion — there is no way to know which content rows reference a file before deleting it from storage; (b) querying — you cannot filter collections by file properties (mime type, size, dimensions) if those properties live in the storage service, not the DB; (c) the relation system — the auto-generated SDK (Plan 011) types a `type: 'media'` field as `MediaFile`, not `string`, because the relation graph traversal needs to know the target type; (d) alt text and captions — these are CMS-owned metadata that belongs in the DB, not in S3 object tags. The `media` table is the join point between the storage layer and the content layer.

3. **Server-side upload vs. presigned URL — when to use each.** Server-side upload (file goes through `/api/media`) is correct for files below the edge body limit of the active runtime: 100MB for Cloudflare Workers, 4MB for Vercel Edge Functions, unlimited for Node.js. It is simpler — one HTTP call, one DB write, done. Presigned URL upload is required for files above those limits and preferred for all large files regardless of limit because it offloads bandwidth from the CMS API — the browser uploads directly to R2/S3/Blob and calls `/api/media/confirm` to register metadata. The CMS determines which strategy to use at runtime based on `Content-Length` against the configured `maxServerUploadSize` threshold (default 5MB). Below the threshold: server-side. Above: presigned.

4. **Image dimension detection across environments.** Sharp is a native Node.js addon — it cannot run on Cloudflare Workers. The Workers V8 isolate has no native module support. The solution is environment-specific: on Workers, use a pure-JavaScript WASM image decoder (e.g., `@jsquash/jpeg` / `@jsquash/png`) that can be bundled with the Worker. On Node.js (local provider, S3 in Node context), `image-size` (pure JS, no native addon) is used for dimension detection because it is synchronous and works on `ArrayBuffer` without spawning a child process. Sharp is explicitly not used — it would break the bundle for any project that imports `@hono-cms/storage-local` and then deploys to Workers. The CMS does not perform image optimization or format conversion — that is left to Cloudflare Images, imgix, or a separate transformation service.

5. **Why local provider emits a warning in production.** The local filesystem has no CDN, no replication, no durability guarantee beyond the host disk, and no public URL accessible outside the deployment host. In a serverless or edge deployment, the local filesystem is ephemeral — files written to disk disappear on the next cold start. Emitting a warning (and optionally refusing to start if `NODE_ENV === 'production'` without an explicit opt-out) prevents the silent data loss that would occur if a developer accidentally deployed with the local adapter.

---

## Research Insights

**Best Practices:**
- Prefer direct-to-storage or presigned uploads for browser media wherever the provider supports it.
- Treat uploaded media as `pending` until the server verifies object existence and final metadata, then finalize the DB row.
- Keep checksum/content-type constraints and key-prefix rules in the presign/confirm contract, not as optional niceties.

**Security Considerations:**
- `POST /api/media/confirm` should verify existence, size, content type, checksum or ETag, and key prefix server-side before trusting metadata.
- Add an explicit active-content denylist or forced-download policy for formats like SVG/HTML/XML.

**Edge Cases:**
- Local storage should fail loudly or require opt-in in production-like environments.
- Media deletion behavior needs to be explicit when content still references the asset.

## U1: StorageAdapter Interface

### Goal

Define the canonical TypeScript interface that all storage provider packages implement. Define `UploadResult`, multipart upload types, and `StorageError`. Specify where the interface lives, how `createCMS` instantiates the correct adapter from the `storage` discriminated union config, and what the adapter contract guarantees.

### Requirements

- Single interface that all four providers implement without deviation.
- `upload()` must return `UploadResult` — the same object written to the `media` DB table.
- `delete()` must be idempotent — deleting a key that does not exist must not throw.
- `getSignedUrl()` must accept an `expiresIn` in seconds and return a URL valid for that duration.
- Multipart methods are required on all providers, even if the underlying provider delegates to a single-part call for small parts. This avoids conditional method checking in the upload flow.
- `StorageError` must include the provider name, the operation that failed, and an optional provider-specific error code. The CMS maps `StorageError` to HTTP 500 (internal failure) or 404 (key not found) for REST responses.
- The `createCMS` factory must be synchronous at the config level — no `await` for adapter construction. Async initialization (e.g., bucket existence check) is not supported — the adapter is constructed eagerly and any connectivity issues surface on the first operation, not at startup (this keeps Workers cold start fast).

### Dependencies

None — this is the foundational unit.

### Files

```
packages/schema/src/storage.ts          ← StorageAdapter interface, all types
packages/schema/src/index.ts            ← re-exports StorageAdapter, UploadResult, StorageError, StorageConfig
packages/core/src/storage/factory.ts    ← createStorageAdapter(config: StorageConfig): StorageAdapter
packages/core/src/createCMS.ts          ← calls createStorageAdapter, passes adapter to media routes
```

### Approach

#### `packages/schema/src/storage.ts` — Full type definitions

```typescript
// UploadResult is persisted as a media DB row immediately after upload
export interface UploadResult {
  /** Storage-provider key — used for deletion. Unique within the bucket/prefix. */
  key: string
  /** Public or CDN URL for the file. */
  url: string
  /** Original filename as uploaded. */
  filename: string
  mimeType: string
  size: number
  /** Populated for images. Undefined for non-image files. */
  width?: number
  height?: number
}

// ─── Multipart upload types ──────────────────────────────────────────────────

export interface MultipartUploadInit {
  uploadId: string
  /** Provider-specific metadata the client must echo back in uploadPart calls. */
  key: string
}

export interface UploadPart {
  partNumber: number
  /** ETag returned by the provider for this part. Must be echoed back to completeMultipartUpload. */
  etag: string
}

// ─── Error type ──────────────────────────────────────────────────────────────

export type StorageOperation =
  | 'upload'
  | 'delete'
  | 'getSignedUrl'
  | 'createMultipartUpload'
  | 'uploadPart'
  | 'completeMultipartUpload'
  | 'abortMultipartUpload'

export class StorageError extends Error {
  readonly provider: string
  readonly operation: StorageOperation
  /** HTTP-equivalent status code for REST response mapping. */
  readonly statusCode: 400 | 404 | 413 | 500
  /** Raw provider error code if available (e.g. 'NoSuchKey', 'EntityTooLarge'). */
  readonly providerCode?: string

  constructor(opts: {
    message: string
    provider: string
    operation: StorageOperation
    statusCode?: 400 | 404 | 413 | 500
    providerCode?: string
    cause?: unknown
  }) {
    super(opts.message, { cause: opts.cause })
    this.name = 'StorageError'
    this.provider = opts.provider
    this.operation = opts.operation
    this.statusCode = opts.statusCode ?? 500
    this.providerCode = opts.providerCode
  }
}

// ─── StorageAdapter interface ─────────────────────────────────────────────────

export interface StorageAdapter {
  /**
   * Upload a file and return its permanent metadata.
   * Throws StorageError on failure.
   */
  upload(file: {
    buffer: ArrayBuffer
    filename: string
    mimeType: string
    size: number
  }): Promise<UploadResult>

  /**
   * Delete a file by its storage key.
   * Must be idempotent — deleting a key that does not exist must not throw.
   */
  delete(key: string): Promise<void>

  /**
   * Generate a time-limited URL for reading a private file.
   * For public buckets, implementations may return the public URL directly.
   * @param expiresIn Seconds until the URL expires.
   */
  getSignedUrl(key: string, expiresIn: number): Promise<string>

  /**
   * Initiate a multipart upload session.
   * Returns an uploadId and key the client uses for subsequent part uploads.
   */
  createMultipartUpload(
    filename: string,
    mimeType: string
  ): Promise<MultipartUploadInit>

  /**
   * Upload one part of a multipart upload.
   * @param partNumber 1-indexed part number. Parts may be uploaded in any order.
   * @param buffer Part data. S3 requires parts >= 5MB except the last part.
   */
  uploadPart(
    uploadId: string,
    key: string,
    partNumber: number,
    buffer: ArrayBuffer
  ): Promise<UploadPart>

  /**
   * Complete a multipart upload by assembling all parts.
   * Returns the same UploadResult shape as upload().
   */
  completeMultipartUpload(
    uploadId: string,
    key: string,
    filename: string,
    mimeType: string,
    parts: UploadPart[]
  ): Promise<UploadResult>

  /**
   * Abort a multipart upload, releasing any stored parts.
   * Must be called on error to avoid storage cost accumulation.
   */
  abortMultipartUpload(uploadId: string, key: string): Promise<void>
}
```

#### `StorageConfig` discriminated union — lives in `packages/schema/src/storage.ts`

```typescript
export type StorageConfig =
  | {
      provider: 'r2'
      /** R2Bucket binding from @cloudflare/workers-types */
      binding: R2Bucket
      /** Optional public domain for URL generation. If absent, uses signed URLs. */
      publicDomain?: string
      /** Prefix prepended to every key. Default: '' */
      keyPrefix?: string
    }
  | {
      provider: 's3'
      options: {
        bucket: string
        region: string
        credentials: {
          accessKeyId: string
          secretAccessKey: string
        }
        /** Override endpoint for S3-compatible providers (Tigris, Backblaze, MinIO). */
        endpoint?: string
        /** If true, keys are accessible at the base URL without signing. Default: false */
        publicBucket?: boolean
        keyPrefix?: string
      }
    }
  | {
      provider: 'blob'
      /** BLOB_READ_WRITE_TOKEN from Vercel Blob dashboard. */
      token: string
      /** Optional path prefix for all uploads. Default: '' */
      keyPrefix?: string
    }
  | {
      provider: 'local'
      /** Absolute or relative path to the upload directory. Default: './uploads' */
      dir?: string
      /** Base URL for serving files. Default: 'http://localhost:3000' */
      baseUrl?: string
      /** If true, suppress the production warning. Not recommended. */
      allowInProduction?: boolean
    }
```

#### `packages/core/src/storage/factory.ts` — Lazy dynamic import pattern

```typescript
import type { StorageAdapter, StorageConfig } from '@hono-cms/schema'
import { StorageError } from '@hono-cms/schema'

export async function createStorageAdapter(
  config: StorageConfig
): Promise<StorageAdapter> {
  switch (config.provider) {
    case 'r2': {
      const { R2StorageAdapter } = await import('@hono-cms/storage-r2')
      return new R2StorageAdapter(config)
    }
    case 's3': {
      const { S3StorageAdapter } = await import('@hono-cms/storage-s3')
      return new S3StorageAdapter(config.options)
    }
    case 'blob': {
      const { VercelBlobStorageAdapter } = await import('@hono-cms/storage-vercel-blob')
      return new VercelBlobStorageAdapter(config)
    }
    case 'local': {
      const { LocalStorageAdapter } = await import('@hono-cms/storage-local')
      return new LocalStorageAdapter(config)
    }
    default: {
      const _exhaustive: never = config
      throw new StorageError({
        message: `Unknown storage provider: ${(config as any).provider}`,
        provider: 'unknown',
        operation: 'upload',
        statusCode: 500,
      })
    }
  }
}
```

The dynamic import pattern enables tree shaking — a Cloudflare Workers bundle that uses `provider: 'r2'` will not include `@hono-cms/storage-s3` or the AWS SDK in the output. The factory is called once during `createCMS` bootstrap.

#### Integration point in `createCMS`

`createCMS` calls `createStorageAdapter(config.storage)` during bootstrap and passes the resulting adapter to `mountMediaRoutes`. The adapter is stored on the app's environment context so custom routes can access it via `c.get('storage')`.

```typescript
// packages/core/src/createCMS.ts (relevant excerpt)
const storage = config.storage
  ? await createStorageAdapter(config.storage)
  : null

const app = new Hono<CmsEnv>()
app.use('*', async (c, next) => {
  c.set('storage', storage)
  await next()
})

if (storage) {
  app.route('/api/media', mountMediaRoutes(storage, db, config.storage))
}
```

### Test Scenarios

- Constructing a `StorageError` preserves all fields including `cause`.
- `createStorageAdapter` with an unknown provider throws `StorageError` with `statusCode: 500`.
- `createStorageAdapter` with `provider: 'r2'` dynamically imports the R2 package (mock the dynamic import in tests).
- TypeScript: passing a config object without a `provider` field causes a compile error (discriminated union exhaustiveness).

### Verification

- `packages/schema` exports `StorageAdapter`, `UploadResult`, `StorageError`, `StorageConfig`, `MultipartUploadInit`, `UploadPart` from its public index.
- Every concrete adapter class passes `satisfies StorageAdapter` at the TypeScript level.
- `createStorageAdapter` is an async function; `createCMS` awaits it during bootstrap.

---

## U2: `@hono-cms/storage-r2`

### Goal

Implement `StorageAdapter` for Cloudflare R2 using the Workers R2Bucket binding. All operations go through the binding — no HTTP SDK, no AWS-compatible API calls. The adapter must work within the Cloudflare Workers execution model (no TCP, no Node.js APIs, V8 only).

### Requirements

- Accept `R2Bucket` binding directly — the binding is passed as `config.binding` in the `StorageConfig`. The adapter does not create or configure the bucket; it is given the already-bound object.
- Key generation: deterministic, collision-resistant, URL-safe. Format: `{keyPrefix}{year}/{month}/{nanoid(21)}-{sanitized-filename}`. Date-prefix improves listing performance on large buckets (R2 lists alphabetically). `nanoid(21)` from `nanoid` (pure ESM, edge-compatible) provides collision resistance without a DB round-trip.
- Public URL generation: if `publicDomain` is configured, public URL is `https://{publicDomain}/{key}`. If absent, `getSignedUrl` uses `R2Bucket.createPresignedUrl` — note this requires the R2 bucket to have the R2 presigned URLs feature enabled in the Wrangler config. The adapter documents this requirement.
- Image dimension detection: use `image-size` (pure JS, no WASM dependency for this path) for `image/*` mime types. `image-size` accepts a `Buffer`/`Uint8Array` — convert the `ArrayBuffer` via `new Uint8Array(buffer)`. Only attempt detection for known image types: `image/jpeg`, `image/png`, `image/gif`, `image/webp`, `image/avif`. Unknown types set `width`/`height` to `undefined`.
- Multipart upload: R2 supports multipart upload natively via `R2Bucket.createMultipartUpload()`. The adapter wraps this binding-native API directly — no manual HTTP chunking.
- `delete()` is idempotent: `R2Bucket.delete()` does not throw on a missing key — pass through without catching.

### Dependencies

- U1 (StorageAdapter interface, StorageError, StorageConfig)

### Files

```
packages/storage-r2/
  package.json                          ← name: @hono-cms/storage-r2
  src/
    index.ts                            ← exports R2StorageAdapter
    adapter.ts                          ← class R2StorageAdapter implements StorageAdapter
    key.ts                              ← generateKey(filename, prefix): string
    dimensions.ts                       ← extractDimensions(buffer, mimeType): { width?, height? }
  tests/
    adapter.test.ts
    key.test.ts
```

### Approach

#### `src/adapter.ts`

```typescript
import type { StorageAdapter, UploadResult, MultipartUploadInit, UploadPart } from '@hono-cms/schema'
import { StorageError } from '@hono-cms/schema'
import type { R2Bucket, R2MultipartUpload, R2UploadedPart } from '@cloudflare/workers-types'
import { generateKey } from './key'
import { extractDimensions } from './dimensions'

interface R2StorageConfig {
  binding: R2Bucket
  publicDomain?: string
  keyPrefix?: string
}

export class R2StorageAdapter implements StorageAdapter {
  private bucket: R2Bucket
  private publicDomain: string | undefined
  private keyPrefix: string

  constructor(config: R2StorageConfig) {
    this.bucket = config.binding
    this.publicDomain = config.publicDomain
    this.keyPrefix = config.keyPrefix ?? ''
  }

  async upload(file: {
    buffer: ArrayBuffer
    filename: string
    mimeType: string
    size: number
  }): Promise<UploadResult> {
    const key = generateKey(file.filename, this.keyPrefix)
    const dims = extractDimensions(file.buffer, file.mimeType)
    try {
      await this.bucket.put(key, file.buffer, {
        httpMetadata: { contentType: file.mimeType },
        customMetadata: { originalFilename: file.filename },
      })
    } catch (err) {
      throw new StorageError({
        message: `R2 put failed for key ${key}`,
        provider: 'r2',
        operation: 'upload',
        cause: err,
      })
    }
    return {
      key,
      url: this.buildUrl(key),
      filename: file.filename,
      mimeType: file.mimeType,
      size: file.size,
      ...dims,
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.bucket.delete(key)
    } catch (err) {
      // R2 delete is idempotent — but unexpected errors are still wrapped
      throw new StorageError({
        message: `R2 delete failed for key ${key}`,
        provider: 'r2',
        operation: 'delete',
        cause: err,
      })
    }
  }

  async getSignedUrl(key: string, expiresIn: number): Promise<string> {
    if (this.publicDomain) {
      return this.buildUrl(key)
    }
    try {
      // createPresignedUrl requires the R2 bucket to have "Allow Public Access" or
      // presigned URL support enabled in Wrangler config (r2_buckets[].jurisdiction or
      // custom domain). See Cloudflare R2 presigned URL documentation.
      return await (this.bucket as any).createPresignedUrl(key, {
        expiresIn,
        method: 'GET',
      })
    } catch (err) {
      throw new StorageError({
        message: `R2 presigned URL generation failed for key ${key}`,
        provider: 'r2',
        operation: 'getSignedUrl',
        cause: err,
      })
    }
  }

  async createMultipartUpload(
    filename: string,
    mimeType: string
  ): Promise<MultipartUploadInit> {
    const key = generateKey(filename, this.keyPrefix)
    try {
      const multipart: R2MultipartUpload = await this.bucket.createMultipartUpload(
        key,
        { httpMetadata: { contentType: mimeType } }
      )
      return { uploadId: multipart.uploadId, key }
    } catch (err) {
      throw new StorageError({
        message: `R2 createMultipartUpload failed`,
        provider: 'r2',
        operation: 'createMultipartUpload',
        cause: err,
      })
    }
  }

  async uploadPart(
    uploadId: string,
    key: string,
    partNumber: number,
    buffer: ArrayBuffer
  ): Promise<UploadPart> {
    try {
      const multipart = this.bucket.resumeMultipartUpload(key, uploadId)
      const part: R2UploadedPart = await multipart.uploadPart(partNumber, buffer)
      return { partNumber, etag: part.etag }
    } catch (err) {
      throw new StorageError({
        message: `R2 uploadPart failed (part ${partNumber})`,
        provider: 'r2',
        operation: 'uploadPart',
        cause: err,
      })
    }
  }

  async completeMultipartUpload(
    uploadId: string,
    key: string,
    filename: string,
    mimeType: string,
    parts: UploadPart[]
  ): Promise<UploadResult> {
    try {
      const multipart = this.bucket.resumeMultipartUpload(key, uploadId)
      const r2Parts: R2UploadedPart[] = parts.map(p => ({ partNumber: p.partNumber, etag: p.etag }))
      const obj = await multipart.complete(r2Parts)
      return {
        key,
        url: this.buildUrl(key),
        filename,
        mimeType,
        size: obj.size,
        // Dimensions cannot be extracted here without downloading the full object.
        // For multipart uploads the client should provide width/height in the confirm payload.
      }
    } catch (err) {
      throw new StorageError({
        message: `R2 completeMultipartUpload failed for key ${key}`,
        provider: 'r2',
        operation: 'completeMultipartUpload',
        cause: err,
      })
    }
  }

  async abortMultipartUpload(uploadId: string, key: string): Promise<void> {
    try {
      const multipart = this.bucket.resumeMultipartUpload(key, uploadId)
      await multipart.abort()
    } catch (err) {
      throw new StorageError({
        message: `R2 abortMultipartUpload failed for key ${key}`,
        provider: 'r2',
        operation: 'abortMultipartUpload',
        cause: err,
      })
    }
  }

  private buildUrl(key: string): string {
    if (this.publicDomain) {
      return `https://${this.publicDomain}/${key}`
    }
    // Fallback: r2.dev subdomain if enabled on the bucket (not recommended for production)
    return `https://pub-placeholder.r2.dev/${key}`
  }
}
```

#### `src/key.ts`

```typescript
import { nanoid } from 'nanoid'

/** Sanitize filename to URL-safe characters. */
function sanitizeFilename(filename: string): string {
  return filename
    .toLowerCase()
    .replace(/[^a-z0-9.\-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Generate a collision-resistant, date-prefixed, URL-safe storage key.
 * Format: {prefix}{year}/{month}/{nanoid}-{sanitized-filename}
 * Example: uploads/2026/05/V1StGXR8_Z5jdHi6B-my-photo.jpg
 */
export function generateKey(filename: string, prefix: string = ''): string {
  const now = new Date()
  const year = now.getUTCFullYear()
  const month = String(now.getUTCMonth() + 1).padStart(2, '0')
  const id = nanoid(21)
  const safe = sanitizeFilename(filename)
  return `${prefix}${year}/${month}/${id}-${safe}`
}
```

#### `src/dimensions.ts`

```typescript
// image-size is pure JS, edge-compatible, synchronous on ArrayBuffer
import sizeOf from 'image-size'

const SUPPORTED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/tiff',
])

export function extractDimensions(
  buffer: ArrayBuffer,
  mimeType: string
): { width?: number; height?: number } {
  if (!SUPPORTED_IMAGE_TYPES.has(mimeType)) return {}
  try {
    const uint8 = new Uint8Array(buffer)
    const result = sizeOf(uint8)
    return { width: result.width, height: result.height }
  } catch {
    // Non-critical — return empty rather than throwing
    return {}
  }
}
```

**Note on `image-size` in Workers:** `image-size` v2+ is pure ESM with no Node.js-specific dependencies and no `fs` calls when given a `Uint8Array` directly. It reads the image headers (first few hundred bytes) to determine dimensions, making it fast and low-memory. It does not require Sharp, Canvas, or any native addon.

#### `package.json` for `@hono-cms/storage-r2`

```json
{
  "name": "@hono-cms/storage-r2",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": {
      "import": "./src/index.ts",
      "types": "./src/index.ts"
    }
  },
  "peerDependencies": {
    "@cloudflare/workers-types": ">=4.0.0",
    "@hono-cms/schema": "workspace:*"
  },
  "dependencies": {
    "nanoid": "^5.0.0",
    "image-size": "^2.0.0"
  },
  "devDependencies": {
    "vitest": "^2.0.0"
  }
}
```

### Test Scenarios

1. **Happy path upload** — Mock `R2Bucket.put()` to resolve. Assert returned `UploadResult` has correct `key`, `url` built from `publicDomain`, `mimeType`, `size`. For a JPEG buffer with known dimensions, assert `width` and `height` are populated.
2. **Delete idempotency** — Mock `R2Bucket.delete()` to resolve on first call and simulate a missing-key no-op. Assert adapter does not throw.
3. **Upload failure** — Mock `R2Bucket.put()` to reject. Assert `StorageError` is thrown with `provider: 'r2'`, `operation: 'upload'`.
4. **Key format** — Assert `generateKey('My Photo!.jpg', 'uploads/')` produces a key matching `/^uploads\/\d{4}\/\d{2}\/[A-Za-z0-9_-]{21}-my-photo-\.jpg$/`.
5. **Multipart flow** — Mock `createMultipartUpload`, `resumeMultipartUpload`, `uploadPart`, `complete`. Assert the returned `UploadResult` from `completeMultipartUpload` has the correct `key` and `url`.
6. **Abort on error** — Mock `uploadPart` to throw. Assert `abortMultipartUpload` is called and throws `StorageError`.
7. **Dimensions — non-image** — For `mimeType: 'application/pdf'`, assert `width` and `height` are `undefined` in `UploadResult`.
8. **Signed URL — no publicDomain** — Mock `bucket.createPresignedUrl`. Assert `getSignedUrl` calls it with the correct key and `expiresIn`.

### Verification

- `R2StorageAdapter satisfies StorageAdapter` compiles without error.
- Tests run in `vitest` with Workers-compatible environment (no Node.js globals).
- `image-size` import succeeds in a bundle targeting `workerd` (no `node:fs` dependency in the used code path).

---

## U3: `@hono-cms/storage-s3`

### Goal

Implement `StorageAdapter` for AWS S3 and S3-compatible providers (Tigris, Backblaze B2, MinIO, Cloudflare R2 S3-compatible API) using `@aws-sdk/client-s3` v3. The v3 SDK is fetch-based and has no Node.js-specific runtime dependencies — it runs on Cloudflare Workers and Vercel Edge without modification.

### Requirements

- Use `@aws-sdk/client-s3` v3 commands: `PutObjectCommand`, `DeleteObjectCommand`, `GetObjectCommand`, `CreateMultipartUploadCommand`, `UploadPartCommand`, `CompleteMultipartUploadCommand`, `AbortMultipartUploadCommand`.
- Use `@aws-sdk/s3-request-presigner` for `getSignedUrl`. Presigned GET URLs are time-limited.
- Support a custom `endpoint` for S3-compatible providers — pass directly to `S3Client` constructor.
- `delete()` must catch the `NoSuchKey` error code from S3 and swallow it (idempotency). All other errors are re-thrown as `StorageError`.
- Same key generation as U2 (`generateKey` is extracted to `packages/storage-s3/src/key.ts` — identical implementation, not a shared internal package to avoid cross-package coupling between storage providers).
- Image dimension detection: same `extractDimensions` as U2 — pure JS `image-size`.
- `S3Client` is instantiated once in the constructor and reused across calls. Do not create a new client per request.

### Dependencies

- U1 (StorageAdapter interface, StorageError, StorageConfig)

### Files

```
packages/storage-s3/
  package.json                          ← name: @hono-cms/storage-s3
  src/
    index.ts
    adapter.ts                          ← class S3StorageAdapter implements StorageAdapter
    key.ts                              ← identical to storage-r2/src/key.ts (not shared)
    dimensions.ts                       ← identical to storage-r2/src/dimensions.ts
  tests/
    adapter.test.ts
```

### Approach

#### `src/adapter.ts`

```typescript
import type { StorageAdapter, UploadResult, MultipartUploadInit, UploadPart } from '@hono-cms/schema'
import { StorageError } from '@hono-cms/schema'
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  S3ServiceException,
} from '@aws-sdk/client-s3'
import { getSignedUrl as awsGetSignedUrl } from '@aws-sdk/s3-request-presigner'
import { generateKey } from './key'
import { extractDimensions } from './dimensions'

interface S3AdapterOptions {
  bucket: string
  region: string
  credentials: { accessKeyId: string; secretAccessKey: string }
  endpoint?: string
  publicBucket?: boolean
  keyPrefix?: string
}

export class S3StorageAdapter implements StorageAdapter {
  private client: S3Client
  private bucket: string
  private keyPrefix: string
  private publicBucket: boolean
  private endpoint: string | undefined

  constructor(opts: S3AdapterOptions) {
    this.bucket = opts.bucket
    this.keyPrefix = opts.keyPrefix ?? ''
    this.publicBucket = opts.publicBucket ?? false
    this.endpoint = opts.endpoint
    this.client = new S3Client({
      region: opts.region,
      credentials: opts.credentials,
      ...(opts.endpoint ? { endpoint: opts.endpoint, forcePathStyle: true } : {}),
    })
  }

  async upload(file: {
    buffer: ArrayBuffer
    filename: string
    mimeType: string
    size: number
  }): Promise<UploadResult> {
    const key = generateKey(file.filename, this.keyPrefix)
    const dims = extractDimensions(file.buffer, file.mimeType)
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: new Uint8Array(file.buffer),
          ContentType: file.mimeType,
          ContentLength: file.size,
          Metadata: { 'original-filename': file.filename },
        })
      )
    } catch (err) {
      throw this.mapError(err, 'upload', key)
    }
    return {
      key,
      url: this.buildUrl(key),
      filename: file.filename,
      mimeType: file.mimeType,
      size: file.size,
      ...dims,
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key })
      )
    } catch (err) {
      if (err instanceof S3ServiceException && err.name === 'NoSuchKey') {
        return // idempotent
      }
      throw this.mapError(err, 'delete', key)
    }
  }

  async getSignedUrl(key: string, expiresIn: number): Promise<string> {
    if (this.publicBucket) {
      return this.buildUrl(key)
    }
    try {
      const command = new GetObjectCommand({ Bucket: this.bucket, Key: key }) // GetObjectCommand imported separately
      return await awsGetSignedUrl(this.client, command, { expiresIn })
    } catch (err) {
      throw this.mapError(err, 'getSignedUrl', key)
    }
  }

  async createMultipartUpload(
    filename: string,
    mimeType: string
  ): Promise<MultipartUploadInit> {
    const key = generateKey(filename, this.keyPrefix)
    try {
      const res = await this.client.send(
        new CreateMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          ContentType: mimeType,
          Metadata: { 'original-filename': filename },
        })
      )
      return { uploadId: res.UploadId!, key }
    } catch (err) {
      throw this.mapError(err, 'createMultipartUpload')
    }
  }

  async uploadPart(
    uploadId: string,
    key: string,
    partNumber: number,
    buffer: ArrayBuffer
  ): Promise<UploadPart> {
    try {
      const res = await this.client.send(
        new UploadPartCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
          Body: new Uint8Array(buffer),
          ContentLength: buffer.byteLength,
        })
      )
      return { partNumber, etag: res.ETag! }
    } catch (err) {
      throw this.mapError(err, 'uploadPart', key)
    }
  }

  async completeMultipartUpload(
    uploadId: string,
    key: string,
    filename: string,
    mimeType: string,
    parts: UploadPart[]
  ): Promise<UploadResult> {
    try {
      await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts.map(p => ({ PartNumber: p.partNumber, ETag: p.etag })),
          },
        })
      )
      // S3 does not return the object size in the complete response.
      // Caller must provide size via the confirm endpoint (U7).
      return {
        key,
        url: this.buildUrl(key),
        filename,
        mimeType,
        size: 0, // overridden by confirm payload in U7
      }
    } catch (err) {
      throw this.mapError(err, 'completeMultipartUpload', key)
    }
  }

  async abortMultipartUpload(uploadId: string, key: string): Promise<void> {
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
        })
      )
    } catch (err) {
      throw this.mapError(err, 'abortMultipartUpload', key)
    }
  }

  private buildUrl(key: string): string {
    if (this.endpoint) {
      // S3-compatible: {endpoint}/{bucket}/{key}
      const base = this.endpoint.replace(/\/$/, '')
      return `${base}/${this.bucket}/${key}`
    }
    // Standard AWS S3: virtual-hosted-style URL
    return `https://${this.bucket}.s3.amazonaws.com/${key}`
  }

  private mapError(
    err: unknown,
    operation: StorageOperation,
    key?: string
  ): StorageError {
    if (err instanceof S3ServiceException) {
      return new StorageError({
        message: err.message,
        provider: 's3',
        operation,
        statusCode: (err.$metadata?.httpStatusCode as any) ?? 500,
        providerCode: err.name,
        cause: err,
      })
    }
    return new StorageError({
      message: String(err),
      provider: 's3',
      operation,
      cause: err,
    })
  }
}
```

#### Edge compatibility note

`@aws-sdk/client-s3` v3 (>= 3.400.0) uses the `fetch` API internally via `@smithy/fetch-http-handler`. It has no `net`, `tls`, `http`, or `https` Node.js module dependencies in the request path. It runs on Cloudflare Workers, Vercel Edge, and Bun. The `S3Client` constructor may pull in a small set of Node.js crypto polyfills for HMAC signing — these are included in the Workers runtime via `workerd`'s built-in crypto support. This is confirmed production behavior; no additional polyfilling is required.

### Test Strategy

Use `msw` (Mock Service Worker) in Node test environment to intercept HTTP calls made by `@aws-sdk/client-s3`. This tests the full SDK request-building path without hitting real AWS infrastructure.

```typescript
// tests/adapter.test.ts
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'

const server = setupServer(
  http.put('https://my-bucket.s3.amazonaws.com/:key', () => {
    return new HttpResponse(null, { status: 200, headers: { ETag: '"abc123"' } })
  }),
  http.delete('https://my-bucket.s3.amazonaws.com/:key', () => {
    return new HttpResponse(null, { status: 204 })
  })
  // ... multipart endpoints
)

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())
```

### Test Scenarios

1. **Happy path upload** — MSW intercepts PUT. Assert `UploadResult.url` matches S3 virtual-hosted URL format.
2. **Delete — NoSuchKey** — MSW returns 404 with `<Code>NoSuchKey</Code>` body. Assert adapter resolves without throwing.
3. **Delete — genuine error** — MSW returns 500. Assert `StorageError` is thrown with `statusCode: 500`.
4. **Presigned URL** — Assert `getSignedUrl` returns a URL containing `X-Amz-Signature` query param.
5. **Custom endpoint** — Construct adapter with `endpoint: 'https://tigris.example.com'`. Assert built URL is `https://tigris.example.com/bucket/key`.
6. **Multipart upload flow** — Mock all four S3 multipart endpoints. Assert `completeMultipartUpload` returns `UploadResult` with correct `key`.
7. **S3ServiceException mapping** — Simulate an `EntityTooLarge` S3 error. Assert `StorageError.statusCode === 413` and `providerCode === 'EntityTooLarge'`.

### Verification

- `S3StorageAdapter satisfies StorageAdapter` compiles without error.
- Bundle analysis confirms no Node.js built-in modules are imported in the `@aws-sdk/client-s3` request path when targeting `workerd`.
- All MSW tests pass in `vitest` with `environment: 'node'`.

---

## U4: `@hono-cms/storage-vercel-blob`

### Goal

Implement `StorageAdapter` for Vercel Blob using the `@vercel/blob` package. Vercel Blob is the simplest provider — it is HTTP-native, edge-compatible by default, and the SDK is minimal. The adapter also supports direct upload (browser uploads directly to Blob, bypassing the CMS server) which is the required pattern when the CMS runs on Vercel Edge Functions where the request body limit is 4MB.

### Requirements

- Token must be provided via `config.token` — never read from `process.env.BLOB_READ_WRITE_TOKEN` inside the adapter. The token is passed in from `createCMS` config to keep the adapter testable and environment-agnostic.
- `upload()` uses `@vercel/blob`'s `put()` function.
- `delete()` uses `@vercel/blob`'s `del()` function. Vercel Blob `del()` does not throw on missing URLs — pass through directly.
- `getSignedUrl()` — Vercel Blob does not support private signed URLs for reading. All Vercel Blob files are publicly accessible via their URL. `getSignedUrl` returns the public URL regardless of `expiresIn`. This is a known Vercel Blob limitation — document it in the adapter JSDoc.
- `createMultipartUpload` / `uploadPart` / `completeMultipartUpload` — Vercel Blob does not have native multipart upload. The adapter implements multipart via the **server upload token** pattern: `createMultipartUpload` generates an upload URL via `@vercel/blob`'s `handleUpload` (client upload token), and the browser uploads directly to that URL. `completeMultipartUpload` calls `put()` with the returned Blob URL to register the result. This is a protocol adapter — the caller (U7) uses these methods, and for Vercel Blob the "multipart" is really a single direct upload.
- `keyPrefix` maps to Vercel Blob's `pathname` option on `put()`.
- URL returned by `put()` is the permanent Vercel Blob CDN URL — store this directly as `media.url`.

### Dependencies

- U1 (StorageAdapter interface, StorageError, StorageConfig)

### Files

```
packages/storage-vercel-blob/
  package.json                          ← name: @hono-cms/storage-vercel-blob
  src/
    index.ts
    adapter.ts                          ← class VercelBlobStorageAdapter implements StorageAdapter
    key.ts
    dimensions.ts
  tests/
    adapter.test.ts
```

### Approach

#### `src/adapter.ts`

```typescript
import type { StorageAdapter, UploadResult, MultipartUploadInit, UploadPart } from '@hono-cms/schema'
import { StorageError } from '@hono-cms/schema'
import { put, del } from '@vercel/blob'
import { generateKey } from './key'
import { extractDimensions } from './dimensions'

interface BlobAdapterConfig {
  token: string
  keyPrefix?: string
}

export class VercelBlobStorageAdapter implements StorageAdapter {
  private token: string
  private keyPrefix: string

  constructor(config: BlobAdapterConfig) {
    this.token = config.token
    this.keyPrefix = config.keyPrefix ?? ''
  }

  async upload(file: {
    buffer: ArrayBuffer
    filename: string
    mimeType: string
    size: number
  }): Promise<UploadResult> {
    const pathname = generateKey(file.filename, this.keyPrefix)
    const dims = extractDimensions(file.buffer, file.mimeType)
    try {
      const result = await put(pathname, new Uint8Array(file.buffer), {
        access: 'public',
        contentType: file.mimeType,
        token: this.token,
      })
      return {
        key: result.pathname,
        url: result.url,
        filename: file.filename,
        mimeType: file.mimeType,
        size: file.size,
        ...dims,
      }
    } catch (err) {
      throw new StorageError({
        message: `Vercel Blob put failed for pathname ${pathname}`,
        provider: 'blob',
        operation: 'upload',
        cause: err,
      })
    }
  }

  async delete(key: string): Promise<void> {
    try {
      // @vercel/blob del() accepts a URL or pathname.
      // We store the full URL as the key for Vercel Blob to simplify deletion.
      await del(key, { token: this.token })
    } catch (err) {
      throw new StorageError({
        message: `Vercel Blob delete failed for key ${key}`,
        provider: 'blob',
        operation: 'delete',
        cause: err,
      })
    }
  }

  /**
   * Vercel Blob does not support private signed URLs.
   * All files are publicly accessible. This method returns the public URL
   * regardless of expiresIn. If private files are required, use R2 or S3.
   */
  async getSignedUrl(key: string, _expiresIn: number): Promise<string> {
    // key is stored as the full Vercel Blob URL
    return key
  }

  /**
   * Vercel Blob does not support server-side multipart upload.
   * createMultipartUpload generates a client upload token via @vercel/blob's
   * handleUpload. The browser uses this token to upload directly to Vercel Blob.
   * The uploadId is the client token; key is the target pathname.
   */
  async createMultipartUpload(
    filename: string,
    mimeType: string
  ): Promise<MultipartUploadInit> {
    const key = generateKey(filename, this.keyPrefix)
    try {
      // Generate a one-time client upload token
      const { clientPayload } = await import('@vercel/blob').then(m =>
        m.generateClientTokenFromReadWriteToken({
          token: this.token,
          pathname: key,
          onUploadCompleted: {
            callbackUrl: '', // set by U7 presign endpoint
            tokenPayload: key,
          },
        })
      )
      return { uploadId: clientPayload, key }
    } catch (err) {
      throw new StorageError({
        message: `Vercel Blob createMultipartUpload failed`,
        provider: 'blob',
        operation: 'createMultipartUpload',
        cause: err,
      })
    }
  }

  /**
   * Vercel Blob direct upload does not use parts.
   * The browser uploads the full file in one request using the client token.
   * This method is a no-op for Vercel Blob — it exists to satisfy the interface.
   */
  async uploadPart(
    _uploadId: string,
    _key: string,
    partNumber: number,
    _buffer: ArrayBuffer
  ): Promise<UploadPart> {
    // Vercel Blob direct upload sends the full file in one browser request.
    // There are no discrete parts on the server side.
    return { partNumber, etag: 'vercel-blob-direct' }
  }

  /**
   * For Vercel Blob, completeMultipartUpload is called after the browser
   * has finished the direct upload. The `uploadId` is the full Blob URL
   * returned by the browser after the direct upload completes.
   */
  async completeMultipartUpload(
    uploadId: string, // full Vercel Blob URL after direct upload
    key: string,
    filename: string,
    mimeType: string,
    _parts: UploadPart[]
  ): Promise<UploadResult> {
    // The file is already in Vercel Blob. Register the result.
    return {
      key: uploadId, // Vercel Blob URL is the key for deletion
      url: uploadId,
      filename,
      mimeType,
      size: 0, // overridden by confirm payload in U7
    }
  }

  async abortMultipartUpload(_uploadId: string, _key: string): Promise<void> {
    // Vercel Blob direct upload does not support abort.
    // If the browser upload fails, the partial upload is not persisted.
    // No server-side cleanup is needed.
  }
}
```

#### Key design note: `key` vs `url` for Vercel Blob

For Vercel Blob, the `media.key` column stores the full Vercel Blob CDN URL (e.g., `https://abc123.public.blob.vercel-storage.com/2026/05/V1StG-photo.jpg`). This is because `@vercel/blob`'s `del()` function requires the full URL, not a pathname. This is a documented `media.key` semantic difference for the Blob provider. The `StorageAdapter.delete()` contract says it accepts a `key: string` — for this provider, the key is the URL. The `media` table stores what the adapter returns as `key`, so deletion always works regardless of provider.

### Test Strategy

Mock `@vercel/blob` module entirely with `vi.mock('@vercel/blob')`. No HTTP interceptor needed since the SDK is mocked at the module level.

### Test Scenarios

1. **Happy path upload** — Mock `put()` to return a Blob URL. Assert `UploadResult.url` and `key` are the Blob URL.
2. **Delete** — Mock `del()` to resolve. Assert no error thrown.
3. **getSignedUrl** — Assert returns the key (URL) unchanged.
4. **Image dimensions** — For a JPEG buffer, assert `width` and `height` are populated.
5. **Token is passed** — Assert `put()` is called with `token: 'test-token'`.
6. **No token provided** — Construct adapter without token. TypeScript should catch this at compile time via the config type. At runtime, `@vercel/blob` will throw an error that gets wrapped as `StorageError`.

### Verification

- `VercelBlobStorageAdapter satisfies StorageAdapter` compiles without error.
- JSDoc on `getSignedUrl` clearly states the private-URL limitation.
- Package bundles with `sideEffects: false` for correct tree-shaking.

---

## U5: `@hono-cms/storage-local`

### Goal

Implement `StorageAdapter` for the local Node.js filesystem. This provider is explicitly for development use. It writes files to a configurable directory, serves them via a static route mounted by `createCMS`, and emits a visible warning when used outside a development environment.

### Requirements

- Write files to `config.dir` (default `'./uploads'`) using `node:fs/promises`.
- Create the upload directory and date-based subdirectories on first write if they do not exist (`mkdir` with `recursive: true`).
- Serve files via a `/uploads/*` static route. `createCMS` mounts this route when `provider: 'local'` is configured, using Hono's `serveStatic` middleware from `@hono/node-server/serve-static`.
- URL generation: `{baseUrl}/uploads/{key}`. Default `baseUrl`: `http://localhost:3000`. The port must match the port passed to `serve()` by the application — advise the developer to set `baseUrl` if running on a non-default port.
- Image dimension detection: use `image-size` (same as U2/U3/U4). For local provider, can also optionally use `sharp` if installed as an optional dependency — but `image-size` is the default to keep the dependency tree minimal and consistent with other providers.
- `delete()`: `node:fs/promises.unlink()`. Catch `ENOENT` (file not found) and return without throwing — idempotency.
- `getSignedUrl()`: Returns a plain URL without time-limiting. The local provider has no access control. Document this clearly — local provider is not for production.
- Multipart upload: implemented as repeated `ArrayBuffer` writes buffered in memory, assembled and written on `completeMultipartUpload`. This is intentionally naive — multipart on local is only needed for testing the presigned upload flow (U7), not for real large file handling.
- **Production warning**: On construction, check `process.env.NODE_ENV`. If it is not `'development'` and `config.allowInProduction !== true`, emit a `console.warn` with a clear message. If `NODE_ENV === 'production'` and `allowInProduction` is not explicitly set to `true`, throw a `StorageError` with a human-readable message to prevent silent data loss in production deployments.

### Dependencies

- U1 (StorageAdapter interface, StorageError, StorageConfig)

### Files

```
packages/storage-local/
  package.json                          ← name: @hono-cms/storage-local
  src/
    index.ts
    adapter.ts                          ← class LocalStorageAdapter implements StorageAdapter
    key.ts
    dimensions.ts
    serve-static.ts                     ← exports mountStaticRoute(app, dir, baseUrl)
  tests/
    adapter.test.ts
```

### Approach

#### `src/adapter.ts`

```typescript
import type { StorageAdapter, UploadResult, MultipartUploadInit, UploadPart } from '@hono-cms/schema'
import { StorageError } from '@hono-cms/schema'
import { mkdir, writeFile, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { generateKey } from './key'
import { extractDimensions } from './dimensions'

interface LocalAdapterConfig {
  dir?: string
  baseUrl?: string
  allowInProduction?: boolean
}

export class LocalStorageAdapter implements StorageAdapter {
  private dir: string
  private baseUrl: string
  // In-memory buffer map for multipart uploads (dev use only)
  private multipartBuffers: Map<string, ArrayBuffer[]> = new Map()

  constructor(config: LocalAdapterConfig = {}) {
    this.dir = resolve(config.dir ?? './uploads')
    this.baseUrl = config.baseUrl ?? 'http://localhost:3000'

    const nodeEnv = (typeof process !== 'undefined' && process.env.NODE_ENV) ?? 'development'
    if (nodeEnv === 'production' && !config.allowInProduction) {
      throw new StorageError({
        message:
          '[hono-cms] Local storage provider is not suitable for production. ' +
          'Files written to the local filesystem will be lost on process restart or ' +
          'serverless function cold start. Configure a production storage provider ' +
          '(r2, s3, or blob) or set `allowInProduction: true` to suppress this error.',
        provider: 'local',
        operation: 'upload',
        statusCode: 500,
      })
    }

    if (nodeEnv !== 'development') {
      console.warn(
        '[hono-cms] WARNING: Using local storage adapter outside of development. ' +
        'Data will not persist across deployments. Switch to r2, s3, or blob for production.'
      )
    }
  }

  async upload(file: {
    buffer: ArrayBuffer
    filename: string
    mimeType: string
    size: number
  }): Promise<UploadResult> {
    const key = generateKey(file.filename, '')
    const filePath = join(this.dir, key)
    const dims = extractDimensions(file.buffer, file.mimeType)
    try {
      await mkdir(join(this.dir, key.split('/').slice(0, -1).join('/')), { recursive: true })
      await writeFile(filePath, new Uint8Array(file.buffer))
    } catch (err) {
      throw new StorageError({
        message: `Local storage write failed: ${filePath}`,
        provider: 'local',
        operation: 'upload',
        cause: err,
      })
    }
    return {
      key,
      url: `${this.baseUrl}/uploads/${key}`,
      filename: file.filename,
      mimeType: file.mimeType,
      size: file.size,
      ...dims,
    }
  }

  async delete(key: string): Promise<void> {
    const filePath = join(this.dir, key)
    try {
      await unlink(filePath)
    } catch (err: any) {
      if (err.code === 'ENOENT') return // idempotent
      throw new StorageError({
        message: `Local storage delete failed: ${filePath}`,
        provider: 'local',
        operation: 'delete',
        cause: err,
      })
    }
  }

  /** Returns a plain URL. No time-limiting. Local provider has no access control. */
  async getSignedUrl(key: string, _expiresIn: number): Promise<string> {
    return `${this.baseUrl}/uploads/${key}`
  }

  async createMultipartUpload(
    filename: string,
    _mimeType: string
  ): Promise<MultipartUploadInit> {
    const key = generateKey(filename, '')
    const uploadId = `local-mp-${Date.now()}-${Math.random().toString(36).slice(2)}`
    this.multipartBuffers.set(uploadId, [])
    return { uploadId, key }
  }

  async uploadPart(
    uploadId: string,
    _key: string,
    partNumber: number,
    buffer: ArrayBuffer
  ): Promise<UploadPart> {
    const parts = this.multipartBuffers.get(uploadId)
    if (!parts) {
      throw new StorageError({
        message: `Unknown multipart upload: ${uploadId}`,
        provider: 'local',
        operation: 'uploadPart',
        statusCode: 400,
      })
    }
    parts[partNumber - 1] = buffer
    return { partNumber, etag: `local-etag-${partNumber}` }
  }

  async completeMultipartUpload(
    uploadId: string,
    key: string,
    filename: string,
    mimeType: string,
    parts: UploadPart[]
  ): Promise<UploadResult> {
    const buffers = this.multipartBuffers.get(uploadId)
    if (!buffers) {
      throw new StorageError({
        message: `Unknown multipart upload: ${uploadId}`,
        provider: 'local',
        operation: 'completeMultipartUpload',
        statusCode: 400,
      })
    }
    const totalSize = buffers.reduce((acc, b) => acc + b.byteLength, 0)
    const merged = new Uint8Array(totalSize)
    let offset = 0
    for (const buf of buffers) {
      merged.set(new Uint8Array(buf), offset)
      offset += buf.byteLength
    }
    this.multipartBuffers.delete(uploadId)
    return this.upload({ buffer: merged.buffer, filename, mimeType, size: totalSize })
  }

  async abortMultipartUpload(uploadId: string, _key: string): Promise<void> {
    this.multipartBuffers.delete(uploadId)
  }
}
```

#### `src/serve-static.ts` — Static route mounted by `createCMS`

```typescript
import type { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'

/**
 * Mount a static file serving route for local development.
 * Called by createCMS when storage provider is 'local'.
 */
export function mountStaticRoute(app: Hono<any>, uploadDir: string): void {
  app.use(
    '/uploads/*',
    serveStatic({
      root: uploadDir,
      rewriteRequestPath: (path) => path.replace(/^\/uploads/, ''),
    })
  )
}
```

`createCMS` calls `mountStaticRoute` only when `config.storage.provider === 'local'`. This avoids importing `@hono/node-server` in Workers bundles.

### Test Scenarios

1. **Production guard** — Construct adapter with `process.env.NODE_ENV = 'production'`. Assert `StorageError` is thrown.
2. **allowInProduction opt-out** — Same as above but with `allowInProduction: true`. Assert adapter constructs without throwing. Assert `console.warn` is called.
3. **Happy path upload** — Write a test JPEG buffer. Assert file exists at `dir/year/month/{id}-filename.jpg`. Assert `UploadResult.url` starts with `baseUrl`.
4. **Delete** — Upload then delete. Assert file no longer exists on disk.
5. **Delete ENOENT** — Delete a key that was never uploaded. Assert no error thrown.
6. **Multipart flow** — Create multipart upload, upload 3 parts, complete. Assert assembled file has correct content on disk.
7. **Abort multipart** — Create multipart upload, upload 1 part, abort. Assert `multipartBuffers` map is cleared.
8. **Directory creation** — Upload to a non-existent `dir`. Assert directory is created recursively.

### Verification

- `LocalStorageAdapter satisfies StorageAdapter` compiles.
- `mountStaticRoute` only imported in `createCMS` inside a `provider === 'local'` branch — confirmed by bundle analysis.
- Production guard test passes in CI with `NODE_ENV=production`.

---

## U6: Media Routes

### Goal

Implement REST handlers for the `/api/media` endpoints. These routes consume the `StorageAdapter` (injected via Hono context) and the database adapter (Plan 001). They enforce mime type whitelisting, file size limits, image dimension extraction, and DB persistence in a single atomic operation.

### Requirements

- `POST /api/media`: parse multipart form body, validate file, call `storage.upload()`, insert row into `media` table, return `MediaFile` object.
- `GET /api/media`: list media with pagination. TanStack Table / Virtual compatible response shape.
- `GET /api/media/{id}`: return single `MediaFile` metadata.
- `PATCH /api/media/{id}`: update `alt_text` and/or `caption` only. No re-upload.
- `DELETE /api/media/{id}`: lookup DB row → `storage.delete(row.key)` → delete DB row in a DB transaction. The transaction must wrap both operations — but note: storage delete is not transactional. The correct order is: (1) delete from storage, (2) delete from DB. If storage delete succeeds but DB delete fails, the file is gone from storage but the DB row remains — this is acceptable and correctable (the row references a non-existent key, a periodic cleanup job can reconcile). If DB delete succeeds but storage delete fails, we have an orphaned file — also acceptable and recoverable. The worse outcome is a dangling DB row pointing to a deleted file (no file, row exists), not an orphaned file (file exists, no row). Therefore: delete storage first, then delete DB row.
- `POST /api/media/presign`: returns presigned upload URL for large files (see U7).
- `POST /api/media/confirm`: registers a completed direct upload in the DB (see U7).
- Require authentication: all media endpoints require a valid better-auth session. Middleware applied at the `/api/media` route group level.
- Mime type whitelist: configurable in `createCMS`. Default: `['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'video/mp4', 'video/webm', 'application/pdf', 'text/plain']`.
- File size limit: configurable in `createCMS`. Default: 50MB for server-side upload, 1GB for presigned upload (enforced client-side — the CMS cannot enforce the limit on a direct upload it did not serve).
- `Content-Length` header must be present for server-side upload. If absent, reject with 411.

### Dependencies

- U1 (StorageAdapter, UploadResult, StorageError)
- Plan 001 (DatabaseAdapter, media table schema)
- Plan 006 (better-auth session middleware)

### Files

```
packages/core/src/content/media.ts          ← mountMediaRoutes(storage, db, config)
packages/core/src/content/media-schema.ts   ← Drizzle media table definition, MediaFile type
packages/core/src/content/media-validate.ts ← validateUpload(file, config): ValidationResult
```

### Approach

#### `packages/core/src/content/media-schema.ts` — Drizzle table

```typescript
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'

export const media = sqliteTable('media', {
  id:         text('id').primaryKey().$defaultFn(() => createId()),
  filename:   text('filename').notNull(),
  url:        text('url').notNull(),
  key:        text('key').notNull().unique(),
  mimeType:   text('mime_type').notNull(),
  size:       integer('size').notNull(),
  width:      integer('width'),
  height:     integer('height'),
  altText:    text('alt_text'),
  caption:    text('caption'),
  createdBy:  text('created_by').references(() => users.id),
  createdAt:  text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt:  text('updated_at').default(sql`(datetime('now'))`).notNull(),
})

export type MediaFile = typeof media.$inferSelect
export type MediaFileInsert = typeof media.$inferInsert
```

**Note on Postgres vs SQLite:** The table definition above uses `drizzle-orm/sqlite-core`. For Postgres adapters, the equivalent definition uses `drizzle-orm/pg-core` with `uuid` primary key and `timestamp` columns. `createCMS` determines which Drizzle core to use based on the DB adapter config (Plan 001). The `media-schema.ts` file exports a factory function `createMediaTable(dialect)` that returns the appropriate table definition. For this plan, the SQLite variant is shown as the canonical example.

#### `packages/core/src/content/media-validate.ts`

```typescript
export interface MediaUploadConfig {
  allowedMimeTypes: string[]
  maxServerUploadSizeBytes: number
}

export interface ValidationResult {
  ok: true
} | {
  ok: false
  status: 400 | 411 | 413 | 415
  message: string
}

export function validateUpload(
  file: { mimeType: string; size: number },
  config: MediaUploadConfig
): ValidationResult {
  if (!config.allowedMimeTypes.includes(file.mimeType)) {
    return {
      ok: false,
      status: 415,
      message: `Unsupported media type: ${file.mimeType}. Allowed: ${config.allowedMimeTypes.join(', ')}`,
    }
  }
  if (file.size > config.maxServerUploadSizeBytes) {
    return {
      ok: false,
      status: 413,
      message: `File too large: ${file.size} bytes. Maximum server upload size: ${config.maxServerUploadSizeBytes} bytes. Use the presigned upload flow for large files.`,
    }
  }
  return { ok: true }
}
```

#### `packages/core/src/content/media.ts` — Route handlers

```typescript
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import type { StorageAdapter, StorageError } from '@hono-cms/schema'
import type { DatabaseAdapter } from '@hono-cms/schema'
import { media } from './media-schema'
import { validateUpload, type MediaUploadConfig } from './media-validate'

const DEFAULT_ALLOWED_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif',
  'video/mp4', 'video/webm',
  'application/pdf', 'text/plain',
]

const DEFAULT_MAX_SERVER_UPLOAD_SIZE = 50 * 1024 * 1024 // 50MB

export function mountMediaRoutes(
  storage: StorageAdapter,
  db: DatabaseAdapter,
  config: Partial<MediaUploadConfig> = {}
): Hono {
  const app = new Hono()

  const uploadConfig: MediaUploadConfig = {
    allowedMimeTypes: config.allowedMimeTypes ?? DEFAULT_ALLOWED_MIME_TYPES,
    maxServerUploadSizeBytes: config.maxServerUploadSizeBytes ?? DEFAULT_MAX_SERVER_UPLOAD_SIZE,
  }

  // ── POST /api/media ─────────────────────────────────────────────────────────
  app.post('/', async (c) => {
    const session = c.get('session') // set by better-auth middleware
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const contentLength = Number(c.req.header('Content-Length'))
    if (!contentLength || isNaN(contentLength)) {
      return c.json({ error: 'Content-Length header required' }, 411)
    }

    const body = await c.req.parseBody()
    const file = body['file']

    if (!(file instanceof File)) {
      return c.json({ error: 'No file field found in multipart body' }, 400)
    }

    const mimeType = file.type || 'application/octet-stream'
    const size = file.size

    const validation = validateUpload({ mimeType, size }, uploadConfig)
    if (!validation.ok) {
      return c.json({ error: validation.message }, validation.status)
    }

    const buffer = await file.arrayBuffer()

    let result
    try {
      result = await storage.upload({
        buffer,
        filename: file.name,
        mimeType,
        size,
      })
    } catch (err) {
      const storageErr = err as StorageError
      return c.json(
        { error: storageErr.message, code: storageErr.providerCode },
        storageErr.statusCode ?? 500
      )
    }

    const row = await db.insert(media).values({
      filename: result.filename,
      url: result.url,
      key: result.key,
      mimeType: result.mimeType,
      size: result.size,
      width: result.width,
      height: result.height,
      createdBy: session.user.id,
    }).returning()

    return c.json(row[0], 201)
  })

  // ── GET /api/media ───────────────────────────────────────────────────────────
  app.get('/', async (c) => {
    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const page = Number(c.req.query('page') ?? 1)
    const pageSize = Math.min(Number(c.req.query('pageSize') ?? 50), 200)
    const mimeFilter = c.req.query('mimeType') // optional filter

    // Base query
    let query = db.select().from(media)
    if (mimeFilter) {
      query = query.where(eq(media.mimeType, mimeFilter)) as any
    }

    const [rows, countResult] = await Promise.all([
      query
        .orderBy(desc(media.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      db.select({ count: count() }).from(media),
    ])

    const total = countResult[0]?.count ?? 0

    return c.json({
      data: rows,
      meta: {
        pagination: {
          page,
          pageSize,
          total,
          pageCount: Math.ceil(total / pageSize),
        },
      },
    })
  })

  // ── GET /api/media/:id ───────────────────────────────────────────────────────
  app.get('/:id', async (c) => {
    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const id = c.req.param('id')
    const row = await db.select().from(media).where(eq(media.id, id)).limit(1)
    if (!row.length) return c.json({ error: 'Media not found' }, 404)
    return c.json(row[0])
  })

  // ── PATCH /api/media/:id ─────────────────────────────────────────────────────
  app.patch('/:id', async (c) => {
    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const id = c.req.param('id')
    const body = await c.req.json<{ altText?: string; caption?: string }>()

    const existing = await db.select().from(media).where(eq(media.id, id)).limit(1)
    if (!existing.length) return c.json({ error: 'Media not found' }, 404)

    const updated = await db.update(media)
      .set({
        altText: body.altText,
        caption: body.caption,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(media.id, id))
      .returning()

    return c.json(updated[0])
  })

  // ── DELETE /api/media/:id ────────────────────────────────────────────────────
  app.delete('/:id', async (c) => {
    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const id = c.req.param('id')
    const rows = await db.select().from(media).where(eq(media.id, id)).limit(1)
    if (!rows.length) return c.json({ error: 'Media not found' }, 404)

    const row = rows[0]

    // Delete from storage first. If this fails, the DB row remains (recoverable).
    try {
      await storage.delete(row.key)
    } catch (err) {
      const storageErr = err as StorageError
      return c.json(
        { error: `Storage delete failed: ${storageErr.message}` },
        storageErr.statusCode ?? 500
      )
    }

    // Delete from DB
    await db.delete(media).where(eq(media.id, id))

    return c.body(null, 204)
  })

  return app
}
```

### Test Scenarios

1. **Happy path upload** — POST multipart with a valid JPEG. Mock `storage.upload()` to return `UploadResult`. Assert DB insert is called, response is 201 with `MediaFile` shape.
2. **Unsupported mime type** — POST with `image/tiff` (not in whitelist). Assert 415 response with message listing allowed types.
3. **File too large** — POST with `size > maxServerUploadSizeBytes`. Assert 413 response with message mentioning presigned upload.
4. **Missing Content-Length** — POST without `Content-Length` header. Assert 411 response.
5. **Storage failure** — Mock `storage.upload()` to throw `StorageError`. Assert 500 response with provider error details.
6. **List pagination** — GET `/api/media?page=2&pageSize=10`. Assert offset/limit applied correctly and `meta.pagination` returned.
7. **Delete happy path** — Mock `storage.delete()` to resolve. Assert DB row deleted and 204 response.
8. **Delete — storage fails, DB row preserved** — Mock `storage.delete()` to throw. Assert DB row NOT deleted and 500 response.
9. **Delete — media not found** — DELETE for non-existent ID. Assert 404.
10. **PATCH — update alt text** — Assert only `altText` and `caption` fields are updated, not `url`, `key`, or `size`.
11. **Unauthenticated** — All endpoints without session. Assert 401.

### Verification

- Drizzle media table schema matches the spec (all columns, types, constraints).
- `DELETE` route deletes storage before DB — confirmed by test ordering.
- `POST /api/media` returns `Content-Type: application/json` with status 201.
- Media routes are mounted at `/api/media` by `createCMS` when `storage` is configured.

---

## U7: Presigned Upload Flow

### Goal

Provide a two-step upload flow for files that exceed the edge runtime body size limits: `POST /api/media/presign` generates a time-limited upload URL the browser uses directly, and `POST /api/media/confirm` registers the completed upload's metadata in the DB. This flow avoids routing the file through the CMS API for large files.

### Requirements

- `POST /api/media/presign` request body: `{ filename: string, mimeType: string, size: number }`.
- `POST /api/media/presign` response: `{ uploadUrl: string, uploadId: string, key: string, expiresAt: string }`.
  - For R2: returns a presigned PUT URL via `R2Bucket.createPresignedUrl` or multipart upload initiation.
  - For S3: returns a presigned PUT URL via `@aws-sdk/s3-request-presigner` for files below 100MB; initiates multipart for larger files.
  - For Vercel Blob: returns a client upload token via `generateClientTokenFromReadWriteToken`.
  - For local: returns the local upload URL (no real presigning — for development only).
- `POST /api/media/confirm` request body: `{ uploadId: string, key: string, filename: string, mimeType: string, size: number, width?: number, height?: number }`. Width and height are provided by the client — since the file was uploaded directly, the server has no way to extract dimensions without downloading it again.
- `POST /api/media/confirm` response: `MediaFile` object (same as `POST /api/media` response). Returns 201.
- Both endpoints require authentication.
- Size validation: `POST /api/media/presign` validates mime type from the whitelist. Size is validated against a `maxPresignUploadSizeBytes` config (default: 1GB for S3/R2, 500MB for Vercel Blob which enforces its own limits). The CMS cannot enforce the limit at the actual upload step (browser uploads directly), but it records the declared size and includes it in `media.size`.
- `uploadId` in confirm must match an active presign session. The CMS stores active presign sessions in the cache (Plan 015, Upstash Redis) with a TTL matching the presign expiry (default 1 hour). If no cache is configured, an in-memory map is used (dev only). Confirm calls against unknown `uploadId`s return 400.

### Dependencies

- U1 (StorageAdapter interface, multipart types)
- U2–U5 (concrete adapters — presign logic is provider-specific)
- U6 (media DB schema, `validateUpload`, `mountMediaRoutes` context)
- Plan 015 (cache layer for presign session storage)

### Files

```
packages/core/src/content/media-presign.ts   ← presign + confirm route handlers
packages/core/src/content/media.ts           ← updated to mount presign routes
```

### Approach

#### Presign session management

A presign session tracks: `{ uploadId, key, filename, mimeType, declaredSize, createdAt }`. Sessions expire after `presignExpirySeconds` (default 3600). Sessions are stored in the cache (Upstash Redis with TTL) if available, otherwise in an in-memory `Map<string, PresignSession>` (dev only).

```typescript
interface PresignSession {
  uploadId: string
  key: string
  filename: string
  mimeType: string
  declaredSize: number
  expiresAt: number // Unix timestamp
}
```

#### `packages/core/src/content/media-presign.ts`

```typescript
import { Hono } from 'hono'
import type { StorageAdapter } from '@hono-cms/schema'
import type { DatabaseAdapter, CacheAdapter } from '@hono-cms/schema'
import { media } from './media-schema'
import { validateUpload, type MediaUploadConfig } from './media-validate'
import { createId } from '@paralleldrive/cuid2'

export function mountPresignRoutes(
  storage: StorageAdapter,
  db: DatabaseAdapter,
  cache: CacheAdapter | null,
  config: MediaUploadConfig & { presignExpirySeconds?: number }
): Hono {
  const app = new Hono()

  // In-memory fallback for dev (when no cache adapter configured)
  const memSessions = new Map<string, PresignSession>()

  const presignExpiry = config.presignExpirySeconds ?? 3600

  const saveSession = async (s: PresignSession) => {
    if (cache) {
      await cache.set(`presign:${s.uploadId}`, JSON.stringify(s), { ex: presignExpiry })
    } else {
      memSessions.set(s.uploadId, s)
    }
  }

  const getSession = async (uploadId: string): Promise<PresignSession | null> => {
    if (cache) {
      const raw = await cache.get(`presign:${uploadId}`)
      return raw ? JSON.parse(raw as string) : null
    }
    return memSessions.get(uploadId) ?? null
  }

  const deleteSession = async (uploadId: string) => {
    if (cache) {
      await cache.del(`presign:${uploadId}`)
    } else {
      memSessions.delete(uploadId)
    }
  }

  // ── POST /api/media/presign ──────────────────────────────────────────────────
  app.post('/presign', async (c) => {
    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const body = await c.req.json<{ filename: string; mimeType: string; size: number }>()
    const { filename, mimeType, size } = body

    if (!filename || !mimeType || typeof size !== 'number') {
      return c.json({ error: 'filename, mimeType, and size are required' }, 400)
    }

    const validation = validateUpload(
      { mimeType, size },
      {
        ...config,
        // For presign, the size limit is higher — client enforces it
        maxServerUploadSizeBytes: config.maxPresignUploadSizeBytes ?? 1024 * 1024 * 1024,
      }
    )
    if (!validation.ok) {
      return c.json({ error: validation.message }, validation.status)
    }

    // Initiate provider-specific presigned upload
    let uploadUrl: string
    let uploadId: string
    let key: string

    try {
      const init = await storage.createMultipartUpload(filename, mimeType)
      uploadId = init.uploadId
      key = init.key

      // For S3/R2 that support true presigned PUT URLs, generate one.
      // For Vercel Blob, uploadId IS the client token (see U4).
      // For local, uploadId is a dev-only session ID.
      uploadUrl = await storage.getSignedUrl(key, presignExpiry)
    } catch (err) {
      return c.json({ error: 'Failed to generate presigned upload URL' }, 500)
    }

    const presignSession: PresignSession = {
      uploadId,
      key,
      filename,
      mimeType,
      declaredSize: size,
      expiresAt: Date.now() + presignExpiry * 1000,
    }
    await saveSession(presignSession)

    return c.json({
      uploadUrl,
      uploadId,
      key,
      expiresAt: new Date(presignSession.expiresAt).toISOString(),
    })
  })

  // ── POST /api/media/confirm ──────────────────────────────────────────────────
  app.post('/confirm', async (c) => {
    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const body = await c.req.json<{
      uploadId: string
      key: string
      filename: string
      mimeType: string
      size: number
      width?: number
      height?: number
    }>()

    const { uploadId } = body
    const presignSession = await getSession(uploadId)

    if (!presignSession) {
      return c.json(
        { error: 'Unknown uploadId. The presign session may have expired.' },
        400
      )
    }

    if (Date.now() > presignSession.expiresAt) {
      await deleteSession(uploadId)
      return c.json({ error: 'Presign session has expired' }, 400)
    }

    // Validate that the confirmed key matches the presign session key
    if (body.key !== presignSession.key) {
      return c.json({ error: 'Key mismatch between presign session and confirm payload' }, 400)
    }

    // Validate mime type again (defense in depth)
    const validation = validateUpload(
      { mimeType: body.mimeType, size: body.size },
      config
    )
    if (!validation.ok) {
      return c.json({ error: validation.message }, validation.status)
    }

    // Register in DB — the file is already in storage
    const row = await db.insert(media).values({
      filename: body.filename,
      url: '', // computed from key below
      key: body.key,
      mimeType: body.mimeType,
      size: body.size,
      width: body.width,
      height: body.height,
      createdBy: session.user.id,
    }).returning()

    await deleteSession(uploadId)

    // Fetch the signed URL for the response
    const url = await storage.getSignedUrl(body.key, 3600)
    const result = { ...row[0], url }

    return c.json(result, 201)
  })

  return app
}
```

**URL generation for the confirm response:** After inserting the DB row, `storage.getSignedUrl` is called to return a fresh URL in the response. For public providers (Vercel Blob, public R2/S3 buckets), this returns the public URL. For private providers, it returns a 1-hour signed URL. The `media.url` column stores the permanent URL computed at upload time — for private buckets, this is the base URL without signing query params. Clients fetch fresh signed URLs via `GET /api/media/{id}` when needed.

#### Mounting presign routes alongside media routes

```typescript
// packages/core/src/content/media.ts — updated mountMediaRoutes
export function mountMediaRoutes(storage, db, cache, config) {
  const app = new Hono()
  // ... existing routes (U6)
  app.route('/', mountPresignRoutes(storage, db, cache, config))
  return app
}
```

### Test Scenarios

1. **Presign happy path** — POST `/api/media/presign` with valid body. Assert `uploadUrl`, `uploadId`, `key`, `expiresAt` in response. Assert session stored in mock cache.
2. **Confirm happy path** — POST `/api/media/confirm` with valid `uploadId` matching stored session. Assert DB insert called, 201 response with `MediaFile`.
3. **Confirm — unknown uploadId** — POST confirm with random `uploadId`. Assert 400 with expiry message.
4. **Confirm — key mismatch** — POST confirm with correct `uploadId` but different `key`. Assert 400.
5. **Presign — invalid mime type** — POST presign with `image/bmp` (not in whitelist). Assert 415.
6. **Presign — expired session** — Store session with past `expiresAt`. POST confirm. Assert 400 and session deleted.
7. **Presign — no cache (in-memory fallback)** — Construct routes without cache adapter. Assert session stored in `memSessions`.
8. **Unauthenticated presign** — POST without session. Assert 401.
9. **Large file (S3 multipart)** — Mock `storage.createMultipartUpload` to return `uploadId` and `key`. Assert `uploadUrl` is generated from `getSignedUrl`.

### Verification

- `POST /api/media/presign` is mounted at the correct path under `/api/media`.
- Confirm deletes presign session from cache after use (prevents replay).
- Both routes require authentication — confirmed by unauthenticated test passing.

---

## Implementation Order

The units have the following dependency graph:

```
U1 (interface)
├── U2 (R2)        ← no deps on U3–U5
├── U3 (S3)        ← no deps on U2, U4–U5
├── U4 (Blob)      ← no deps on U2, U3, U5
├── U5 (Local)     ← no deps on U2–U4
└── U6 (Routes)    ← depends on U1
    └── U7 (Presign) ← depends on U1, U6
```

U2–U5 can be developed in parallel once U1 is stable. U6 can begin when U1 is complete and a mock adapter is available for testing. U7 begins after U6.

**Recommended sequence:**

1. U1 — Define all types and the factory. This is the only blocker for everything else.
2. U2 + U3 in parallel — Most critical providers for production use.
3. U6 — Media routes, using a mock adapter in tests.
4. U4 + U5 in parallel — Vercel Blob and local round out coverage.
5. U7 — Presign flow, after U6 is stable.

---

## Cross-Cutting Concerns

### CORS for direct uploads

When a browser performs a direct upload to R2 or S3 using a presigned URL, the storage provider must have a CORS policy configured to allow the `PUT` method from the CMS origin. This is infrastructure configuration, not code. The CMS documentation must include CORS configuration examples for each provider.

For R2: set `AllowedOrigins`, `AllowedMethods: ['PUT']`, and `AllowedHeaders: ['Content-Type']` in the Cloudflare R2 bucket CORS settings.

For S3: add a CORS rule via the AWS Console or `aws s3api put-bucket-cors`.

For Vercel Blob: CORS is handled automatically by the Vercel Blob service.

### Storage costs and orphaned files

The delete-storage-first ordering in `DELETE /api/media/{id}` (U6) means a failed DB delete leaves an orphaned DB row pointing to a deleted file. This is the less dangerous failure mode compared to the reverse. A periodic reconciliation job (runnable as a cron via Plan 017) can detect rows where `media.key` no longer exists in storage and clean them up.

### Media field in collection definitions

The `type: 'media'` field in a collection (e.g., `thumbnail: { type: 'media' }`) is a Drizzle relation `references(() => media.id)`. When a content document is deleted, the FK constraint prevents deletion if media rows are still referenced — the developer must set the field to `null` (or configure `onDelete: 'set null'`) before deleting the media. The CMS documents this constraint prominently.

### File serving for Vercel Blob and R2

Both Vercel Blob and public R2 buckets serve files directly at CDN URLs — no CMS route needed. For private R2 buckets, the CMS can optionally proxy reads through a `/api/media/serve/{key}` route that validates the session and serves the file. This proxy route is not implemented in this plan — it is a Plan extension for private-access media.

### No image optimization

Image optimization (resizing, format conversion, responsive variants) is explicitly out of scope. This plan provides dimension metadata at upload time. Optimization is left to: Cloudflare Images (`/cdn-cgi/image/`), Vercel's image optimization (`/_next/image` proxy), or imgix. The `url` stored in `media.url` is the raw file URL — transformations are applied by the frontend using the respective service's URL parameter API.

---

## Package Structure Summary

```
packages/
  schema/
    src/
      storage.ts          ← StorageAdapter, UploadResult, StorageConfig, StorageError (U1)
  core/
    src/
      storage/
        factory.ts        ← createStorageAdapter(config) (U1)
      content/
        media.ts          ← mountMediaRoutes (U6 + U7)
        media-schema.ts   ← Drizzle media table (U6)
        media-validate.ts ← validateUpload (U6)
        media-presign.ts  ← mountPresignRoutes (U7)
  storage-r2/             ← @hono-cms/storage-r2 (U2)
  storage-s3/             ← @hono-cms/storage-s3 (U3)
  storage-vercel-blob/    ← @hono-cms/storage-vercel-blob (U4)
  storage-local/          ← @hono-cms/storage-local (U5)
```

All four storage packages are peer-optional to `@hono-cms/core` — developers install only the one they need. Tree-shaking via dynamic imports in `factory.ts` ensures unused providers do not appear in production bundles.
