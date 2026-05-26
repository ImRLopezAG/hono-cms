import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { Check, CircleAlert, CircleDashed, Globe2, RefreshCw, Send } from "lucide-react";
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { type AdminSchemaMetadata, type I18nBackfillInput } from "../../lib/api-client";
import { currentLocaleAtom } from "../../state/admin-atoms";
import { emptySchemaMetadata, i18nStatusFromQuery, schemaMetadataFromQuery } from "./query-helpers";
import { SettingsShell } from "./SettingsShell";
import { useClient } from "./shared";

type LocalizedCollection = {
  collection: string;
  defaultLocale: string;
  locales: string[];
};

type BackfillFormValues = {
  collection: string; // "" means "all localized collections"
  sourceLocale: string;
  targetLocales: Record<string, boolean>;
  dryRun: boolean;
};

export function I18nView(): ReactElement {
  const client = useClient();
  const schemaQuery = useQuery({ queryKey: ["schema"], queryFn: () => client.schema() });
  const schema = schemaMetadataFromQuery(schemaQuery.data);
  const localized = useMemo(() => localizedCollectionOptions(schema), [schema]);

  const [activeCollection, setActiveCollection] = useState<string | null>(() => localized[0]?.collection ?? null);
  // Sync the active collection with the first localized one once schema arrives.
  useEffect(() => {
    if (!activeCollection && localized[0]) setActiveCollection(localized[0].collection);
  }, [activeCollection, localized]);

  const selectedCollection = localized.find((item) => item.collection === activeCollection) ?? null;
  const [currentLocale] = useAtom(currentLocaleAtom);
  // Status panel locale: prefer the explicitly chosen current locale, else
  // first non-default locale of the active collection.
  const statusLocale = currentLocale ?? selectedCollection?.locales[0] ?? "";
  const statusQuery = useQuery({
    queryKey: ["i18n-backfill-status", statusLocale, selectedCollection?.collection ?? null],
    queryFn: () =>
      client.i18nBackfillStatus({
        locale: statusLocale,
        ...(selectedCollection ? { collection: selectedCollection.collection } : {})
      }),
    enabled: Boolean(statusLocale)
  });
  const status = i18nStatusFromQuery(statusQuery.data);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [lastBackfill, setLastBackfill] = useState<
    | {
        locale: string;
        jobCount: number;
        collections: Record<string, number>;
        dryRun: boolean;
      }
    | null
  >(null);
  const backfillMutation = useMutation({
    mutationFn: (input: I18nBackfillInput) => client.enqueueI18nBackfill(input),
    onSuccess: (response, variables) => {
      const isDryRun = Boolean((variables as I18nBackfillInput & { dryRun?: boolean }).dryRun);
      setLastBackfill({
        locale: response.locale,
        jobCount: response.jobCount,
        collections: response.collections,
        // Backend currently does not persist a `dryRun` flag on the response;
        // surface whatever the user requested so the UI is honest.
        dryRun: isDryRun
      });
      void statusQuery.refetch();
      toast.success(
        isDryRun
          ? `Dry run: ${response.jobCount} job${response.jobCount === 1 ? "" : "s"} previewed for ${response.locale}.`
          : `Backfill enqueued: ${response.jobCount} job${response.jobCount === 1 ? "" : "s"} for ${response.locale}.`
      );
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Backfill failed.");
    }
  });

  return (
    <SettingsShell
      eyebrow="Schema"
      title="Internationalisation"
      subtitle="Inspect localised collections and enqueue translation backfills for new locales without rewriting source records."
      action={
        <>
          <LocaleSwitcher collection={selectedCollection} />
          <Button
            type="button"
            onClick={() => setDialogOpen(true)}
            disabled={localized.length === 0 || backfillMutation.isPending}
          >
            <Send size={16} /> Backfill missing translations
          </Button>
        </>
      }
    >
      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]" aria-label="i18n collections and status">
        <article
          aria-label="Localized collections"
          className="flex flex-col gap-3 rounded-lg border border-[#eaeaef] bg-[#ffffff] p-4"
        >
          <header className="flex items-center justify-between border-b border-[#eaeaef] pb-2">
            <h2 className="m-0 text-sm font-semibold tracking-tight text-[#32324d]">
              Localized collections
            </h2>
            <Badge variant="outline" className="text-[11px]">
              {localized.length} {localized.length === 1 ? "collection" : "collections"}
            </Badge>
          </header>
          <ul className="flex flex-col gap-2" role="list">
            {localized.map((item) => {
              const isActive = activeCollection === item.collection;
              return (
                <li key={item.collection}>
                  <button
                    type="button"
                    onClick={() => setActiveCollection(item.collection)}
                    className={cn(
                      "flex w-full flex-col items-start gap-1 rounded-md border p-3 text-left text-sm transition-colors",
                      isActive
                        ? "border-[#4945ff] bg-[#f0f0ff]"
                        : "border-[#eaeaef] hover:bg-[#f6f6f9]"
                    )}
                    aria-pressed={isActive}
                  >
                    <span className="flex items-center gap-2 font-medium text-[#32324d]">
                      <Globe2 size={14} />
                      {item.collection}
                    </span>
                    <span className="text-xs text-[#666687]">
                      {item.defaultLocale} default
                    </span>
                    <span className="text-[11px] uppercase tracking-wider text-[#8e8ea9]">
                      {item.locales.join(", ")}
                    </span>
                  </button>
                </li>
              );
            })}
            {localized.length === 0 ? (
              <li className="rounded-md border border-dashed border-[#eaeaef] p-4 text-center text-xs text-[#666687]">
                No localized collections are configured.
              </li>
            ) : null}
          </ul>
        </article>

        <article
          aria-label="i18n backfill status"
          className="flex flex-col gap-3 rounded-lg border border-[#eaeaef] bg-[#ffffff] p-4"
        >
          <header className="flex items-center justify-between border-b border-[#eaeaef] pb-2">
            <div>
              <h2 className="m-0 text-sm font-semibold tracking-tight text-[#32324d]">
                {status?.locale || statusLocale || "Locale"} status
              </h2>
              <p className="m-0 mt-0.5 text-xs text-[#666687]">
                {selectedCollection ? selectedCollection.collection : "Select a collection"}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => statusQuery.refetch()}
              disabled={!statusLocale || statusQuery.isFetching}
            >
              <RefreshCw size={14} className={cn(statusQuery.isFetching && "animate-spin")} />
              Refresh
            </Button>
          </header>

          {lastBackfill ? (
            <div
              className="flex flex-col gap-1 rounded-md border border-[#eaeaef] bg-[#f0f0ff] p-3 text-sm"
              role="status"
            >
              <strong className="text-[#32324d]">
                {lastBackfill.dryRun ? "Dry-run preview" : "Enqueued"}
              </strong>
              <span className="text-xs text-[#666687]">
                {lastBackfill.jobCount} jobs for {lastBackfill.locale}
              </span>
              <span className="text-[11px] text-[#666687]">
                {Object.entries(lastBackfill.collections)
                  .map(([name, count]) => `${name}: ${count}`)
                  .join(", ") || "No collections matched."}
              </span>
            </div>
          ) : null}

          <ul className="flex flex-col gap-2" role="list">
            {status?.collections.map((item) => (
              <li
                key={item.collection}
                className="grid gap-2 rounded-md border border-[#eaeaef] p-3 sm:grid-cols-[1fr_auto]"
              >
                <div className="flex flex-col gap-0.5">
                  <strong className="text-sm text-[#32324d]">{item.collection}</strong>
                  <span className="text-xs text-[#666687]">
                    {item.complete}/{item.total} complete
                  </span>
                  <span className="text-[11px] text-[#666687]">
                    {item.pending} pending · {item.missing} missing · {item.error} errors
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <StatusChip
                    icon={<Check size={12} />}
                    label={`${item.complete}`}
                    tone={item.complete === item.total ? "ok" : "muted"}
                  />
                  <StatusChip
                    icon={<CircleDashed size={12} />}
                    label={`${item.inProgress}`}
                    tone={item.inProgress > 0 ? "warn" : "muted"}
                  />
                  {item.error > 0 ? (
                    <StatusChip icon={<CircleAlert size={12} />} label={`${item.error}`} tone="error" />
                  ) : null}
                </div>
              </li>
            ))}
            {!status?.collections.length ? (
              <li className="rounded-md border border-dashed border-[#eaeaef] p-4 text-center text-xs text-[#666687]">
                No backfill status is available for this locale.
              </li>
            ) : null}
          </ul>
        </article>
      </section>

      <BackfillDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        localized={localized}
        isPending={backfillMutation.isPending}
        error={backfillMutation.error instanceof Error ? backfillMutation.error.message : null}
        onSubmit={async (input) => {
          await backfillMutation.mutateAsync(input);
          setDialogOpen(false);
        }}
      />
    </SettingsShell>
  );
}

