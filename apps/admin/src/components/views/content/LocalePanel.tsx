import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { Check, CircleAlert, CircleDashed, Globe2, Languages, RotateCcw } from "lucide-react";
import { type ReactElement } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { RecordLocaleEntry, RecordLocalesResponse, RecordLocaleStatus } from "../../../lib/api-client";
import { currentLocaleAtom } from "../../../state/admin-atoms";
import { useClient } from "../shared";

/**
 * Per-locale translation status presented in the record-edit rail.
 *
 * The backend speaks the translation-job vocabulary
 * (`complete | pending | in_progress | error | missing`); we map that into
 * a UI-friendly status used by {@link LocaleStatusBadge}. `error` is
 * surfaced so the retry button can recover from a failed provider call.
 */
export type LocaleStatus = "translated" | "pending" | "error" | "missing";

export type LocaleRow = {
  locale: string;
  status: LocaleStatus;
  /** Human label, falls back to the locale code. */
  label?: string;
  /** Provider error text to surface under the row when status is `"error"`. */
  error?: string;
};

/**
 * I18n config for the collection currently being edited. Derived from
 * `schema.collections[name].options.i18n` upstream. When undefined the
 * record-edit view should not render a LocalePanel at all, but the
 * connected component below also self-gates as a defensive measure.
 */
export type LocalePanelI18nConfig = {
  defaultLocale: string;
  locales: readonly string[];
};

export type LocalePanelProps = {
  /** Collection name this record belongs to. */
  collection: string;
  /**
   * Record identifier. When `null` (the user is on the `/new` route), the
   * panel renders nothing — translations only make sense for persisted
   * records.
   */
  recordId: string | null;
  /**
   * I18n configuration for the collection. When `null`/`undefined` the
   * collection is not localised and the panel renders nothing.
   */
  i18n: LocalePanelI18nConfig | null | undefined;
};

/**
 * Side-rail locale panel for the record editor. Lists every locale defined
 * on the active collection with its current translation status and offers
 * "Translate from {default}" / retry actions for non-default locales.
 *
 * Data flow:
 *   - `recordLocales(collection, id)` → React Query cache key
 *     `["record-locales", collection, id]` is the single source of truth
 *     for the rendered status. The connected `LocalePanel` invalidates
 *     this key after a successful translation so the badges update without
 *     a manual refresh.
 *   - `translateRecord(collection, id, { targetLocale })` runs the existing
 *     per-record translation endpoint. The same mutation handles initial
 *     translation and retry — `error` rows simply re-invoke it.
 */
export function LocalePanel(props: LocalePanelProps): ReactElement | null {
  // Self-gate: collections without i18n config never render a panel, and
  // unsaved records (`/new`) have nothing to translate yet.
  if (!props.i18n || props.i18n.locales.length === 0 || !props.recordId) return null;
  return (
    <ConnectedLocalePanel
      collection={props.collection}
      recordId={props.recordId}
      i18n={props.i18n}
    />
  );
}

function ConnectedLocalePanel(props: {
  collection: string;
  recordId: string;
  i18n: LocalePanelI18nConfig;
}): ReactElement {
  const client = useClient();
  const queryClient = useQueryClient();
  const queryKey = ["record-locales", props.collection, props.recordId] as const;
  const localesQuery = useQuery({
    queryKey,
    queryFn: () => client.recordLocales(props.collection, props.recordId)
  });
  const translate = useMutation({
    mutationFn: (targetLocale: string) =>
      client.translateRecord(props.collection, props.recordId, { targetLocale }),
    onSuccess: () => {
      // Invalidate so the locales list re-fetches and the row badge moves
      // from `pending`/`error` to `translated`.
      void queryClient.invalidateQueries({ queryKey });
      toast.success("Translation enqueued");
    },
    onError: (error) => {
      toast.error("Translation failed", {
        description: error instanceof Error ? error.message : "Try again"
      });
    }
  });

  const rows = localeRowsFromResponse(localesQuery.data, props.i18n);

  return (
    <LocalePanelView
      defaultLocale={props.i18n.defaultLocale}
      locales={rows}
      busy={translate.isPending || localesQuery.isFetching}
      onTranslate={(locale) => translate.mutate(locale)}
      pendingLocale={translate.isPending ? (translate.variables ?? null) : null}
    />
  );
}

/**
 * Pure presentational form of the panel. Exported so component tests can
 * exercise the render path without standing up React Query / fetch mocks.
 */
