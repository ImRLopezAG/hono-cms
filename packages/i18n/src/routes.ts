import type { Hono } from "hono";
import type {
  AuthSession,
  ContentRecord,
  DatabaseAdapter,
  HonoCMSEnv,
  TranslationProvider,
  TranslationStore
} from "@hono-cms/core";
import type { CMSCollections } from "@hono-cms/schema";
import { TRANSLATION_JOB_ENDPOINT, type JobsEnqueue } from "./jobs";

export type MountI18nRoutesOptions<Collections extends CMSCollections> = {
  collections: Collections;
  db: DatabaseAdapter<Collections>;
  store: TranslationStore;
  /** Reads dynamically so the kernel/plugin DI can update the provider after mount. */
  getProvider: () => TranslationProvider | null | undefined;
  /** Reads dynamically so the runtime can become available after install. */
  getEnqueue: () => JobsEnqueue | null | undefined;
};

/**
 * Mount the admin-gated i18n backfill routes:
 *
 * - `POST /cms/admin/i18n/backfill` — enqueue translation jobs for every row
 *   in the localized collections, marking each target variant as `pending`.
 * - `GET /cms/admin/i18n/backfill/status` — return per-collection counts of
 *   the variants in each status so admin UIs can render a progress bar.
 *
 * Both routes return 401 for anonymous callers and 403 for non-admin sessions.
 * Validation errors return `{ error, issues? }` JSON with 4xx codes that
 * mirror the legacy core surface so existing OpenAPI specs stay accurate.
 */
export function mountI18nRoutes<Collections extends CMSCollections>(
  app: Hono<HonoCMSEnv>,
  opts: MountI18nRoutesOptions<Collections>
): void {
  app.post("/cms/admin/i18n/backfill", async (context) => {
    const denied = requireAdmin(context.get("session"));
    if (denied) return denied;
    const provider = opts.getProvider();
    if (!provider) return Response.json({ error: "translation_provider_not_configured" }, { status: 503 });
    const enqueue = opts.getEnqueue();
    if (!enqueue) return Response.json({ error: "jobs_not_configured" }, { status: 503 });
    const body: { locale?: string; collection?: string } = await context.req.json().catch(() => ({}));
    const targets = resolveI18nBackfillTargets(opts.collections, body);
    if (targets instanceof Response) return targets;

    let jobCount = 0;
    const collectionsBackfilled: Record<string, number> = {};
    for (const collectionName of targets.collections) {
      const records = await listAllRecords(opts.db, collectionName as keyof Collections & string);
      collectionsBackfilled[collectionName] = records.length;
      for (const record of records) {
        await opts.store.upsertVariant({
          collection: collectionName,
          documentId: record.id,
          locale: targets.locale,
          status: "pending",
          translatedBy: "pending",
          sourceUpdatedAt: record.updatedAt
        });
        await enqueue(TRANSLATION_JOB_ENDPOINT, {
          collection: collectionName,
          documentId: record.id,
          targetLocale: targets.locale
        });
        jobCount += 1;
      }
    }

    return Response.json({
      status: "enqueued",
      locale: targets.locale,
      collection: body.collection ?? null,
      jobCount,
      collections: collectionsBackfilled
    });
  });

  app.get("/cms/admin/i18n/backfill/status", async (context) => {
    const denied = requireAdmin(context.get("session"));
    if (denied) return denied;
    const url = new URL(context.req.url);
    const locale = url.searchParams.get("locale") ?? undefined;
    const collection = url.searchParams.get("collection") ?? undefined;
    const targetInput: { locale?: string; collection?: string } = {};
    if (locale) targetInput.locale = locale;
    if (collection) targetInput.collection = collection;
    const targets = resolveI18nBackfillTargets(opts.collections, targetInput);
    if (targets instanceof Response) return targets;

    const collections = await Promise.all(
      targets.collections.map(async (collectionName) => {
        const records = await listAllRecords(opts.db, collectionName as keyof Collections & string);
        const variants = await Promise.all(
          records.map((record) => opts.store.getVariant(collectionName, record.id, targets.locale))
        );
        return {
          collection: collectionName,
          total: records.length,
          missing: variants.filter((variant) => !variant).length,
          pending: variants.filter((variant) => variant?.status === "pending").length,
          inProgress: variants.filter((variant) => variant?.status === "in_progress").length,
          complete: variants.filter((variant) => variant?.status === "complete").length,
          error: variants.filter((variant) => variant?.status === "error").length
        };
      })
    );
    const totals = collections.reduce(
      (acc, item) => ({
        total: acc.total + item.total,
        missing: acc.missing + item.missing,
        pending: acc.pending + item.pending,
        inProgress: acc.inProgress + item.inProgress,
        complete: acc.complete + item.complete,
        error: acc.error + item.error
      }),
      { total: 0, missing: 0, pending: 0, inProgress: 0, complete: 0, error: 0 }
    );
    return Response.json({ locale: targets.locale, collection: collection ?? null, totals, collections });
  });
}

/**
 * Resolve which collections + locale to backfill given the user-supplied
 * input. Mirrors the validation surface of the legacy core handler so admin
 * UIs receive the same 4xx error shapes they were built against.
 */
export function resolveI18nBackfillTargets(
  collections: CMSCollections,
  input: { locale?: string; collection?: string }
): { locale: string; collections: string[] } | Response {
  if (!input.locale) {
    return Response.json(
      { error: "validation_error", issues: [{ path: ["locale"], message: "locale is required" }] },
      { status: 422 }
    );
  }
  const localizedCollections = Object.values(collections).filter((collection) => collection.options.i18n);
  const sourceCollections = input.collection
    ? localizedCollections.filter((collection) => collection.name === input.collection)
    : localizedCollections;
  if (input.collection && sourceCollections.length === 0) {
    return Response.json(
      {
        error: "i18n_not_enabled",
        issues: [{ path: ["collection"], message: `Collection "${input.collection}" is not localized.` }]
      },
      { status: 400 }
    );
  }
  if (sourceCollections.length === 0) {
    return Response.json({ error: "i18n_not_enabled" }, { status: 400 });
  }
  const unsupported = sourceCollections.find(
    (collection) => !collection.options.i18n?.locales.includes(input.locale as string)
  );
  if (unsupported) {
    return Response.json(
      {
        error: "unsupported_locale",
        issues: [
          { path: ["locale"], message: `Locale "${input.locale}" is not configured for "${unsupported.name}".` }
        ]
      },
      { status: 422 }
    );
  }
  const defaultLocale = sourceCollections.find(
    (collection) => collection.options.i18n?.defaultLocale === input.locale
  );
  if (defaultLocale) {
    return Response.json(
      {
        error: "validation_error",
        issues: [
          { path: ["locale"], message: `Locale "${input.locale}" is the default locale for "${defaultLocale.name}".` }
        ]
      },
      { status: 422 }
    );
  }
  return { locale: input.locale, collections: sourceCollections.map((collection) => collection.name) };
}

async function listAllRecords<Collections extends CMSCollections>(
  db: DatabaseAdapter<Collections>,
  collectionName: keyof Collections & string
): Promise<ContentRecord[]> {
  const items: ContentRecord[] = [];
  let cursor: string | undefined;
  do {
    const query: { limit: number; cursor?: string } = { limit: 200 };
    if (cursor) query.cursor = cursor;
    const result = await db.list(collectionName, query);
    items.push(...result.items);
    cursor = result.nextCursor;
  } while (cursor);
  return items;
}

function requireAdmin(session: AuthSession | null | undefined): Response | null {
  return session?.roles.includes("admin") ? null : Response.json({ error: "forbidden" }, { status: 403 });
}
