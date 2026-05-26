import { useForm } from "@tanstack/react-form";
import { useHotkeys } from "@tanstack/react-hotkeys";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData, type QueryKey } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useDebouncedCallback } from "@tanstack/react-pacer";
import { useAtom, useSetAtom } from "jotai";
import { ArrowLeft, CalendarClock, ChevronLeft, Columns3, Database, Eye, Filter, ListFilter, Plus, RotateCcw, Save, Search, Send, Trash2, X } from "lucide-react";
import { useQueryStates } from "nuqs";
import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { type AdminCollectionName, type AdminContentListResult, type AdminContentRecord, type AdminSchemaMetadata } from "../../lib/api-client";
import { collectionColumns, contentSearchField, fieldModels, formValuesFromRecord, recordInputFromValues, supportsDraftWorkflow, type FieldFormValues, type FieldRenderModel } from "../../lib/field-rendering";
import { contentSearchParsers, contentSearchToListOptions } from "../../lib/route-search";
import { activeCollectionAtom, dirtyFieldsAtom, selectedItemsAtom } from "../../state/admin-atoms";
import type { ContentRouteState } from "./auth-helpers";
import { useRail2Slot } from "./AppFrame";
import { ComponentControl } from "./content/ComponentControl";
import { DynamicZoneControl } from "./content/DynamicZoneControl";
import { LocalePanel } from "./content/LocalePanel";
import { MediaFieldControl } from "./content/MediaFieldControl";
import { RelationControl } from "./content/RelationControl";
import { RichTextControl } from "./content/RichTextControl";
import { readHiddenColumns, toggleHiddenColumn, visibleColumnIds, writeHiddenColumns } from "../../lib/column-visibility";
import { FILTER_OPERATORS, applyContentFilters, emptyFilter, filterIsActive, type ContentFilter, type ContentFilterOperator } from "../../lib/content-filters";
import { contentRecordsFromQuery, editorMutationErrorMessage, nextSortState, removeCollectionSelection, schemaMetadataFromQuery, selectedItemsByCollection, sortIndicator, sortParamFromState, sortStateFromRoute, toggleContentSelection, toggleVisibleContentSelection, updateContentListRecords, type AdminSortState, type ContentStatusFilter } from "./query-helpers";
import { CONTENT_PAGE_SIZE, EDITOR_HOTKEYS, collectionMetadata, useClient } from "./shared";

/* -------------------------------------------------------------------------- *
 *  ContentWorkspace — Strapi v5 ListView + EditView parity                   *
 *                                                                            *
 *  This file owns two distinct surfaces under the `/content` route tree:    *
 *                                                                            *
 *    1.  ListView    →  /content[/$collectionName]                          *
 *        Page header (eyebrow + collection name + record count + primary    *
 *        action), filter chip row, full-width table card, pagination.       *
 *                                                                            *
 *    2.  EditView    →  /content/$collectionName/$recordId | /new           *
 *        Sticky top bar (back + collection + record title + status pill +   *
 *        publish/save buttons), two-column body (form-card stack on the     *
 *        left, fixed-width Information rail on the right).                  *
 *                                                                            *
 *  Both surfaces share the **same collection rail** (Strapi's "Collection   *
 *  types" list). U4 moved the rail OUT of the main area and INTO `Rail 2`  *
 *  via `useRail2Slot`. The hook injects the rail node into the AppFrame    *
 *  context; leaving the route auto-clears the slot.                         *
 * -------------------------------------------------------------------------- */

