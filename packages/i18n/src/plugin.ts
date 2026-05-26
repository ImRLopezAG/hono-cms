import {
  createPlugin,
  type CMSEvents,
  type ContentRecord,
  type Plugin,
  type TranslationProvider,
  type TranslationStore
} from "@hono-cms/core";
import type { CMSCollections, CollectionDefinition, FieldsDefinition } from "@hono-cms/schema";
import { createTranslationJob, enqueueTranslationJobs, TRANSLATION_JOB_NAME, type JobsEnqueue } from "./jobs";
import { mountI18nRoutes } from "./routes";
import { MemoryTranslationStore } from "./store/memory";
import { TRANSLATIONS_TABLE, translationsTable } from "./tables";

/** Plugin id under which the i18n plugin self-registers on the plugin registry. */
export const I18N_PLUGIN_ID = "i18n";

export type I18nConfig = {
  /**
   * Translation engine used by the registered `translation` job. Optional —
   * the plugin still mounts the backfill routes and overlay helpers without
   * a provider, but `POST /cms/admin/i18n/backfill` and the job handler will
   * return `503 translation_provider_not_configured`.
   */
  provider?: TranslationProvider;
  /**
   * Persistent backend for locale variants. Defaults to an in-memory store —
   * production deployments should provide `createDrizzleTranslationStore({ db, ... })`
   * or any custom implementation of `TranslationStore`.
   */
  store?: TranslationStore;
  /**
   * When `true`, every localized save fans out one `/cms/jobs/translation`
   * job per non-default locale on the collection. Defaults to `false` so
   * existing deployments don't suddenly start spending provider tokens.
   */
  autoTranslate?: boolean;
  /**
   * When `true` (in combination with `autoTranslate`), translation jobs are
   * only enqueued for records whose `status === "published"`. Defaults to
   * `false` — drafts trigger translation alongside published rows.
   */
  translateOnPublish?: boolean;
};

/**
 * Service exposed on the plugin registry (`ctx.plugins.get("i18n")`) for
 * tests + sibling plugins that need direct access to the configured store +
 * provider without re-instantiating them.
 */
export type I18nService = {
  readonly store: TranslationStore;
  readonly provider: TranslationProvider | null;
  readonly config: Required<Pick<I18nConfig, "autoTranslate" | "translateOnPublish">>;
};

type JobsService = {
  registerJob: (name: string, handler: (payload: unknown) => unknown | Promise<unknown>) => void;
  enqueue: JobsEnqueue;
};

/**
 * Build the i18n plugin manifest.
 *
 * Owns:
 * - The `translations` system table declaration (so drizzle-backed stores get
 *   migrated automatically via the kernel's schema-merge surface).
 * - `POST /cms/admin/i18n/backfill` + `GET /cms/admin/i18n/backfill/status`
 *   admin routes for kicking off and observing translation backfills.
 * - The `translation` job registered with `@hono-cms/jobs-runtime` (when
 *   present) so other plugins can drive translations through the shared HTTP
 *   surface or in-process dispatcher.
 * - The `content:after-publish` hook that fans out per-locale translation
 *   jobs when `translateOnPublish: true`. The legacy `autoTranslate` path
 *   (fire on every save) requires the host runtime to call
 *   {@link enqueueTranslationJobs} directly because there is no
 *   `content:after-save` event today.
 *
 * `requires: ["jobs"]` — the kernel rejects installation when the
 * `jobs-runtime` plugin is missing, since the backfill routes and translation
 * job handler both depend on it.
 *
 * ```ts
 * createCMS({
 *   plugins: [
 *     jobsRuntime({ adapter: memoryJobs({}) }),
 *     i18n({ provider, translateOnPublish: true })
 *   ]
 * });
 * ```
 */
export function i18n(opts: I18nConfig = {}): Plugin {
  const store = opts.store ?? new MemoryTranslationStore();
  const provider = opts.provider ?? null;
  const config = {
    autoTranslate: opts.autoTranslate ?? false,
    translateOnPublish: opts.translateOnPublish ?? false
  } satisfies I18nService["config"];

  return createPlugin({
    id: I18N_PLUGIN_ID,
    requires: ["jobs"],

    schema: {
      [TRANSLATIONS_TABLE]: translationsTable
    },

    async app(app, ctx) {
      // Publish the service so tests + sibling plugins can reach the store and
      // provider without re-instantiating them.
      ctx.plugins.register(I18N_PLUGIN_ID, {
        store,
        provider,
        config
      } satisfies I18nService);

      // ---- Jobs runtime integration -------------------------------------
      //
      // `requires: ["jobs"]` guarantees the runtime is installed first; pull
      // the service so we can register the `translation` job and expose an
      // `enqueue` thunk to the routes.
      const jobs = ctx.plugins.get<JobsService>("jobs");
      const translationJob = createTranslationJob({
        collections: ctx.collections,
        db: ctx.db,
        store,
        provider
      });
      jobs.registerJob(TRANSLATION_JOB_NAME, async (payload) => {
        await translationJob(payload);
      });

      // ---- Admin routes -------------------------------------------------
      mountI18nRoutes(app, {
        collections: ctx.collections,
        db: ctx.db,
        store,
        getProvider: () => provider,
        getEnqueue: () => jobs.enqueue
      });

      // ---- Translate-on-publish event hook ------------------------------
      //
      // When the host emits `content:after-publish`, fan out translation jobs
      // for every non-default locale on the collection. Gated on
      // `translateOnPublish: true` so deployments opting out keep paying zero.
      if (config.translateOnPublish) {
        ctx.events.on("content:after-publish", async (payload: CMSEvents["content:after-publish"]) => {
          const collection = lookupCollection(ctx.collections, payload.collection);
          if (!collection) return;
          await enqueueTranslationJobs(jobs.enqueue, collection, payload.record, {
            enabled: true,
            translateOnPublish: true
          });
        });
      }
    }
  });
}

/** Best-effort lookup that handles both the keyed-map and array-of-defs shapes. */
function lookupCollection(
  collections: CMSCollections,
  name: string
): CollectionDefinition<string, FieldsDefinition> | null {
  const direct = (collections as Record<string, CollectionDefinition<string, FieldsDefinition>>)[name];
  if (direct?.name) return direct;
  for (const candidate of Object.values(collections) as CollectionDefinition<string, FieldsDefinition>[]) {
    if (candidate?.name === name) return candidate;
  }
  return null;
}

export { enqueueTranslationJobs, type ContentRecord };