export function LocalePanelView(props: {
  defaultLocale: string;
  locales: readonly LocaleRow[];
  busy?: boolean;
  pendingLocale?: string | null;
  onTranslate(locale: string): void;
}): ReactElement {
  const [current, setCurrent] = useAtom(currentLocaleAtom);
  return (
    <aside
      aria-label="Locales"
      className="flex flex-col gap-3 rounded-lg border border-[#eaeaef] bg-white p-4"
    >
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-[#32324d]">
          <Languages size={16} />
          <h3 className="m-0 text-[14px] font-semibold">Locales</h3>
        </div>
        <Badge variant="outline" className="gap-1 text-[11px] font-medium">
          <Globe2 size={12} /> {props.defaultLocale} default
        </Badge>
      </header>
      <ul className="flex flex-col gap-2" role="list">
        {props.locales.map((row) => {
          const isDefault = row.locale === props.defaultLocale;
          const isActive = (current ?? props.defaultLocale) === row.locale;
          const isRowPending = props.pendingLocale === row.locale;
          return (
            <li
              key={row.locale}
              className={cn(
                "flex flex-col gap-2 rounded-md border p-3 text-sm",
                isActive ? "border-[#4945ff] bg-[#f0f0ff]" : "border-[#eaeaef] bg-transparent"
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  className="flex flex-col items-start gap-0.5 text-left"
                  onClick={() => setCurrent(isDefault ? null : row.locale)}
                  aria-pressed={isActive}
                  aria-label={`Switch to ${row.label ?? row.locale}`}
                >
                  <span className="font-medium text-[#32324d]">{row.label ?? row.locale}</span>
                  <span className="text-[11px] uppercase tracking-wider text-[#666687]">
                    {row.locale}
                    {isDefault ? " · default" : ""}
                  </span>
                </button>
                <LocaleStatusBadge status={row.status} />
              </div>
              {!isDefault && row.status === "error" && row.error ? (
                <p className="m-0 text-[11px] text-destructive" role="alert">
                  {row.error}
                </p>
              ) : null}
              {!isDefault && (row.status === "missing" || row.status === "error") ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="self-start"
                  disabled={props.busy || isRowPending}
                  onClick={() => props.onTranslate(row.locale)}
                  aria-label={
                    row.status === "error"
                      ? `Retry translation for ${row.label ?? row.locale}`
                      : `Translate ${row.label ?? row.locale} from ${props.defaultLocale}`
                  }
                >
                  {row.status === "error" ? (
                    <>
                      <RotateCcw size={14} aria-hidden /> Retry
                    </>
                  ) : (
                    <>Translate from {props.defaultLocale}</>
                  )}
                </Button>
              ) : null}
            </li>
          );
        })}
        {props.locales.length === 0 ? (
          <li className="rounded-md border border-dashed border-[#eaeaef] p-3 text-xs text-[#666687]">
            No locales defined for this collection.
          </li>
        ) : null}
      </ul>
    </aside>
  );
}

/**
 * Map the backend response shape onto the UI row model. Exported for unit
 * tests so the mapping is verifiable without a render.
 */
export function localeRowsFromResponse(
  response: RecordLocalesResponse | undefined,
  i18n: LocalePanelI18nConfig
): LocaleRow[] {
  const byLocale = new Map<string, RecordLocaleEntry>();
  for (const entry of response?.locales ?? []) byLocale.set(entry.locale, entry);
  return i18n.locales.map<LocaleRow>((locale) => {
    const entry = byLocale.get(locale);
    const row: LocaleRow = {
      locale,
      status: mapStatus(locale, entry?.status, i18n.defaultLocale)
    };
    if (entry?.error) row.error = entry.error;
    return row;
  });
}

function mapStatus(
  locale: string,
  status: RecordLocaleStatus | undefined,
  defaultLocale: string
): LocaleStatus {
  // The default locale is always considered translated — the source
  // record IS its translation.
  if (locale === defaultLocale) return "translated";
  if (!status) return "missing";
  if (status === "complete") return "translated";
  if (status === "pending" || status === "in_progress") return "pending";
  if (status === "error") return "error";
  return "missing";
}

function LocaleStatusBadge({ status }: { status: LocaleStatus }): ReactElement {
  if (status === "translated") {
    return (
      <Badge variant="outline" className="gap-1 border-emerald-300 text-emerald-700 dark:text-emerald-300">
        <Check size={12} /> Translated
      </Badge>
    );
  }
  if (status === "pending") {
    return (
      <Badge variant="outline" className="gap-1 border-amber-300 text-amber-700 dark:text-amber-300">
        <CircleDashed size={12} /> Pending
      </Badge>
    );
  }
  if (status === "error") {
    return (
      <Badge variant="outline" className="gap-1 border-red-300 text-red-700 dark:text-red-300">
        <CircleAlert size={12} /> Failed
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1 text-[#666687]">
      <CircleDashed size={12} /> Missing
    </Badge>
  );
}