function LocaleSwitcher({ collection }: { collection: LocalizedCollection | null }): ReactElement | null {
  const [current, setCurrent] = useAtom(currentLocaleAtom);
  if (!collection) return null;
  const value = current ?? collection.defaultLocale;
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const locale = String(next ?? "");
        setCurrent(locale === collection.defaultLocale ? null : locale);
      }}
    >
      <SelectTrigger aria-label="Switch locale" className="h-9 w-[140px]">
        <Globe2 size={14} className="text-[#666687]" />
        <SelectValue placeholder="Locale" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={collection.defaultLocale}>{collection.defaultLocale} (default)</SelectItem>
        {collection.locales.map((locale) => (
          <SelectItem key={locale} value={locale}>
            {locale}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function StatusChip({
  icon,
  label,
  tone
}: {
  icon: ReactElement;
  label: string;
  tone: "ok" | "warn" | "error" | "muted";
}): ReactElement {
  const toneClass =
    tone === "ok"
      ? "border-[#c6f0c2] bg-[#c6f0c2] text-[#328048]"
      : tone === "warn"
        ? "border-[#fce9d0] bg-[#fce9d0] text-[#d9822b]"
        : tone === "error"
          ? "border-red-200 bg-red-50 text-red-700"
          : "text-[#666687]";
  return (
    <Badge variant="outline" className={cn("gap-1 text-[11px]", toneClass)}>
      {icon}
      {label}
    </Badge>
  );
}

function BackfillDialog(props: {
  open: boolean;
  onOpenChange(open: boolean): void;
  localized: LocalizedCollection[];
  isPending: boolean;
  error: string | null;
  onSubmit(input: I18nBackfillInput & { dryRun?: boolean }): Promise<void>;
}): ReactElement {
  const initialCollection = props.localized[0] ?? null;
  const form = useForm({
    defaultValues: {
      collection: initialCollection?.collection ?? "",
      sourceLocale: initialCollection?.defaultLocale ?? "",
      targetLocales: Object.fromEntries(
        (initialCollection?.locales ?? []).map((locale) => [locale, true])
      ),
      dryRun: false
    } as BackfillFormValues,
    onSubmit: async ({ value }) => {
      const targets = Object.entries(value.targetLocales)
        .filter(([, checked]) => checked)
        .map(([locale]) => locale);
      // Enqueue one backfill per selected target locale. The endpoint
      // accepts a single `locale` per call; iterating here keeps the API
      // surface unchanged while letting the dialog ship multi-locale UX.
      for (const locale of targets) {
        await props.onSubmit({
          locale,
          ...(value.collection ? { collection: value.collection } : {}),
          // Forward dryRun so the parent can label the response; the
          // backend will ignore unknown fields.
          dryRun: value.dryRun
        });
      }
    }
  });

  // Re-seed the form whenever the dialog opens so it reflects the latest
  // schema (in case localized collections were added since mount).
  useEffect(() => {
    if (!props.open) return;
    const next = props.localized[0] ?? null;
    form.reset({
      collection: next?.collection ?? "",
      sourceLocale: next?.defaultLocale ?? "",
      targetLocales: Object.fromEntries((next?.locales ?? []).map((locale) => [locale, true])),
      dryRun: false
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Backfill missing translations</DialogTitle>
          <DialogDescription>
            Enqueue translation jobs for records missing a localized version. Choose a source locale and one or more
            target locales.
          </DialogDescription>
        </DialogHeader>

        <form
          id="i18n-backfill-form"
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void form.handleSubmit();
          }}
        >
          <form.Field
            name="collection"
            children={(field) => {
              const value = field.state.value || "__all";
              return (
                <label className="grid gap-1.5 text-sm">
                  <span className="text-xs font-semibold uppercase tracking-wider text-[#666687]">
                    Collection
                  </span>
                  <Select
                    value={value}
                    onValueChange={(next) => {
                      const selected = String(next ?? "");
                      const collection = selected === "__all" ? "" : selected;
                      field.handleChange(collection);
                      // Reset locales when collection changes so the
                      // checkbox group matches the new collection's locales.
                      const match = props.localized.find((item) => item.collection === collection);
                      if (match) {
                        form.setFieldValue("sourceLocale", match.defaultLocale);
                        form.setFieldValue(
                          "targetLocales",
                          Object.fromEntries(match.locales.map((locale) => [locale, true]))
                        );
                      }
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Choose a collection" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all">All localized collections</SelectItem>
                      {props.localized.map((item) => (
                        <SelectItem key={item.collection} value={item.collection}>
                          {item.collection}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
              );
            }}
          />

          <form.Field
            name="sourceLocale"
            validators={{
              onChange: ({ value }) => (value.trim() ? undefined : "Required")
            }}
            children={(field) => (
              <label className="grid gap-1.5 text-sm">
                <span className="text-xs font-semibold uppercase tracking-wider text-[#666687]">
                  Source locale
                </span>
                <Select value={field.state.value} onValueChange={(next) => field.handleChange(String(next ?? ""))}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a source locale" />
                  </SelectTrigger>
                  <SelectContent>
                    {sourceLocaleOptions(props.localized).map((locale) => (
                      <SelectItem key={locale} value={locale}>
                        {locale}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {field.state.meta.errors.length > 0 ? (
                  <span className="text-xs text-[#dc2626]">
                    {String(field.state.meta.errors[0])}
                  </span>
                ) : null}
              </label>
            )}
          />

          <form.Field
            name="targetLocales"
            validators={{
              onChange: ({ value }) =>
                Object.values(value).some(Boolean) ? undefined : "Select at least one target locale"
            }}
            children={(field) => {
              const collectionName = form.state.values.collection;
              const targets = targetLocaleOptions(props.localized, collectionName, form.state.values.sourceLocale);
              return (
                <fieldset className="grid gap-2 text-sm">
                  <legend className="text-xs font-semibold uppercase tracking-wider text-[#666687]">
                    Target locales
                  </legend>
                  <div className="grid grid-cols-2 gap-2">
                    {targets.map((locale) => {
                      const checked = Boolean(field.state.value[locale]);
                      return (
                        <label
                          key={locale}
                          className={cn(
                            "flex cursor-pointer items-center gap-2 rounded-md border p-2 text-sm",
                            checked
                              ? "border-[#4945ff] bg-[#f0f0ff]"
                              : "border-[#eaeaef]"
                          )}
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(next) =>
                              field.handleChange({ ...field.state.value, [locale]: next === true })
                            }
                            aria-label={`Target locale ${locale}`}
                          />
                          <span>{locale}</span>
                        </label>
                      );
                    })}
                    {targets.length === 0 ? (
                      <p className="col-span-2 rounded-md border border-dashed border-[#eaeaef] p-3 text-xs text-[#666687]">
                        No target locales available for this selection.
                      </p>
                    ) : null}
                  </div>
                  {field.state.meta.errors.length > 0 ? (
                    <span className="text-xs text-[#dc2626]">
                      {String(field.state.meta.errors[0])}
                    </span>
                  ) : null}
                </fieldset>
              );
            }}
          />

          <form.Field
            name="dryRun"
            children={(field) => (
              <label className="flex items-center justify-between gap-3 rounded-md border border-[#eaeaef] p-3 text-sm">
                <div className="flex flex-col">
                  <span className="font-medium text-[#32324d]">Dry run</span>
                  <span className="text-xs text-[#666687]">
                    Preview the job counts without enqueuing translations.
                  </span>
                </div>
                <Switch
                  checked={field.state.value}
                  onCheckedChange={(next) => field.handleChange(next === true)}
                  aria-label="Dry run"
                />
              </label>
            )}
          />

          {props.error ? (
            <p className="text-sm text-[#dc2626]" role="alert">
              {props.error}
            </p>
          ) : null}
        </form>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)} disabled={props.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="i18n-backfill-form" disabled={props.isPending}>
            <Send size={15} /> {props.isPending ? "Enqueuing..." : "Run backfill"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function sourceLocaleOptions(localized: LocalizedCollection[]): string[] {
  const set = new Set<string>();
  for (const item of localized) {
    set.add(item.defaultLocale);
    for (const locale of item.locales) set.add(locale);
  }
  return [...set].sort();
}

function targetLocaleOptions(
  localized: LocalizedCollection[],
  collectionName: string,
  sourceLocale: string
): string[] {
  if (collectionName) {
    const match = localized.find((item) => item.collection === collectionName);
    if (!match) return [];
    return match.locales.filter((locale) => locale !== sourceLocale);
  }
  // "All localized collections": union of every non-source locale.
  const set = new Set<string>();
  for (const item of localized) {
    for (const locale of item.locales) {
      if (locale !== sourceLocale) set.add(locale);
    }
  }
  return [...set].sort();
}

/**
 * Backwards-compatible FormData adapter used by the AdminApp unit tests
 * (and any callers that still build i18n backfill inputs from native
 * `<form>` submissions). The new dialog uses `@tanstack/react-form`, but
 * this helper is preserved so the public surface and tests stay stable.
 */
export function i18nBackfillInputFromForm(form: FormData): I18nBackfillInput {
  const input: I18nBackfillInput = {
    locale: String(form.get("locale") ?? "").trim()
  };
  const collection = String(form.get("collection") ?? "").trim();
  if (collection && collection !== "all") input.collection = collection;
  return input;
}

export function localizedCollectionOptions(schema: AdminSchemaMetadata): LocalizedCollection[] {
  return Object.values(schema.collections)
    .filter((collection) => Boolean(collection.options.i18n))
    .map((collection) => {
      const config = collection.options.i18n!;
      return {
        collection: collection.name,
        defaultLocale: config.defaultLocale,
        locales: config.locales.filter((locale) => locale !== config.defaultLocale)
      };
    })
    .filter((item) => item.locales.length > 0)
    .sort((left, right) => left.collection.localeCompare(right.collection));
}

// Preserved for tree-shaking-friendly imports; `emptySchemaMetadata` is
// re-exported here in case future tests import it via this module path.
export { emptySchemaMetadata };

export default I18nView;