export function ContentWorkspace({ collectionName = "", recordId = null, createNew = false, routeSearch }: ContentRouteState): ReactElement {
  const navigate = useNavigate();
  const [queryState, setQueryState] = useQueryStates(contentSearchParsers);
  const queryClient = useQueryClient();
  const setActiveCollection = useSetAtom(activeCollectionAtom);
  const [selectedItems, setSelectedItems] = useAtom(selectedItemsAtom);
  const search = routeSearch?.q ?? queryState.q;
  const statusFilter: ContentStatusFilter = routeSearch?.status ?? queryState.status;
  const sort = sortStateFromRoute(routeSearch?.sort ?? queryState.sort);
  const client = useClient();
  const schemaQuery = useQuery({ queryKey: ["schema"], queryFn: () => client.schema() });
  const schema = schemaMetadataFromQuery(schemaQuery.data);
  const collections = Object.keys(schema.collections);
  const activeCollection = schema.collections[collectionName] ? collectionName : collections[0] ?? "";
  const activeMetadata = collectionMetadata(schema, activeCollection);
  const searchField = contentSearchField(activeMetadata);
  const draftWorkflow = supportsDraftWorkflow(activeMetadata);
  const sortParam = sort ? `${sort.direction === "desc" ? "-" : ""}${sort.field}` : undefined;
  const trimmedSearch = search.trim();
  const listSearchState = { q: search, status: statusFilter, sort: sortParam ?? "-updatedAt" };
  const listOptions = contentSearchToListOptions(listSearchState, {
    limit: CONTENT_PAGE_SIZE,
    searchField,
    draftWorkflow
  });
  const query = useInfiniteQuery({
    queryKey: ["content", activeCollection, searchField, trimmedSearch, listOptions.status, listOptions.sort],
    queryFn: ({ pageParam }) => client.listContent(activeCollection, { ...listOptions, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    enabled: Boolean(schema.collections[activeCollection]),
    maxPages: 5
  });
  const records = contentRecordsFromQuery(query.data);
  const selected = createNew ? null : recordId ? records.find((record) => record.id === recordId) ?? null : null;
  const isEditing = createNew || Boolean(selected);
  const selectedIds = selectedItemsByCollection(selectedItems, activeCollection);
  useEffect(() => {
    setActiveCollection(activeCollection);
  }, [activeCollection, setActiveCollection]);
  useEffect(() => {
    setSelectedItems((current) => removeCollectionSelection(current, activeCollection));
  }, [activeCollection, searchField, trimmedSearch, listOptions.status, sortParam, setSelectedItems]);

  /* ----------------------------------------------------------------------- *
   *  Rail 2 — Collection rail                                               *
   *                                                                          *
   *  Strapi's content manager keeps "Collection Types" / "Single Types"    *
   *  visible in the section rail even while editing a record. We mirror    *
   *  that by registering the rail in AppFrame's Rail 2 slot for every     *
   *  /content* route, regardless of whether we're listing or editing.     *
   * ----------------------------------------------------------------------- */
  const rail2 = useMemo(
    () =>
      collections.length > 0 ? (
        <ContentRail
          collections={collections}
          schema={schema}
          activeCollection={activeCollection}
        />
      ) : null,
    [collections, schema, activeCollection]
  );
  useRail2Slot(rail2);

  const navigateToRecord = (nextRecordId: string | null) => {
    if (nextRecordId) {
      void navigate({ to: "/content/$collectionName/$recordId", params: { collectionName: activeCollection, recordId: nextRecordId } });
      return;
    }
    void navigate({ to: "/content/$collectionName", params: { collectionName: activeCollection } });
  };
  const navigateToNewRecord = () => {
    void navigate({ to: "/content/$collectionName/new", params: { collectionName: activeCollection } });
  };
  const clearSelected = () => setSelectedItems((current) => removeCollectionSelection(current, activeCollection));
  const optimisticBulkUpdate = async (ids: string[], action: "delete" | "publish" | "unpublish") => {
    await queryClient.cancelQueries({ queryKey: ["content", activeCollection] });
    const previous = queryClient.getQueriesData<InfiniteData<AdminContentListResult>>({ queryKey: ["content", activeCollection] });
    queryClient.setQueriesData<InfiniteData<AdminContentListResult>>({ queryKey: ["content", activeCollection] }, (data) => updateContentListRecords(data, ids, action));
    return { previous };
  };
  const restoreBulkUpdate = (context: { previous: Array<[QueryKey, InfiniteData<AdminContentListResult> | undefined]> } | undefined) => {
    context?.previous.forEach(([key, value]) => queryClient.setQueryData(key, value));
  };
  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      await Promise.all(ids.map((id) => client.deleteContent(activeCollection, id)));
      return ids;
    },
    onMutate: (ids) => optimisticBulkUpdate(ids, "delete"),
    onError: (error, _ids, context) => {
      restoreBulkUpdate(context);
      toast.error("Bulk delete failed", { description: error instanceof Error ? error.message : "Try again" });
    },
    onSuccess: (ids) => {
      clearSelected();
      toast.success(`Deleted ${ids.length} ${ids.length === 1 ? "record" : "records"}`);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["content", activeCollection] })
  });
  const bulkPublishMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      await Promise.all(ids.map((id) => client.publishContent(activeCollection, id)));
      return ids;
    },
    onMutate: (ids) => optimisticBulkUpdate(ids, "publish"),
    onError: (error, _ids, context) => {
      restoreBulkUpdate(context);
      toast.error("Bulk publish failed", { description: error instanceof Error ? error.message : "Try again" });
    },
    onSuccess: (ids) => {
      clearSelected();
      toast.success(`Published ${ids.length} ${ids.length === 1 ? "record" : "records"}`);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["content", activeCollection] })
  });
  const bulkUnpublishMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      await Promise.all(ids.map((id) => client.unpublishContent(activeCollection, id)));
      return ids;
    },
    onMutate: (ids) => optimisticBulkUpdate(ids, "unpublish"),
    onError: (error, _ids, context) => {
      restoreBulkUpdate(context);
      toast.error("Bulk unpublish failed", { description: error instanceof Error ? error.message : "Try again" });
    },
    onSuccess: (ids) => {
      clearSelected();
      toast.success(`Unpublished ${ids.length} ${ids.length === 1 ? "record" : "records"}`);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["content", activeCollection] })
  });
  const bulkBusy = bulkDeleteMutation.isPending || bulkPublishMutation.isPending || bulkUnpublishMutation.isPending;

  if (!collections.length) {
    return (
      <section className="flex h-full flex-col" aria-labelledby="hcms-content-title">
        <PageHeader
          eyebrow="Content"
          title="Workspace"
          subtitle="No collections are configured for this workspace."
        />
        <div className="flex min-h-0 flex-1 overflow-hidden bg-[#f6f6f9]">
          <div className="min-w-0 flex-1 overflow-auto px-10 py-6">
            <p className="rounded-lg border border-dashed border-[#eaeaef] bg-white/60 p-6 text-sm text-[#666687]">
              Add a content type from the schema editor to get started.
            </p>
          </div>
        </div>
      </section>
    );
  }

  if (isEditing) {
    return (
      <RecordEditor
        key={`${activeCollection}:${selected?.id ?? "new"}`}
        schema={schema}
        collectionName={activeCollection}
        record={selected}
        onBack={() => navigateToRecord(null)}
      />
    );
  }

  const recordCount = records.length;
  const recordLabel = recordCount === 1 ? "1 record found" : `${recordCount} records found`;
  const subtitleParts = [recordLabel];
  if (query.hasNextPage) subtitleParts.push("more available");
  if (draftWorkflow) subtitleParts.push("draft workflow");
  const subtitle = subtitleParts.join(" · ");

  return (
    <section className="flex h-full flex-col" aria-labelledby="hcms-content-title">
      <PageHeader
        eyebrow="Content"
        title={activeCollection}
        subtitle={subtitle}
        actions={
          <Button type="button" onClick={navigateToNewRecord}>
            <Plus size={15} aria-hidden="true" /> Create new entry
          </Button>
        }
      />
      <div className="min-w-0 flex-1 overflow-auto px-10 pb-10 pt-4">
        <ContentTable
          schema={schema}
          collectionName={activeCollection}
          records={records}
          selectedId={selected?.id ?? null}
          onSelect={navigateToRecord}
          onCreate={navigateToNewRecord}
          selectedIds={selectedIds}
          onToggleSelected={(id, sel) => setSelectedItems((current) => toggleContentSelection(current, activeCollection, id, sel))}
          onToggleAllVisible={(sel) => setSelectedItems((current) => toggleVisibleContentSelection(current, activeCollection, records.map((record) => record.id), sel))}
          onBulkDelete={() => bulkDeleteMutation.mutate(selectedIds)}
          onBulkPublish={() => bulkPublishMutation.mutate(selectedIds)}
          onBulkUnpublish={() => bulkUnpublishMutation.mutate(selectedIds)}
          bulkBusy={bulkBusy}
          hasMore={query.hasNextPage}
          loadingMore={query.isFetchingNextPage}
          onLoadMore={() => void query.fetchNextPage()}
          search={search}
          searchField={searchField}
          onSearchChange={(value) => {
            void setQueryState({ q: value });
            navigateToRecord(null);
          }}
          statusFilter={statusFilter}
          draftWorkflow={draftWorkflow}
          onStatusFilterChange={(value) => {
            void setQueryState({ status: value });
            navigateToRecord(null);
          }}
          sort={sort}
          onSortChange={(field) => {
            void setQueryState({ sort: sortParamFromState(nextSortState(sort, field)) });
            navigateToRecord(null);
          }}
        />
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- *
 *  PageHeader                                                                *
 *                                                                            *
 *  Strapi's `HeaderLayout` rendering. The eyebrow + title + subtitle stack  *
 *  on the left; primary action sits top-right. White background, soft       *
 *  bottom border, generous horizontal padding to match Strapi's gutter.    *
 * -------------------------------------------------------------------------- */

function PageHeader(props: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}): ReactElement {
  return (
    <div className="border-b border-[#eaeaef] bg-white px-10 pb-5 pt-6">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          {props.eyebrow && (
            <p className="m-0 text-[11px] font-semibold uppercase tracking-wider text-[#666687]">
              {props.eyebrow}
            </p>
          )}
          <h1
            id="hcms-content-title"
            className="m-0 mt-1 text-[28px] font-bold leading-tight tracking-tight text-[#32324d]"
          >
            {props.title}
          </h1>
          {props.subtitle && (
            <p className="mt-1 text-[13px] text-[#666687]">{props.subtitle}</p>
          )}
        </div>
        {props.actions && <div className="flex shrink-0 items-center gap-2">{props.actions}</div>}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 *  ContentRail — Rail 2 content for the Content Manager                      *
 *                                                                            *
 *  Strapi groups collection types into two sections: "Collection Types"     *
 *  and "Single Types". Our schema metadata exposes a single `collections`  *
 *  map, so we list every collection under "Collection Types" and reserve   *
 *  the empty "Single Types" header for visual parity.                       *
 *                                                                            *
 *  This component is wrapped in an explicit `aside` with                    *
 *  `aria-label="Collections"` so the existing Playwright spec               *
 *  (`content.spec.ts`) can locate the rail via                              *
 *  `getByRole("complementary", { name: /collections/i })`.                  *
 * -------------------------------------------------------------------------- */

function ContentRail(props: {
  collections: string[];
  schema: AdminSchemaMetadata;
  activeCollection: string;
}): ReactElement {
  const navigate = useNavigate();
  const [filter, setFilter] = useState("");
  const normalized = filter.trim().toLocaleLowerCase();
  const visible = useMemo(
    () =>
      normalized
        ? props.collections.filter((name) => name.toLocaleLowerCase().includes(normalized))
        : props.collections,
    [props.collections, normalized]
  );
  // The rail items are `<button>` (not `<Link>`) on purpose: the existing
  // Playwright spec looks them up via `getByRole("button", { name: /^<col>\s+<n>$/ })`,
  // so keeping the role stable matters more than the semantic upgrade to a link.
  const goTo = (name: string) => {
    void navigate({
      to: "/content/$collectionName",
      params: { collectionName: name },
      search: (current) => ({ ...current, status: "all" })
    });
  };
  return (
    <aside className="flex h-full flex-col gap-3 pb-4 pt-1" aria-label="Collections">
      <div className="px-3">
        <div className="relative">
          <Search
            size={14}
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8e8ea9]"
          />
          <Input
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.currentTarget.value)}
            placeholder="Search"
            aria-label="Search collection types"
            className="h-8 pl-7 text-[13px]"
          />
        </div>
      </div>
      <div className="flex items-center justify-between px-4 pt-1">
        <p className="m-0 text-[11px] font-semibold uppercase tracking-wider text-[#666687]">
          Collection types
        </p>
        <span className="rounded-[3px] bg-[#eaeaef] px-1.5 py-0.5 text-[10px] font-medium text-[#666687]">
          {props.collections.length}
        </span>
      </div>
      <ul className="m-0 flex flex-col gap-px px-2">
        {visible.map((name) => {
          const active = name === props.activeCollection;
          const fieldCount = Object.keys(props.schema.collections[name]?.fields ?? {}).length;
          return (
            <li key={name} className="list-none">
              <button
                type="button"
                onClick={() => goTo(name)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-9 w-full items-center justify-between gap-2 rounded-[4px] px-3 text-[13px] text-[#32324d] transition-colors",
                  "hover:bg-[#f6f6f9]",
                  active &&
                    "border-l-2 border-[#4945ff] bg-[#f0f0ff] pl-[10px] font-medium text-[#4945ff] hover:bg-[#f0f0ff]"
                )}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Database
                    size={13}
                    aria-hidden
                    className={cn("shrink-0 text-[#8e8ea9]", active && "text-[#4945ff]")}
                  />
                  <span className="truncate">{name}</span>
                </span>
                <span className="ml-2 shrink-0 rounded-full bg-transparent px-1.5 text-[10px] text-[#8e8ea9]">
                  {fieldCount}
                </span>
              </button>
            </li>
          );
        })}
        {visible.length === 0 && (
          <li className="list-none px-3 py-2 text-[12px] text-[#8e8ea9]">No collections match</li>
        )}
      </ul>
      <div className="mt-2 flex items-center justify-between px-4">
        <p className="m-0 text-[11px] font-semibold uppercase tracking-wider text-[#666687]">
          Single types
        </p>
        <span className="rounded-[3px] bg-[#eaeaef] px-1.5 py-0.5 text-[10px] font-medium text-[#666687]">
          0
        </span>
      </div>
    </aside>
  );
}

