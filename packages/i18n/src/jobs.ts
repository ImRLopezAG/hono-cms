import type {
  ContentRecord,
  DatabaseAdapter,
  TranslationProvider,
  TranslationStore
} from "@hono-cms/core";
import type { CMSCollections, CollectionDefinition, FieldsDefinition } from "@hono-cms/schema";
import { translateDocument } from "./translate";

/** Name under which the i18n plugin registers its translation job. */
export const TRANSLATION_JOB_NAME = "translation";

/** Endpoint enqueued via `JobsService.enqueue` to drive translation work. */
export const TRANSLATION_JOB_ENDPOINT = "/cms/jobs/translation";

export type TranslationJobPayload = {
  collection?: string;
  documentId?: string;
  targetLocale?: string;
  sourceLocale?: string;
};

export type CreateTranslationJobOptions<Collections extends CMSCollections> = {
  collections: Collections;
  db: DatabaseAdapter<Collections>;
  store: TranslationStore;
  provider: TranslationProvider | null | undefined;
};

/**
 * Build the translation job handler. Returned function is shaped to match the
 * `JobHandler` contract exposed by `@hono-cms/jobs-runtime` — it accepts an
 * unknown payload and returns a value the dispatcher serializes as the job's
 * HTTP response body.
 *
 * Behaviour matches the legacy core implementation:
 * - Returns 503 `translation_provider_not_configured` when no provider is wired.
 * - Returns 422 `validation_error` when required fields are missing.
 * - Otherwise delegates to {@link translateDocument} and returns the persisted
 *   variant (or the validation `Response` it surfaces).
 */
export function createTranslationJob<Collections extends CMSCollections>(
  opts: CreateTranslationJobOptions<Collections>
) {
  return async (payload: unknown): Promise<unknown> => {
    if (!opts.provider) {
      return Response.json({ error: "translation_provider_not_configured" }, { status: 503 });
    }
    const body = isRecord(payload) ? (payload as TranslationJobPayload) : {};
    if (!body.collection || !body.documentId || !body.targetLocale) {
      return Response.json(
        {
          error: "validation_error",
          issues: [
            {
              path: ["collection", "documentId", "targetLocale"],
              message: "collection, documentId, and targetLocale are required"
            }
          ]
        },
        { status: 422 }
      );
    }
    return await translateDocument({
      collections: opts.collections,
      db: opts.db,
      store: opts.store,
      provider: opts.provider,
      collectionName: body.collection as keyof Collections & string,
      documentId: body.documentId,
      targetLocale: body.targetLocale,
      ...(body.sourceLocale ? { sourceLocale: body.sourceLocale } : {})
    });
  };
}

export type EnqueueTranslationOptions = {
  enabled?: boolean;
  translateOnPublish?: boolean;
};

export type JobsEnqueue = (
  endpoint: string,
  body?: unknown,
  opts?: { delay?: number }
) => Promise<void>;

/**
 * Enqueue translation jobs for every non-default locale configured on
 * `collection`, gating on the same rules the legacy core used:
 * - The collection must be localized.
 * - `options.enabled` must be `true`.
 * - When `translateOnPublish` is set, the record must have `status === "published"`.
 */
export async function enqueueTranslationJobs(
  enqueue: JobsEnqueue | null,
  collection: CollectionDefinition<string, FieldsDefinition>,
  record: ContentRecord,
  options?: EnqueueTranslationOptions
): Promise<void> {
  if (!enqueue || !collection.options.i18n || options?.enabled !== true) return;
  if (options.translateOnPublish && record.status !== "published") return;
  for (const locale of collection.options.i18n.locales) {
    if (locale === collection.options.i18n.defaultLocale) continue;
    await enqueue(TRANSLATION_JOB_ENDPOINT, {
      collection: collection.name,
      documentId: record.id,
      targetLocale: locale
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