/* -------------------------------------------------------------------------- *
 *  ContentTable                                                              *
 * -------------------------------------------------------------------------- */

function ContentTable(props: {
  schema: AdminSchemaMetadata;
  collectionName: AdminCollectionName;
  records: AdminContentRecord[];
  selectedId: string | null;
  onSelect(id: string): void;
  onCreate(): void;
  selectedIds: string[];
  onToggleSelected(id: string, selected: boolean): void;
  onToggleAllVisible(selected: boolean): void;
  onBulkDelete(): void;
  onBulkPublish(): void;
  onBulkUnpublish(): void;
  bulkBusy: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore(): void;
  search: string;
  searchField: string | null;
  onSearchChange(value: string): void;
  statusFilter: ContentStatusFilter;
  draftWorkflow: boolean;
  onStatusFilterChange(value: ContentStatusFilter): void;
  sort: AdminSortState;
  onSortChange(field: string): void;
}): ReactElement {
  const collection = collectionMetadata(props.schema, props.collectionName);
  const parentRef = useRef<HTMLDivElement>(null);
  const allColumnIds = useMemo(() => collectionColumns(collection), [collection]);
  // Hidden-column ids persisted to localStorage keyed by collection.
  const [hiddenColumns, setHiddenColumns] = useState<string[]>(() => readHiddenColumns(props.collectionName));
  useEffect(() => {
    setHiddenColumns(readHiddenColumns(props.collectionName));
  }, [props.collectionName]);
  const persistHidden = (next: ReadonlyArray<string>) => {
    const snapshot = Array.from(next);
    setHiddenColumns(snapshot);
    writeHiddenColumns(props.collectionName, snapshot);
  };
  const visibleColumnSet = useMemo(() => new Set(visibleColumnIds(allColumnIds, hiddenColumns)), [allColumnIds, hiddenColumns]);
  // Strapi-style filter chips. Applied client-side against the current
  // page (see `applyContentFilters`).
  const [filters, setFilters] = useState<ContentFilter[]>([]);
  const filteredRecords = useMemo(() => applyContentFilters(props.records, filters), [props.records, filters]);
  const activeFilterCount = filters.filter(filterIsActive).length;
  const [bulkDeletePending, setBulkDeletePending] = useState(false);

  const columns = useMemo<ColumnDef<AdminContentRecord>[]>(
    () => allColumnIds.filter((key) => visibleColumnSet.has(key)).map((key) => ({
      accessorKey: key,
      header: () => (
        <button
          className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-[#32324d] hover:text-[#4945ff]"
          type="button"
          onClick={() => props.onSortChange(key)}
        >
          <span>{key}</span>
          <small className="text-[10px] text-[#8e8ea9]">{sortIndicator(props.sort, key)}</small>
        </button>
      ),
      cell: (info) => {
        const value = info.getValue();
        const strValue = String(value ?? "");
        const colKey = info.column.id;
        // Status badge rendering
        if (colKey === "status" || strValue === "published" || strValue === "draft") {
          if (strValue === "published") {
            return (
              <span className="rounded-[4px] bg-[#c6f0c2] px-2 py-0.5 text-[11px] font-medium text-[#328048]">
                Published
              </span>
            );
          }
          if (strValue === "draft") {
            return (
              <span className="rounded-[4px] bg-[#fce9d0] px-2 py-0.5 text-[11px] font-medium text-[#d9822b]">
                Draft
              </span>
            );
          }
        }
        return <span className="truncate text-[13px] text-[#32324d]">{strValue}</span>;
      }
    })),
    [allColumnIds, visibleColumnSet, props]
  );
  const table = useReactTable({ data: filteredRecords, columns, getCoreRowModel: getCoreRowModel() });
  const rows = table.getRowModel().rows;
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => parentRef.current, estimateSize: () => 54, overscan: 8 });
  const selectedIdSet = useMemo(() => new Set(props.selectedIds), [props.selectedIds]);
  const allVisibleSelected = filteredRecords.length > 0 && filteredRecords.every((record) => selectedIdSet.has(record.id));
  const someVisibleSelected = filteredRecords.some((record) => selectedIdSet.has(record.id));
  const headerCells = table.getHeaderGroups()[0]?.headers ?? [];

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3" aria-label={`${props.collectionName} records`}>
      {/* Filter chip row + add-filter trigger */}
      <FilterChipRow
        filters={filters}
        onChange={setFilters}
        columns={allColumnIds}
        search={props.search}
        searchField={props.searchField}
        onSearchChange={props.onSearchChange}
        statusFilter={props.statusFilter}
        draftWorkflow={props.draftWorkflow}
        onStatusFilterChange={props.onStatusFilterChange}
        hiddenColumns={hiddenColumns}
        onHiddenColumnsChange={persistHidden}
        activeFilterCount={activeFilterCount}
      />

      {/* Bulk-action toolbar (visible when ≥1 row selected) */}
      {props.selectedIds.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border border-[#4945ff]/30 bg-[#f0f0ff] px-3 py-2 text-sm"
          role="toolbar"
          aria-label="Bulk content actions"
        >
          <span className="font-medium text-[#4945ff]">{props.selectedIds.length} selected</span>
          <span className="text-xs text-[#4945ff]/70">Apply an action to all checked rows</span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {props.draftWorkflow && (
              <>
                <Button type="button" variant="outline" size="sm" onClick={props.onBulkPublish} disabled={props.bulkBusy}>
                  <Send size={15} /> Publish
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={props.onBulkUnpublish} disabled={props.bulkBusy}>
                  <RotateCcw size={15} /> Unpublish
                </Button>
              </>
            )}
            <Button type="button" variant="destructive" size="sm" onClick={() => setBulkDeletePending(true)} disabled={props.bulkBusy}>
              <Trash2 size={15} /> Delete
            </Button>
          </div>
        </div>
      )}
      <AlertDialog open={bulkDeletePending} onOpenChange={(open) => !open && setBulkDeletePending(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {props.selectedIds.length} {props.selectedIds.length === 1 ? "record" : "records"}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the selected {props.collectionName} entries. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={props.bulkBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-700"
              disabled={props.bulkBusy}
              onClick={() => {
                setBulkDeletePending(false);
                props.onBulkDelete();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Table card */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-[#eaeaef] bg-white shadow-sm">
        {/* Sticky table header */}
        <div className="flex items-center gap-3 border-b border-[#eaeaef] bg-[#f6f6f9] px-4 py-3">
          <div className="w-8 shrink-0">
            <Checkbox
              aria-label="Select visible records"
              checked={allVisibleSelected || someVisibleSelected}
              onCheckedChange={(checked) => props.onToggleAllVisible(checked === true)}
            />
          </div>
          {headerCells.map((header) => (
            <div
              key={header.id}
              className="min-w-0 flex-1 text-[11px] font-semibold uppercase tracking-wider text-[#32324d]"
            >
              {flexRender(header.column.columnDef.header, header.getContext())}
            </div>
          ))}
        </div>

        {/* Virtualised rows */}
        <div
          ref={parentRef}
          className="relative flex-1 overflow-auto"
          style={{ minHeight: 360 }}
          role="rowgroup"
          aria-label={`${props.collectionName} record rows`}
        >
          <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index];
              if (!row) return null;
              const isRowSelected = row.original.id === props.selectedId;
              return (
                <div
                  key={row.id}
                  role="row"
                  aria-selected={isRowSelected}
                  data-selected={isRowSelected}
                  className={cn(
                    "absolute inset-x-0 flex cursor-pointer items-center gap-3 border-b border-[#eaeaef] px-4 text-[13px] text-[#32324d] transition-colors",
                    "hover:bg-[#f6f6f9]",
                    "data-[selected=true]:bg-[#f0f0ff] data-[selected=true]:text-[#4945ff]"
                  )}
                  style={{ transform: `translateY(${virtualRow.start}px)`, height: "54px" }}
                  onClick={() => props.onSelect(row.original.id)}
                >
                  <div role="cell" className="w-8 shrink-0" onClick={(event) => event.stopPropagation()}>
                    <Checkbox
                      aria-label={`Select ${row.original.id}`}
                      checked={selectedIdSet.has(row.original.id)}
                      onCheckedChange={(checked) => props.onToggleSelected(row.original.id, checked === true)}
                    />
                  </div>
                  {row.getVisibleCells().map((cell) => (
                    <div key={cell.id} role="cell" className="min-w-0 flex-1 truncate">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </div>
                  ))}
                </div>
              );
            })}
            {rows.length === 0 && (
              <div className="flex h-40 flex-col items-center justify-center gap-2">
                <p className="text-sm font-medium text-[#32324d]">No records found</p>
                <p className="text-[13px] text-[#666687]">No records match the current filters.</p>
              </div>
            )}
          </div>
        </div>

        {/* Pagination footer */}
        <div className="flex items-center justify-end gap-4 border-t border-[#eaeaef] bg-white px-4 py-3 text-[12px] text-[#666687]">
          <span>
            {filteredRecords.length} {filteredRecords.length === 1 ? "row" : "rows"}
            {props.hasMore && " (more available)"}
          </span>
          {props.hasMore && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={props.onLoadMore}
              disabled={props.loadingMore}
            >
              {props.loadingMore ? "Loading..." : "Load more"}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- *
 *  FilterChipRow                                                             *
 *                                                                            *
 *  Strapi shows the active filters as pill-shaped chips above the table,    *
 *  with the search input and a "+ Filters" button to add new ones. Search   *
 *  + status + column-visibility share this row so the chrome lives in one   *
 *  place above the table card.                                               *
 * -------------------------------------------------------------------------- */

function FilterChipRow(props: {
  filters: ContentFilter[];
  onChange(next: ContentFilter[]): void;
  columns: ReadonlyArray<string>;
  search: string;
  searchField: string | null;
  onSearchChange(value: string): void;
  statusFilter: ContentStatusFilter;
  draftWorkflow: boolean;
  onStatusFilterChange(value: ContentStatusFilter): void;
  hiddenColumns: ReadonlyArray<string>;
  onHiddenColumnsChange(next: ReadonlyArray<string>): void;
  activeFilterCount: number;
}): ReactElement {
  const removeFilter = (id: string) => props.onChange(props.filters.filter((filter) => filter.id !== id));
  const activeChips = props.filters.filter(filterIsActive);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-[260px] flex-1">
        <Search
          size={14}
          aria-hidden
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#8e8ea9]"
        />
        <Input
          type="search"
          value={props.search}
          onChange={(event) => props.onSearchChange(event.currentTarget.value)}
          placeholder={props.searchField ? `Search ${props.searchField}` : "No searchable text field"}
          disabled={!props.searchField}
          aria-label="Search records"
          className="pl-8"
        />
      </div>
      {props.draftWorkflow && (
        <Select value={props.statusFilter} onValueChange={(value) => props.onStatusFilterChange(value as ContentStatusFilter)}>
          <SelectTrigger aria-label="Filter by status" className="w-[150px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All status</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="published">Published</SelectItem>
          </SelectContent>
        </Select>
      )}
      <FiltersPopover columns={props.columns} filters={props.filters} onChange={props.onChange} activeCount={props.activeFilterCount} />
      <ColumnVisibilityMenu columns={props.columns} hidden={props.hiddenColumns} onChange={props.onHiddenColumnsChange} />

      {activeChips.length > 0 && (
        <div className="flex w-full flex-wrap items-center gap-2 pt-1">
          {activeChips.map((filter) => {
            const operator = FILTER_OPERATORS.find((entry) => entry.value === filter.operator)?.label ?? filter.operator;
            return (
              <span
                key={filter.id}
                className="inline-flex items-center gap-1.5 rounded-full bg-[#eaeaef] px-2.5 py-1 text-[12px] text-[#32324d]"
              >
                <span className="font-medium">{filter.field}</span>
                <span className="text-[#666687]">{operator}</span>
                <span>{filter.value}</span>
                <button
                  type="button"
                  aria-label={`Remove filter ${filter.field}`}
                  className="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full text-[#666687] hover:bg-[#dcdce4] hover:text-[#32324d]"
                  onClick={() => removeFilter(filter.id)}
                >
                  <X size={11} aria-hidden />
                </button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 *  Filters popover                                                            *
 *                                                                             *
 *  Strapi's content-manager exposes a "Filters" popover separate from the    *
 *  status / search controls. Each filter is (field, operator, value) and    *
 *  multiple filters AND together. We match that shape.                       *
 * -------------------------------------------------------------------------- */

function FiltersPopover(props: { columns: ReadonlyArray<string>; filters: ContentFilter[]; onChange(next: ContentFilter[]): void; activeCount: number }): ReactElement {
  const addFilter = () => {
    const field = props.columns[0] ?? "id";
    props.onChange([...props.filters, emptyFilter(field)]);
  };
  const updateFilter = (id: string, patch: Partial<ContentFilter>) => {
    props.onChange(props.filters.map((filter) => (filter.id === id ? { ...filter, ...patch } : filter)));
  };
  const removeFilter = (id: string) => {
    props.onChange(props.filters.filter((filter) => filter.id !== id));
  };
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button type="button" variant="outline" size="sm" className="gap-1.5">
            <Filter size={14} aria-hidden /> Filters
            {props.activeCount > 0 && (
              <Badge variant="outline" className="ml-1 h-5 rounded-[3px] bg-[#f0f0ff] px-1.5 text-[10px] text-[#4945ff]">
                {props.activeCount}
              </Badge>
            )}
          </Button>
        }
      />
      <PopoverContent align="end" className="w-[420px]">
        <div className="flex items-center justify-between">
          <p className="text-[13px] font-medium">Filter records</p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={props.filters.length === 0}
            onClick={() => props.onChange([])}
          >
            Reset
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">All filters are combined with AND.</p>
        <div className="flex flex-col gap-2">
          {props.filters.length === 0 && (
            <p className="rounded-[4px] border border-dashed border-[#eaeaef] bg-[#f6f6f9] px-3 py-4 text-center text-xs text-[#666687]">
              No filters yet — add one to refine the visible records.
            </p>
          )}
          {props.filters.map((filter) => (
            <div key={filter.id} className="grid grid-cols-[1fr_120px_1fr_auto] items-center gap-1.5">
              <Select value={filter.field} onValueChange={(value) => updateFilter(filter.id, { field: value ?? "" })}>
                <SelectTrigger aria-label="Field" className="h-8 text-[12px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {props.columns.map((column) => (
                    <SelectItem key={column} value={column} className="text-[12px]">
                      {column}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={filter.operator} onValueChange={(value) => updateFilter(filter.id, { operator: value as ContentFilterOperator })}>
                <SelectTrigger aria-label="Operator" className="h-8 text-[12px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FILTER_OPERATORS.map((operator) => (
                    <SelectItem key={operator.value} value={operator.value} className="text-[12px]">
                      {operator.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={filter.value}
                onChange={(event) => updateFilter(filter.id, { value: event.currentTarget.value })}
                placeholder="Value"
                aria-label="Filter value"
                className="h-8 text-[12px]"
              />
              <Button type="button" variant="ghost" size="icon" aria-label="Remove filter" onClick={() => removeFilter(filter.id)}>
                <X size={14} />
              </Button>
            </div>
          ))}
        </div>
        <Button type="button" variant="outline" size="sm" onClick={addFilter} className="self-start">
          <Plus size={14} /> Add filter
        </Button>
      </PopoverContent>
    </Popover>
  );
}

/* -------------------------------------------------------------------------- *
 *  Column visibility menu                                                     *
 *                                                                             *
 *  Strapi's content-manager has a "Configure the view" surface that lets     *
 *  operators choose which columns appear in the list. We compress that into  *
 *  a single dropdown — checkbox per column, persisted to localStorage.       *
 * -------------------------------------------------------------------------- */

function ColumnVisibilityMenu(props: { columns: ReadonlyArray<string>; hidden: ReadonlyArray<string>; onChange(next: ReadonlyArray<string>): void }): ReactElement {
  if (props.columns.length === 0) {
    return (
      <Button type="button" variant="outline" size="sm" disabled>
        <Columns3 size={14} aria-hidden /> Columns
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button type="button" variant="outline" size="sm" className="gap-1.5">
            <Columns3 size={14} aria-hidden /> Columns
            {props.hidden.length > 0 && (
              <Badge variant="outline" className="ml-1 h-5 rounded-[3px] bg-[#f0f0ff] px-1.5 text-[10px] text-[#4945ff]">
                {props.columns.length - props.hidden.length}/{props.columns.length}
              </Badge>
            )}
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="min-w-[220px]">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex items-center gap-1.5">
            <ListFilter size={12} aria-hidden /> Visible columns
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {props.columns.map((column) => (
          <DropdownMenuCheckboxItem
            key={column}
            checked={!props.hidden.includes(column)}
            onCheckedChange={() => props.onChange(toggleHiddenColumn(props.hidden, column))}
          >
            {column}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* -------------------------------------------------------------------------- *
 *  RecordEditor — Strapi EditView parity                                     *
 *                                                                            *
 *  Top bar:  ChevronLeft back-arrow + collection breadcrumb + record       *
 *            title on the left;  status pill + Publish/Save buttons on     *
 *            the right.  Sticky to the top of the main scroll region.     *
 *                                                                            *
 *  Body:     two columns —                                                  *
 *              (left)  flex-1 min-w-0   →  form cards stack                *
 *              (right) w-[280px]        →  Information rail                *
 * -------------------------------------------------------------------------- */

function RecordEditor(props: { schema: AdminSchemaMetadata; collectionName: AdminCollectionName; record: AdminContentRecord | null; onBack(): void }): ReactElement {
  const collection = collectionMetadata(props.schema, props.collectionName);
  const models = fieldModels(collection, props.schema);
  const client = useClient();
  const queryClient = useQueryClient();
  const [, setDirtyFields] = useAtom(dirtyFieldsAtom);
  const [scheduleAt, setScheduleAt] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const invalidateContent = () => queryClient.invalidateQueries({ queryKey: ["content", props.collectionName] });
  const dirtyKey = `${props.collectionName}:${props.record?.id ?? "new"}`;
  const setEditorDirty = (dirty: boolean) => setDirtyFields((current) => ({ ...current, [dirtyKey]: dirty }));
  const saveMutation = useMutation({
    mutationFn: (input: Record<string, unknown>) => client.saveContent(props.collectionName, props.record?.id ?? null, input),
    onSuccess: () => {
      setEditorDirty(false);
      invalidateContent();
      toast.success(props.record ? "Record saved" : "Record created");
    },
    onError: (error) => {
      toast.error("Save failed", { description: error instanceof Error ? error.message : "Try again" });
    }
  });
  const publishMutation = useMutation({
    mutationFn: () => requireRecord(props.record, (record) => client.publishContent(props.collectionName, record.id)),
    onSuccess: () => {
      setEditorDirty(false);
      invalidateContent();
      toast.success("Record published");
    },
    onError: (error) => {
      toast.error("Publish failed", { description: error instanceof Error ? error.message : "Try again" });
    }
  });
  const unpublishMutation = useMutation({
    mutationFn: () => requireRecord(props.record, (record) => client.unpublishContent(props.collectionName, record.id)),
    onSuccess: () => {
      invalidateContent();
      toast.success("Record unpublished");
    },
    onError: (error) => {
      toast.error("Unpublish failed", { description: error instanceof Error ? error.message : "Try again" });
    }
  });
  const scheduleMutation = useMutation({
    mutationFn: () => requireRecord(props.record, (record) => client.scheduleContent(props.collectionName, record.id, scheduleAt)),
    onSuccess: () => {
      invalidateContent();
      toast.success("Publish scheduled");
    },
    onError: (error) => {
      toast.error("Schedule failed", { description: error instanceof Error ? error.message : "Try again" });
    }
  });
  const unscheduleMutation = useMutation({
    mutationFn: () => requireRecord(props.record, (record) => client.unscheduleContent(props.collectionName, record.id)),
    onSuccess: () => {
      invalidateContent();
      toast.success("Schedule cleared");
    },
    onError: (error) => {
      toast.error("Clear schedule failed", { description: error instanceof Error ? error.message : "Try again" });
    }
  });
  const deleteMutation = useMutation({
    mutationFn: () => requireRecord(props.record, (record) => client.deleteContent(props.collectionName, record.id)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["content", props.collectionName] });
      toast.success("Record deleted");
      props.onBack();
    },
    onError: (error) => {
      toast.error("Delete failed", { description: error instanceof Error ? error.message : "Try again" });
    }
  });
  const previewMutation = useMutation({
    mutationFn: () => requireRecord(props.record, (record) => client.createPreviewToken(props.collectionName, record.id)),
    onSuccess: (preview) => setPreviewUrl(preview.url ?? `/api/${props.collectionName}/${props.record?.id}?preview=${preview.token}`)
  });
  const defaultValues = useMemo(() => formValuesFromRecord(models, props.record), [models, props.record]);
  const form = useForm({
    defaultValues,
    onSubmit: ({ value }) => {
      saveMutation.mutate(recordInputFromValues(models, value));
    }
  });
  const autosave = useDebouncedCallback((values: FieldFormValues) => {
    if (props.record) saveMutation.mutate(recordInputFromValues(models, values));
  }, { wait: 500 });
  const isDraftEnabled = supportsDraftWorkflow(collection);
  const busy = saveMutation.isPending || publishMutation.isPending || unpublishMutation.isPending || scheduleMutation.isPending || unscheduleMutation.isPending || deleteMutation.isPending || previewMutation.isPending;
  const editorError = editorMutationErrorMessage(saveMutation.error ?? publishMutation.error ?? unpublishMutation.error ?? scheduleMutation.error ?? unscheduleMutation.error ?? deleteMutation.error ?? previewMutation.error);
  const handleFieldChange = (field: { handleChange(value: string | boolean): void }, name: string, value: string | boolean) => {
    field.handleChange(value);
    setEditorDirty(true);
    if (props.record) autosave({ ...form.state.values, [name]: value });
  };
  useHotkeys([
    { hotkey: EDITOR_HOTKEYS.save, callback: () => void form.handleSubmit(), options: { enabled: !busy } },
    { hotkey: EDITOR_HOTKEYS.publish, callback: () => publishMutation.mutate(), options: { enabled: Boolean(isDraftEnabled && props.record && !busy) } }
  ], { preventDefault: true, stopPropagation: true, requireReset: true });

  const status = props.record?.status ?? (props.record ? "draft" : null);
  const recordTitle = props.record
    ? recordDisplayTitle(props.record) ?? props.record.id
    : `New ${props.collectionName}`;
  const headingLabel = props.record ? `Edit ${props.collectionName}` : `New ${props.collectionName}`;

  return (
    <section className="flex h-full min-h-0 flex-col" aria-labelledby="hcms-editor-heading">
      {/* Sticky top bar */}
      <div className="sticky top-0 z-10 border-b border-[#eaeaef] bg-white px-10 pb-4 pt-5">
        <div className="flex items-start justify-between gap-6">
          <div className="flex min-w-0 items-start gap-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={props.onBack}
              aria-label="Back"
              className="-ml-2 mt-0.5 h-8 px-2"
            >
              <ChevronLeft size={16} aria-hidden /> Back
            </Button>
            <div className="min-w-0">
              <p className="m-0 text-[11px] font-semibold uppercase tracking-wider text-[#666687]">
                {props.collectionName}
              </p>
              <h1
                id="hcms-editor-heading"
                aria-label={headingLabel}
                className="m-0 mt-1 truncate text-[24px] font-bold leading-tight tracking-tight text-[#32324d]"
              >
                {recordTitle}
              </h1>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {isDraftEnabled && status && (
              <span
                className={cn(
                  "inline-flex items-center rounded-[4px] px-2 py-1 text-[12px] font-medium",
                  status === "published"
                    ? "bg-[#c6f0c2] text-[#328048]"
                    : "bg-[#fce9d0] text-[#d9822b]"
                )}
              >
                {status === "published" ? "Published" : "Draft"}
              </span>
            )}
            {isDraftEnabled && props.record && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => (status === "published" ? unpublishMutation.mutate() : publishMutation.mutate())}
                disabled={busy}
              >
                <Send size={15} /> {status === "published" ? "Unpublish" : "Publish to users"}
              </Button>
            )}
            <Button type="submit" form="schema-record-form" size="sm" disabled={busy}>
              <Save size={15} /> Save
            </Button>
          </div>
        </div>
      </div>

      {/* Two-column body */}
      <div className="min-w-0 flex-1 overflow-auto bg-[#f6f6f9] px-10 pb-10 pt-6">
        {editorError && (
          <p
            className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            role="alert"
          >
            {editorError}
          </p>
        )}
        <div className="flex min-h-0 items-start gap-6">
          {/* Form area */}
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            <div className="rounded-lg border border-[#eaeaef] bg-white p-6">
              <form
                id="schema-record-form"
                className="flex flex-col gap-5"
                onSubmit={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void form.handleSubmit();
                }}
              >
                {models.map((field) => (
                  <form.Field
                    key={field.name}
                    name={field.name}
                    children={(formField) => (
                      <FieldRow model={field}>
                        <FieldControl
                          model={field}
                          value={formField.state.value}
                          onChange={(value) => handleFieldChange(formField, field.name, value)}
                          onBlur={formField.handleBlur}
                        />
                      </FieldRow>
                    )}
                  />
                ))}
                {models.length === 0 && (
                  <p className="rounded-md border border-dashed border-[#eaeaef] p-6 text-sm text-[#666687]">
                    This content type has no fields defined yet.
                  </p>
                )}
              </form>
            </div>

            {previewUrl && (
              <a
                className="break-all rounded-md border border-[#eaeaef] bg-white px-3 py-2 text-xs text-[#4945ff] underline-offset-2 hover:underline"
                href={previewUrl}
                target="_blank"
                rel="noreferrer"
              >
                {previewUrl}
              </a>
            )}
          </div>

          {/* Information rail */}
          <aside className="flex w-[280px] shrink-0 flex-col gap-4" aria-label="Record information">
            <InformationCard record={props.record} />
            {isDraftEnabled && (
              <StatusCard
                record={props.record}
                status={status}
                busy={busy}
                onPreview={() => previewMutation.mutate()}
              />
            )}
            {isDraftEnabled && props.record && (
              <ScheduleCard
                scheduleAt={scheduleAt}
                onScheduleChange={setScheduleAt}
                onSchedule={() => scheduleMutation.mutate()}
                onUnschedule={() => unscheduleMutation.mutate()}
                busy={busy}
              />
            )}
            {/*
             * LocalePanel sits below the workflow cards and self-gates: it
             * renders nothing when the collection lacks an i18n config or
             * the record hasn't been saved yet, so this slot is safe to
             * include unconditionally.
             */}
            <LocalePanel
              collection={props.collectionName}
              recordId={props.record?.id ?? null}
              i18n={collection.options.i18n ?? null}
            />
            {props.record && (
              <div className="flex flex-col gap-2 rounded-lg border border-[#eaeaef] bg-white p-4">
                <p className="m-0 text-[14px] font-semibold text-[#32324d]">Danger zone</p>
                <p className="m-0 text-[13px] text-[#666687]">Permanent removal cannot be undone.</p>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={() => deleteMutation.mutate()}
                  disabled={busy}
                  className="w-full justify-center"
                >
                  <Trash2 size={15} /> Delete this entry
                </Button>
              </div>
            )}
            <Button type="button" variant="ghost" size="sm" onClick={props.onBack} className="w-full justify-center text-[#666687]">
              <ArrowLeft size={14} /> Back to list
            </Button>
          </aside>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- *
 *  Information rail cards                                                    *
 * -------------------------------------------------------------------------- */

function InformationCard(props: { record: AdminContentRecord | null }): ReactElement {
  const record = props.record;
  const created = record?.createdAt ? formatDate(String(record.createdAt)) : "—";
  const updated = record?.updatedAt ? formatDate(String(record.updatedAt)) : "—";
  const createdBy = record?.createdBy ? String(record.createdBy) : "—";
  const updatedBy = record?.updatedBy ? String(record.updatedBy) : "—";
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-[#eaeaef] bg-white p-4">
      <h2 className="m-0 text-[14px] font-semibold text-[#32324d]">Information</h2>
      <dl className="m-0 flex flex-col gap-2 text-[13px] text-[#666687]">
        <InfoRow label="Created" value={created} />
        <InfoRow label="Last update" value={updated} />
        <InfoRow label="Created by" value={createdBy} />
        <InfoRow label="Last update by" value={updatedBy} />
        {record && <InfoRow label="ID" value={record.id} mono />}
      </dl>
    </section>
  );
}

function InfoRow(props: { label: string; value: string; mono?: boolean }): ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[12px] text-[#8e8ea9]">{props.label}</dt>
      <dd
        className={cn(
          "m-0 max-w-[60%] truncate text-right text-[13px] text-[#32324d]",
          props.mono && "font-mono text-[12px]"
        )}
      >
        {props.value}
      </dd>
    </div>
  );
}

function StatusCard(props: {
  record: AdminContentRecord | null;
  status: string | null;
  busy: boolean;
  onPreview(): void;
}): ReactElement {
  // Publish / Unpublish actions live in the sticky top bar (matches Strapi's
  // EditView). The Status card surfaces the current stage and the Preview
  // shortcut so the rail stays informative without duplicating the primary
  // workflow buttons (which would otherwise collide with the e2e selector for
  // `name: /publish to users/i`).
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-[#eaeaef] bg-white p-4">
      <h2 className="m-0 text-[14px] font-semibold text-[#32324d]">Status</h2>
      <div className="flex items-center justify-between gap-2 text-[13px] text-[#666687]">
        <span>Stage</span>
        {props.status && (
          <span
            className={cn(
              "inline-flex items-center rounded-[4px] px-2 py-0.5 text-[11px] font-medium",
              props.status === "published" ? "bg-[#c6f0c2] text-[#328048]" : "bg-[#fce9d0] text-[#d9822b]"
            )}
          >
            {props.status === "published" ? "Published" : "Draft"}
          </span>
        )}
        {!props.status && <span className="text-[#666687]">New</span>}
      </div>
      {props.record && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={props.busy}
          onClick={props.onPreview}
          className="w-full justify-center"
        >
          <Eye size={14} /> Preview
        </Button>
      )}
      {!props.record && (
        <p className="m-0 rounded-md border border-dashed border-[#eaeaef] p-3 text-xs text-[#666687]">
          Save this record before publishing or scheduling.
        </p>
      )}
    </section>
  );
}

function ScheduleCard(props: {
  scheduleAt: string;
  onScheduleChange(value: string): void;
  onSchedule(): void;
  onUnschedule(): void;
  busy: boolean;
}): ReactElement {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-[#eaeaef] bg-white p-4">
      <h2 className="m-0 flex items-center gap-1.5 text-[14px] font-semibold text-[#32324d]">
        <CalendarClock size={14} aria-hidden /> Schedule publish
      </h2>
      <Input
        type="datetime-local"
        value={props.scheduleAt}
        onChange={(event) => props.onScheduleChange(event.target.value)}
        aria-label="Scheduled publish time"
      />
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={props.onSchedule} disabled={props.busy || !props.scheduleAt} className="flex-1 justify-center">
          <CalendarClock size={14} /> Schedule
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={props.onUnschedule} disabled={props.busy} className="flex-1 justify-center">
          <RotateCcw size={14} /> Clear
        </Button>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- *
 *  Field rendering                                                            *
 * -------------------------------------------------------------------------- */

function FieldRow(props: { model: FieldRenderModel; children: ReactElement }): ReactElement {
  if (props.model.control === "checkbox") {
    return (
      <label className="flex items-start justify-between gap-3 rounded-md border border-[#eaeaef] bg-white px-3 py-3">
        <span className="flex flex-col gap-0.5">
          <span className="text-[13px] font-semibold text-[#32324d]">
            {props.model.label}
            {props.model.required && <b className="ml-0.5 text-destructive">*</b>}
          </span>
        </span>
        {props.children}
      </label>
    );
  }
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-semibold text-[#32324d]">
        {props.model.label}
        {props.model.required && <b className="ml-0.5 text-destructive">*</b>}
      </span>
      {props.children}
    </label>
  );
}

function FieldControl(props: { model: FieldRenderModel; value: string | boolean; onChange(value: string | boolean): void; onBlur(): void }): ReactElement {
  if (props.model.control === "textarea") return <Textarea name={props.model.name} value={String(props.value ?? "")} onChange={(event) => props.onChange(event.currentTarget.value)} onBlur={props.onBlur} rows={6} />;
  if (props.model.control === "richtext") return <RichTextControl name={props.model.name} value={String(props.value ?? "")} onChange={props.onChange} onBlur={props.onBlur} />;
  if (props.model.control === "checkbox") return (
    <Switch
      name={props.model.name}
      checked={Boolean(props.value)}
      onCheckedChange={(checked) => props.onChange(checked === true)}
      onBlur={props.onBlur}
      aria-label={props.model.label}
    />
  );
  if (props.model.control === "select") return <Select name={props.model.name} value={String(props.value ?? props.model.options?.[0] ?? "")} onValueChange={(value) => props.onChange(value ?? "")}><SelectTrigger onBlur={props.onBlur}><SelectValue /></SelectTrigger><SelectContent>{props.model.options?.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent></Select>;
  if (props.model.control === "number") return <Input name={props.model.name} type="number" value={String(props.value ?? "")} onChange={(event) => props.onChange(event.currentTarget.value)} onBlur={props.onBlur} />;
  if (props.model.control === "json") return <Textarea name={props.model.name} value={String(props.value ?? "")} onChange={(event) => props.onChange(event.currentTarget.value)} onBlur={props.onBlur} rows={5} />;
  if (props.model.control === "relation") return <RelationControl model={props.model} value={props.value} onChange={props.onChange} onBlur={props.onBlur} />;
  if (props.model.control === "media") return <MediaFieldControl model={props.model} value={String(props.value ?? "")} onChange={props.onChange} onBlur={props.onBlur} />;
  if (props.model.control === "component") return <ComponentControl model={props.model} value={props.value} onChange={props.onChange} onBlur={props.onBlur} />;
  if (props.model.control === "dynamiczone") return <DynamicZoneControl model={props.model} value={props.value} onChange={props.onChange} onBlur={props.onBlur} />;
  return <Input name={props.model.name} type={inputTypeForControl(props.model.control)} value={String(props.value ?? "")} onChange={(event) => props.onChange(event.currentTarget.value)} onBlur={props.onBlur} />;
}

function inputTypeForControl(control: string): string {
  if (control === "email" || control === "url" || control === "password" || control === "date" || control === "time") return control;
  if (control === "datetime") return "datetime-local";
  return "text";
}

/* -------------------------------------------------------------------------- *
 *  Helpers                                                                    *
 * -------------------------------------------------------------------------- */

function requireRecord<T>(record: AdminContentRecord | null, action: (record: AdminContentRecord) => Promise<T>): Promise<T> {
  if (!record) return Promise.reject(new Error("Select a record before running this workflow action."));
  return action(record);
}

function recordDisplayTitle(record: AdminContentRecord): string | null {
  const candidate = record.title ?? record.name ?? record.slug ?? record.email;
  return candidate ? String(candidate) : null;
}

function formatDate(value: string): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}
