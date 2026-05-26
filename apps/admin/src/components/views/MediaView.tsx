/* -------------------------------------------------------------------------- *
 *  MediaView — Strapi v5 `/plugins/upload` parity                            *
 *                                                                            *
 *  Mirrors the Strapi Media Library shell:                                   *
 *    - Page header lives in the main column (eyebrow + title + subtitle +    *
 *      `Add new folder` / `Add new assets` buttons).                          *
 *    - Below the header, a filter bar: search input + sort select + view     *
 *      toggle (grid/list) + filter button.                                    *
 *    - Then a folder breadcrumb row (Media library › current folder).         *
 *    - Then the asset grid (4 cols ≥1280px / 3 ≥lg / 2 ≥md / 1 ≥sm).          *
 *    - Each card: 4:3 thumb, filename + size + dimensions, hover reveals      *
 *      bulk-select checkbox.                                                  *
 *    - Upload modal opens via `Add new assets`. Tabs: From computer /        *
 *      From URL. Drop zone + per-file progress bars.                          *
 *                                                                            *
 *  Rail 2 is registered via `useRail2Slot(null)` — Strapi's Media Library    *
 *  does not have a section sub-nav, so we render the bare section title.     *
 * -------------------------------------------------------------------------- */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useDebouncedCallback } from "@tanstack/react-pacer";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Check,
  ChevronRight,
  Copy,
  File as FileIcon,
  FileAudio,
  FileText,
  FileVideo,
  Filter as FilterIcon,
  Folder as FolderIcon,
  FolderOpen as FolderOpenIcon,
  Image as ImageIcon,
  LayoutGrid,
  Link as LinkIcon,
  List as ListIcon,
  Pencil,
  Plus,
  Search as SearchIcon,
  Trash2,
  Upload,
  X
} from "lucide-react";
import { useQueryStates } from "nuqs";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog";
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
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { type MediaFolder, type MediaRecord } from "../../lib/api-client";
import { mediaSearchParsers } from "../../lib/route-search";
import { useRail2Slot } from "./AppFrame";
import type { MediaRouteState } from "./auth-helpers";
import { mediaFromQuery } from "./query-helpers";
import { formatBytes, useClient } from "./shared";

/* -------------------------------------------------------------------------- */
/*  Grid sizing                                                                */
/* -------------------------------------------------------------------------- */

const TILE_HEIGHT = 244;
const TILE_GAP = 16;
const LANE_BREAKPOINTS: Array<{ minWidth: number; lanes: number }> = [
  { minWidth: 1280, lanes: 4 },
  { minWidth: 1024, lanes: 3 },
  { minWidth: 720, lanes: 2 },
  { minWidth: 0, lanes: 1 }
];

type MediaCategory = "image" | "video" | "audio" | "document" | "other";

function categorize(contentType: string | undefined): MediaCategory {
  if (!contentType) return "other";
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  if (
    contentType.startsWith("text/") ||
    contentType.includes("pdf") ||
    contentType.includes("word") ||
    contentType.includes("excel") ||
    contentType.includes("spreadsheet") ||
    contentType.includes("presentation") ||
    contentType.includes("json") ||
    contentType.includes("xml")
  ) {
    return "document";
  }
  return "other";
}

function CategoryIcon({ category, size = 28 }: { category: MediaCategory; size?: number }): ReactElement {
  if (category === "image") return <ImageIcon size={size} />;
  if (category === "video") return <FileVideo size={size} />;
  if (category === "audio") return <FileAudio size={size} />;
  if (category === "document") return <FileText size={size} />;
  return <FileIcon size={size} />;
}

function lanesForWidth(width: number): number {
  for (const breakpoint of LANE_BREAKPOINTS) {
    if (width >= breakpoint.minWidth) return breakpoint.lanes;
  }
  return 1;
}

function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    rows.push(items.slice(index, index + size));
  }
  return rows;
}

function dimensionsOf(item: MediaRecord): string | null {
  const meta = item.metadata ?? {};
  const width = meta.width ?? meta.imageWidth;
  const height = meta.height ?? meta.imageHeight;
  if (width && height) return `${width}×${height}`;
  return null;
}

const SORT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "-createdAt", label: "Most recent uploads" },
  { value: "createdAt", label: "Oldest uploads" },
  { value: "filename", label: "Filename (A→Z)" },
  { value: "-filename", label: "Filename (Z→A)" },
  { value: "-updatedAt", label: "Most recent updates" }
];

const TYPE_LABELS: Record<string, string> = {
  all: "All types",
  image: "Images",
  video: "Videos",
  audio: "Audio",
  document: "Documents",
  other: "Other"
};

function sortMedia(items: MediaRecord[], sort: string): MediaRecord[] {
  const sorted = [...items];
  const desc = sort.startsWith("-");
  const key = desc ? sort.slice(1) : sort;
  sorted.sort((a, b) => {
    const av = readSortValue(a, key);
    const bv = readSortValue(b, key);
    if (av < bv) return desc ? 1 : -1;
    if (av > bv) return desc ? -1 : 1;
    return 0;
  });
  return sorted;
}

function readSortValue(item: MediaRecord, key: string): string | number {
  if (key === "filename") return item.filename.toLowerCase();
  if (key === "updatedAt") return item.updatedAt;
  return item.createdAt;
}

/* -------------------------------------------------------------------------- */
/*  Root view                                                                  */
/* -------------------------------------------------------------------------- */

export function MediaView({ mediaId = null }: MediaRouteState): ReactElement {
  const navigate = useNavigate();
  const client = useClient();
  const queryClient = useQueryClient();
  const [search, setSearch] = useQueryStates(mediaSearchParsers);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [searchInput, setSearchInput] = useState(search.q);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Folders query. The store stays flat; we derive the tree client-side so a
  // rename/move only invalidates one cache entry (not every node).
  const foldersQuery = useQuery({
    queryKey: ["media", "folders"],
    queryFn: () => client.mediaFolders()
  });
  const folders = useMemo(() => foldersQuery.data ?? [], [foldersQuery.data]);
  const folderTree = useMemo(() => buildFolderTree(folders), [folders]);
  const activeFolderId = search.folder || null;
  const activeFolder = activeFolderId ? folders.find((folder) => folder.id === activeFolderId) ?? null : null;
  const breadcrumb = useMemo(() => activeFolder ? folderAncestry(folders, activeFolder) : [], [folders, activeFolder]);

  // If the URL points at a folder the server doesn't know about anymore
  // (deleted in another tab, for instance), drop back to the root so we
  // don't render a broken breadcrumb forever. Wait for `isFetching` so a
  // freshly-created folder isn't immediately wiped while the list refetch
  // is still in flight.
  useEffect(() => {
    if (!activeFolderId) return;
    if (foldersQuery.isLoading || foldersQuery.isFetching) return;
    if (!folders.some((folder) => folder.id === activeFolderId)) {
      void setSearch({ folder: null });
    }
  }, [activeFolderId, folders, foldersQuery.isLoading, foldersQuery.isFetching, setSearch]);

  const updateSearch = useDebouncedCallback((value: string) => {
    void setSearch({ q: value.trim() || null });
  }, { wait: 300 });

  const query = useQuery({
    queryKey: ["media", search.q, search.type, activeFolderId ?? "__root__"],
    queryFn: () => client.listMedia({
      q: search.q || undefined,
      type: search.type || undefined,
      folderId: activeFolderId ?? null,
      limit: 50
    })
  });

  const rawMedia = mediaFromQuery(query.data);
  const media = useMemo(() => sortMedia(rawMedia, search.sort), [rawMedia, search.sort]);
  const totalBytes = useMemo(() => media.reduce((sum, item) => sum + (item.size ?? 0), 0), [media]);
  const selectedItem = mediaId ? media.find((item) => item.id === mediaId) ?? null : null;

  // Rail 2: render the folder tree as the section sub-nav. Re-evaluates each
  // render so renames / deletes / navigation propagate without a refresh.
  useRail2Slot(
    <MediaFoldersRail
      tree={folderTree}
      activeFolderId={activeFolderId}
      onNavigate={(id) => void setSearch({ folder: id || null })}
      onCreate={() => setNewFolderOpen(true)}
      onRename={(folder, name) => renameMutation.mutate({ id: folder.id, name })}
      onDelete={(folder) => deleteFolderMutation.mutate({ id: folder.id })}
      isLoading={foldersQuery.isLoading}
    />
  );

  const toggleSelect = (id: string, on: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const uploadMutation = useMutation({
    mutationFn: (input: { file: File }) => client.uploadMediaWithPresign(input.file, undefined, activeFolderId ?? undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["media"] });
      toast.success("Asset uploaded successfully.");
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Upload failed.");
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => client.deleteMedia(id),
    onSuccess: (_result, deletedId) => {
      queryClient.invalidateQueries({ queryKey: ["media"] });
      if (deletedId === selectedItem?.id) void navigate({ to: "/media" });
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(deletedId);
        return next;
      });
      toast.success("Asset deleted.");
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Delete failed.");
    }
  });

  const createFolderMutation = useMutation({
    mutationFn: (input: { name: string; parentId: string | null }) => client.createMediaFolder({
      name: input.name,
      parentId: input.parentId
    }),
    onSuccess: (folder) => {
      queryClient.invalidateQueries({ queryKey: ["media", "folders"] });
      toast.success(`Folder "${folder.name}" created.`);
      void setSearch({ folder: folder.id });
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Could not create folder.");
    }
  });

  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => client.renameMediaFolder(id, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["media", "folders"] });
      toast.success("Folder renamed.");
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Rename failed.");
    }
  });

  const deleteFolderMutation = useMutation({
    mutationFn: async ({ id, force }: { id: string; force?: boolean }) => {
      await client.deleteMediaFolder(id, { force });
      return id;
    },
    onSuccess: (deletedId) => {
      queryClient.invalidateQueries({ queryKey: ["media", "folders"] });
      queryClient.invalidateQueries({ queryKey: ["media"] });
      if (activeFolderId === deletedId) void setSearch({ folder: null });
      toast.success("Folder deleted.");
    },
    onError: (e) => {
      // Surface the 409 path (folder not empty) so the user can opt in to force.
      const message = e instanceof Error ? e.message : "Delete failed.";
      toast.error(message);
    }
  });

  return (
    <TooltipProvider>
      <section className="flex h-full min-h-0 flex-col" aria-labelledby="media-library-title">
        {/* Strapi-style page header (eyebrow + title + subtitle + actions) */}
        <header className="border-b border-[#eaeaef] bg-white px-10 py-6 shrink-0">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8e8ea9]">
                Media library
              </p>
              <h1
                id="media-library-title"
                className="mt-1 text-[32px] font-bold leading-tight tracking-tight text-[#32324d]"
              >
                {activeFolder ? activeFolder.name : "Media library"}
              </h1>
              <p className="mt-1 text-[14px] text-[#666687]">
                Configure the bundle that powers your applications.
                {media.length > 0 ? (
                  <span className="ml-1 text-[#8e8ea9]">
                    · {media.length} {media.length === 1 ? "asset" : "assets"} · {formatBytes(totalBytes)}
                  </span>
                ) : null}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" onClick={() => setNewFolderOpen(true)}>
                <Plus size={15} aria-hidden /> Add new folder
              </Button>
              <Button type="button" onClick={() => setUploadOpen(true)}>
                <Plus size={15} aria-hidden /> Add new assets
              </Button>
            </div>
          </div>
        </header>

        {/* Filter bar + breadcrumb + grid */}
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-10 py-6">
          <FilterBar
            searchInput={searchInput}
            onSearchInputChange={(next) => {
              setSearchInput(next);
              updateSearch(next);
            }}
            sort={search.sort}
            onSortChange={(value) => void setSearch({ sort: value })}
            view={search.view}
            onViewChange={(value) => void setSearch({ view: value })}
            type={search.type}
            onTypeChange={(value) => void setSearch({ type: value === "all" ? null : value })}
          />

          <FolderBreadcrumb
            crumbs={breadcrumb}
            onNavigate={(id) => void setSearch({ folder: id || null })}
          />

          <div className="relative flex min-h-0 flex-1 gap-6">
            <div className="min-w-0 flex-1">
              {query.isLoading ? (
                <MediaSkeleton />
              ) : media.length === 0 ? (
                <MediaEmpty onUpload={() => setUploadOpen(true)} />
              ) : search.view === "list" ? (
                <MediaList
                  items={media}
                  selectedIds={selectedIds}
                  onToggle={toggleSelect}
                  onSelect={(id) => void navigate({ to: "/media/$mediaId", params: { mediaId: id } })}
                  onDelete={(id) => deleteMutation.mutate(id)}
                  deletingId={deleteMutation.isPending ? deleteMutation.variables ?? null : null}
                />
              ) : (
                <MediaGrid
                  items={media}
                  selectedDetailId={selectedItem?.id ?? null}
                  checked={selectedIds}
                  onToggleCheck={toggleSelect}
                  onSelect={(id) =>
                    void navigate({ to: "/media/$mediaId", params: { mediaId: id } })
                  }
                  onDelete={(id) => deleteMutation.mutate(id)}
                  deletingId={deleteMutation.isPending ? deleteMutation.variables ?? null : null}
                />
              )}
            </div>

            <MediaDetailDrawer
              item={selectedItem}
              open={Boolean(selectedItem)}
              onClose={() => void navigate({ to: "/media" })}
              onDelete={(id) => deleteMutation.mutate(id)}
              deleting={deleteMutation.isPending}
            />
          </div>
        </div>

        <UploadDialog
          open={uploadOpen}
          onOpenChange={setUploadOpen}
          onUpload={(file) => uploadMutation.mutateAsync({ file })}
        />

        <NewFolderDialog
          open={newFolderOpen}
          onOpenChange={setNewFolderOpen}
          folders={folders}
          defaultParentId={activeFolderId}
          submitting={createFolderMutation.isPending}
          onSubmit={async (input) => {
            await createFolderMutation.mutateAsync(input);
            setNewFolderOpen(false);
          }}
        />
      </section>
    </TooltipProvider>
  );
}

/* -------------------------------------------------------------------------- */
/*  Filter bar                                                                 */
/* -------------------------------------------------------------------------- */

function FilterBar(props: {
  searchInput: string;
  onSearchInputChange(next: string): void;
  sort: string;
  onSortChange(next: string): void;
  view: "grid" | "list";
  onViewChange(next: "grid" | "list"): void;
  type: string;
  onTypeChange(next: string): void;
}): ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Left: search */}
      <div className="relative min-w-[240px] flex-1 max-w-md">
        <SearchIcon
          size={15}
          aria-hidden
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#8e8ea9]"
        />
        <Input
          type="search"
          value={props.searchInput}
          onChange={(event) => props.onSearchInputChange(event.currentTarget.value)}
          placeholder="Search"
          aria-label="Search media"
          className="h-10 rounded-md border-[#dcdce4] bg-white pl-9 text-[14px] shadow-none"
        />
      </div>

      {/* Right cluster: sort + filters + view toggle */}
      <div className="ml-auto flex items-center gap-2">
        <Select
          value={props.sort}
          onValueChange={(value) => {
            if (value) props.onSortChange(value);
          }}
        >
          <SelectTrigger
            className="h-10 min-w-[200px] rounded-md border border-[#dcdce4] bg-white text-[13px] font-medium text-[#32324d] shadow-none"
            aria-label="Sort by"
          >
            <SelectValue placeholder="Sort by">
              {(value) =>
                SORT_OPTIONS.find((option) => option.value === value)?.label ?? "Sort by"
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {SORT_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={props.type || "all"}
          onValueChange={(value) => {
            if (value) props.onTypeChange(value);
          }}
        >
          <SelectTrigger
            className="h-10 rounded-md border border-[#dcdce4] bg-white text-[13px] font-medium text-[#32324d] shadow-none"
            aria-label="Filter by media type"
          >
            <FilterIcon size={14} aria-hidden className="mr-1 text-[#666687]" />
            <SelectValue placeholder="Filters">
              {(value) => TYPE_LABELS[value as string] ?? "Filters"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="image">Images</SelectItem>
            <SelectItem value="video">Videos</SelectItem>
            <SelectItem value="audio">Audio</SelectItem>
            <SelectItem value="document">Documents</SelectItem>
            <SelectItem value="other">Other</SelectItem>
          </SelectContent>
        </Select>

        <div
          className="inline-flex h-10 items-center overflow-hidden rounded-md border border-[#dcdce4] bg-white"
          role="group"
          aria-label="View toggle"
        >
          <ViewToggleButton
            active={props.view === "grid"}
            onClick={() => props.onViewChange("grid")}
            label="Grid view"
            icon={<LayoutGrid size={15} aria-hidden />}
          />
          <span className="h-5 w-px bg-[#eaeaef]" aria-hidden />
          <ViewToggleButton
            active={props.view === "list"}
            onClick={() => props.onViewChange("list")}
            label="List view"
            icon={<ListIcon size={15} aria-hidden />}
          />
        </div>
      </div>
    </div>
  );
}

function ViewToggleButton(props: {
  active: boolean;
  onClick(): void;
  label: string;
  icon: ReactElement;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-label={props.label}
      aria-pressed={props.active}
      className={cn(
        "inline-flex h-10 w-10 items-center justify-center text-[#666687] transition-colors",
        "hover:text-[#32324d] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4945ff]/40",
        props.active && "bg-[#f0f0ff] text-[#4945ff]"
      )}
    >
      {props.icon}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/*  Folder tree + breadcrumb                                                   */
/* -------------------------------------------------------------------------- */

type FolderNode = MediaFolder & { children: FolderNode[] };

/** Walk the flat folder list once and link children to their parents. */
function buildFolderTree(folders: MediaFolder[]): FolderNode[] {
  const byId = new Map<string, FolderNode>();
  for (const folder of folders) byId.set(folder.id, { ...folder, children: [] });
  const roots: FolderNode[] = [];
  for (const folder of folders) {
    const node = byId.get(folder.id);
    if (!node) continue;
    if (folder.parentId && byId.has(folder.parentId)) {
      byId.get(folder.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortRec = (nodes: FolderNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    for (const node of nodes) sortRec(node.children);
  };
  sortRec(roots);
  return roots;
}

/** Build the ancestry chain root → leaf for the active folder. */
function folderAncestry(folders: MediaFolder[], leaf: MediaFolder): MediaFolder[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const chain: MediaFolder[] = [];
  let cursor: MediaFolder | undefined = leaf;
  const guard = new Set<string>();
  while (cursor && !guard.has(cursor.id)) {
    guard.add(cursor.id);
    chain.unshift(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return chain;
}

function FolderBreadcrumb(props: {
  crumbs: MediaFolder[];
  onNavigate(id: string | null): void;
}): ReactElement {
  return (
    <nav aria-label="Folder breadcrumbs" className="flex flex-wrap items-center gap-1 text-[13px]">
      <button
        type="button"
        onClick={() => props.onNavigate(null)}
        className={cn(
          "rounded px-1 font-semibold text-[#32324d] transition-colors hover:text-[#4945ff]",
          props.crumbs.length === 0 && "text-[#32324d]"
        )}
      >
        Media library
      </button>
      {props.crumbs.map((crumb, index) => {
        const isLast = index === props.crumbs.length - 1;
        return (
          <span key={crumb.id} className="flex items-center gap-1">
            <ChevronRight size={13} aria-hidden className="text-[#8e8ea9]" />
            {isLast ? (
              <span aria-current="page" className="rounded px-1 font-semibold text-[#32324d]">
                {crumb.name}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => props.onNavigate(crumb.id)}
                className="rounded px-1 text-[#666687] hover:text-[#4945ff]"
              >
                {crumb.name}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

/* -------------------------------------------------------------------------- */
/*  Rail 2 folder tree                                                         */
/* -------------------------------------------------------------------------- */

function MediaFoldersRail(props: {
  tree: FolderNode[];
  activeFolderId: string | null;
  onNavigate(id: string | null): void;
  onCreate(): void;
  onRename(folder: MediaFolder, name: string): void;
  onDelete(folder: MediaFolder): void;
  isLoading: boolean;
}): ReactElement {
  return (
    <nav aria-label="Media folders" className="flex flex-col gap-1 px-2 py-3 text-[13px]">
      <button
        type="button"
        onClick={() => props.onNavigate(null)}
        aria-current={!props.activeFolderId ? "page" : undefined}
        className={cn(
          "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors",
          !props.activeFolderId
            ? "bg-[#f0f0ff] text-[#4945ff]"
            : "text-[#32324d] hover:bg-[#f6f6f9]"
        )}
      >
        {!props.activeFolderId ? <FolderOpenIcon size={14} aria-hidden /> : <FolderIcon size={14} aria-hidden />}
        <span className="truncate">Media library</span>
      </button>

      {props.isLoading ? (
        <p className="px-2 py-1 text-[12px] text-[#8e8ea9]">Loading folders…</p>
      ) : props.tree.length === 0 ? (
        <p className="px-2 py-2 text-[12px] text-[#8e8ea9]">No folders yet.</p>
      ) : (
        <ul className="flex flex-col gap-0.5" role="tree">
          {props.tree.map((node) => (
            <MediaFolderNode
              key={node.id}
              node={node}
              depth={0}
              activeFolderId={props.activeFolderId}
              onNavigate={props.onNavigate}
              onRename={props.onRename}
              onDelete={props.onDelete}
            />
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={props.onCreate}
        className="mt-2 flex items-center gap-1.5 rounded px-2 py-1.5 text-[12px] font-semibold text-[#4945ff] hover:bg-[#f0f0ff]"
        aria-label="Add a new folder"
      >
        <Plus size={13} aria-hidden /> Add new folder
      </button>
    </nav>
  );
}

function MediaFolderNode(props: {
  node: FolderNode;
  depth: number;
  activeFolderId: string | null;
  onNavigate(id: string): void;
  onRename(folder: MediaFolder, name: string): void;
  onDelete(folder: MediaFolder): void;
}): ReactElement {
  const isActive = props.activeFolderId === props.node.id;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.node.name);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setDraft(props.node.name);
  }, [props.node.name]);

  const commitRename = () => {
    const next = draft.trim();
    if (!next || next === props.node.name) {
      setEditing(false);
      setDraft(props.node.name);
      return;
    }
    props.onRename(props.node, next);
    setEditing(false);
  };

  return (
    <li role="treeitem" aria-expanded={props.node.children.length > 0 ? true : undefined}>
      <div
        className={cn(
          "group/folder relative flex items-center gap-1 rounded transition-colors",
          isActive ? "bg-[#f0f0ff]" : "hover:bg-[#f6f6f9]"
        )}
        style={{ paddingLeft: 8 + props.depth * 12 }}
      >
        {editing ? (
          <Input
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitRename();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setEditing(false);
                setDraft(props.node.name);
              }
            }}
            aria-label={`Rename folder ${props.node.name}`}
            className="h-7 flex-1 rounded border-[#dcdce4] bg-white px-2 text-[13px] shadow-none"
          />
        ) : (
          <>
            <button
              type="button"
              onClick={() => props.onNavigate(props.node.id)}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1 text-left",
                isActive ? "text-[#4945ff]" : "text-[#32324d]"
              )}
            >
              {isActive ? <FolderOpenIcon size={14} aria-hidden /> : <FolderIcon size={14} aria-hidden />}
              <span className="truncate">{props.node.name}</span>
            </button>
            <div className="flex shrink-0 items-center gap-0.5 pr-1 opacity-0 transition-opacity group-hover/folder:opacity-100 group-focus-within/folder:opacity-100">
              <button
                type="button"
                onClick={() => setEditing(true)}
                aria-label={`Rename ${props.node.name}`}
                className="rounded p-1 text-[#666687] hover:bg-white hover:text-[#32324d]"
              >
                <Pencil size={11} aria-hidden />
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                aria-label={`Delete folder ${props.node.name}`}
                className="rounded p-1 text-[#666687] hover:bg-white hover:text-red-600"
              >
                <Trash2 size={11} aria-hidden />
              </button>
            </div>
          </>
        )}
      </div>

      {props.node.children.length > 0 && (
        <ul className="flex flex-col gap-0.5" role="group">
          {props.node.children.map((child) => (
            <MediaFolderNode
              key={child.id}
              node={child}
              depth={props.depth + 1}
              activeFolderId={props.activeFolderId}
              onNavigate={props.onNavigate}
              onRename={props.onRename}
              onDelete={props.onDelete}
            />
          ))}
        </ul>
      )}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete folder “{props.node.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The folder will be removed. If it contains assets or sub-folders, they will be detached
              and moved back to the Media library root.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                props.onDelete(props.node);
                setConfirmDelete(false);
              }}
            >
              Delete folder
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/*  New folder dialog                                                          */
/* -------------------------------------------------------------------------- */

function NewFolderDialog(props: {
  open: boolean;
  onOpenChange(open: boolean): void;
  folders: MediaFolder[];
  defaultParentId: string | null;
  submitting: boolean;
  onSubmit(input: { name: string; parentId: string | null }): Promise<void>;
}): ReactElement {
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState<string>(props.defaultParentId ?? "__root__");

  useEffect(() => {
    if (props.open) {
      setName("");
      setParentId(props.defaultParentId ?? "__root__");
    }
  }, [props.open, props.defaultParentId]);

  const handleSubmit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Folder name is required.");
      return;
    }
    await props.onSubmit({
      name: trimmed,
      parentId: parentId === "__root__" ? null : parentId
    });
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Add new folder</DialogTitle>
          <DialogDescription>
            Folders organize your media library. You can move assets between folders later.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSubmit();
          }}
        >
          <label className="grid gap-1.5 text-sm text-[#32324d]">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-[#8e8ea9]">
              Name
            </span>
            <Input
              autoFocus
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              placeholder="e.g. Marketing"
              aria-label="Folder name"
              className="h-10 rounded-md border-[#dcdce4] bg-white text-[14px] shadow-none"
            />
          </label>

          <label className="grid gap-1.5 text-sm text-[#32324d]">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-[#8e8ea9]">
              Parent folder
            </span>
            <Select value={parentId} onValueChange={(value) => setParentId(value || "__root__")}>
              <SelectTrigger
                className="h-10 rounded-md border border-[#dcdce4] bg-white text-[13px] font-medium text-[#32324d] shadow-none"
                aria-label="Parent folder"
              >
                <SelectValue placeholder="Media library (root)">
                  {(value) => {
                    if (!value || value === "__root__") return "Media library (root)";
                    const folder = props.folders.find((item) => item.id === value);
                    return folder?.path ?? "Media library (root)";
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__root__">Media library (root)</SelectItem>
                {props.folders.map((folder) => (
                  <SelectItem key={folder.id} value={folder.id}>
                    {folder.path}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => props.onOpenChange(false)}
              disabled={props.submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={props.submitting || !name.trim()}>
              {props.submitting ? "Creating…" : "Create folder"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/*  Grid                                                                       */
/* -------------------------------------------------------------------------- */

function MediaGrid(props: {
  items: MediaRecord[];
  selectedDetailId: string | null;
  checked: Set<string>;
  onToggleCheck(id: string, on: boolean): void;
  onSelect(id: string): void;
  onDelete(id: string): void;
  deletingId: string | null;
}): ReactElement {
  const parentRef = useRef<HTMLDivElement>(null);
  const [lanes, setLanes] = useState(4);

  useEffect(() => {
    const element = parentRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const updateLanes = (width: number) => setLanes(lanesForWidth(width));
    updateLanes(element.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) updateLanes(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const rows = useMemo(() => chunk(props.items, lanes), [props.items, lanes]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => TILE_HEIGHT + TILE_GAP,
    overscan: 6
  });

  return (
    <div
      ref={parentRef}
      className="h-full overflow-auto"
      aria-label="Media assets"
      role="grid"
    >
      <div
        className="relative w-full"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const rowItems = rows[virtualRow.index] ?? [];
          return (
            <div
              key={virtualRow.key}
              role="row"
              className="absolute left-0 right-0 grid"
              style={{
                top: 0,
                transform: `translateY(${virtualRow.start}px)`,
                height: TILE_HEIGHT,
                gap: TILE_GAP,
                gridTemplateColumns: `repeat(${lanes}, minmax(0, 1fr))`
              }}
            >
              {rowItems.map((item) => (
                <MediaCard
                  key={item.id}
                  item={item}
                  selectedDetail={item.id === props.selectedDetailId}
                  checked={props.checked.has(item.id)}
                  deleting={item.id === props.deletingId}
                  onToggleCheck={(on) => props.onToggleCheck(item.id, on)}
                  onSelect={() => props.onSelect(item.id)}
                  onDelete={() => props.onDelete(item.id)}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MediaCard(props: {
  item: MediaRecord;
  selectedDetail: boolean;
  checked: boolean;
  deleting: boolean;
  onToggleCheck(on: boolean): void;
  onSelect(): void;
  onDelete(): void;
}): ReactElement {
  const category = categorize(props.item.contentType);
  const dimensions = dimensionsOf(props.item);
  const [copied, setCopied] = useState(false);

  const copyUrl = async () => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(props.item.url);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }
    } catch {
      setCopied(false);
    }
  };

  return (
    <article
      role="gridcell"
      aria-selected={props.selectedDetail}
      className={cn(
        "group/card relative flex h-full flex-col overflow-hidden rounded-md border bg-white shadow-sm transition-all",
        "hover:shadow-md",
        props.selectedDetail ? "border-[#4945ff] ring-2 ring-[#4945ff]/20" : "border-[#eaeaef]"
      )}
    >
      {/* 4:3 thumbnail */}
      <button
        type="button"
        onClick={props.onSelect}
        aria-label={`Open ${props.item.filename}`}
        className="relative block aspect-[4/3] w-full overflow-hidden bg-[#f6f6f9] text-left outline-none"
      >
        {category === "image" && props.item.url ? (
          <img
            src={props.item.url}
            alt={props.item.filename}
            loading="lazy"
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-[#666687]">
            <CategoryIcon category={category} size={36} />
            <span className="text-[11px] uppercase tracking-wider">{category}</span>
          </div>
        )}
      </button>

      {/* Hover overlay: checkbox top-left, action buttons top-right */}
      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-2 transition-opacity",
          props.checked
            ? "opacity-100"
            : "opacity-0 group-hover/card:opacity-100 group-focus-within/card:opacity-100"
        )}
      >
        <Checkbox
          checked={props.checked}
          onCheckedChange={(value) => props.onToggleCheck(value === true)}
          aria-label={`Select ${props.item.filename}`}
          className="pointer-events-auto h-5 w-5 rounded-[4px] border border-[#c0c0cf] bg-white shadow-sm"
        />
        <div className="pointer-events-auto flex gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="secondary"
                  size="icon-sm"
                  onClick={copyUrl}
                  aria-label={`Copy URL for ${props.item.filename}`}
                  className="h-7 w-7 rounded-[4px] bg-white shadow-sm hover:bg-[#f6f6f9]"
                />
              }
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </TooltipTrigger>
            <TooltipContent>{copied ? "Copied!" : "Copy URL"}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="destructive"
                  size="icon-sm"
                  onClick={props.onDelete}
                  disabled={props.deleting}
                  aria-label={`Delete ${props.item.filename}`}
                  className="h-7 w-7 rounded-[4px] shadow-sm"
                />
              }
            >
              <Trash2 size={13} />
            </TooltipTrigger>
            <TooltipContent>Delete</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Card body — filename, size, dimensions */}
      <div className="flex min-w-0 items-start justify-between gap-2 border-t border-[#eaeaef] px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-[#32324d]" title={props.item.filename}>
            {props.item.filename}
          </p>
          <p className="truncate text-[12px] text-[#666687]">
            {dimensions ? `${dimensions} · ` : ""}
            {formatBytes(props.item.size)}
          </p>
        </div>
        <span className="shrink-0 rounded-[3px] bg-[#f0f0ff] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[#4945ff]">
          {category}
        </span>
      </div>
    </article>
  );
}

/* -------------------------------------------------------------------------- */
/*  List view                                                                  */
/* -------------------------------------------------------------------------- */

function MediaList(props: {
  items: MediaRecord[];
  selectedIds: Set<string>;
  onToggle(id: string, on: boolean): void;
  onSelect(id: string): void;
  onDelete(id: string): void;
  deletingId: string | null;
}): ReactElement {
  return (
    <div className="overflow-hidden rounded-md border border-[#eaeaef] bg-white shadow-sm">
      <table className="w-full text-left text-[13px]">
        <thead className="border-b border-[#eaeaef] bg-[#f6f6f9] text-[11px] uppercase tracking-[0.06em] text-[#666687]">
          <tr>
            <th scope="col" className="w-10 px-3 py-2.5"></th>
            <th scope="col" className="w-12 px-2 py-2.5"></th>
            <th scope="col" className="px-3 py-2.5 font-semibold">Name</th>
            <th scope="col" className="px-3 py-2.5 font-semibold">Type</th>
            <th scope="col" className="px-3 py-2.5 font-semibold">Size</th>
            <th scope="col" className="px-3 py-2.5 font-semibold">Created</th>
            <th scope="col" className="w-24 px-3 py-2.5"></th>
          </tr>
        </thead>
        <tbody>
          {props.items.map((item) => {
            const category = categorize(item.contentType);
            const checked = props.selectedIds.has(item.id);
            return (
              <tr
                key={item.id}
                className="border-b border-[#eaeaef] last:border-b-0 hover:bg-[#f6f6f9]"
              >
                <td className="px-3 py-2">
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(value) => props.onToggle(item.id, value === true)}
                    aria-label={`Select ${item.filename}`}
                    className="h-4 w-4 rounded-[3px]"
                  />
                </td>
                <td className="px-2 py-2">
                  <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-[4px] border border-[#eaeaef] bg-[#f6f6f9] text-[#666687]">
                    {category === "image" && item.url ? (
                      <img src={item.url} alt={item.filename} className="h-full w-full object-cover" />
                    ) : (
                      <CategoryIcon category={category} size={16} />
                    )}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <button
                    type="button"
                    onClick={() => props.onSelect(item.id)}
                    className="truncate text-left font-medium text-[#32324d] hover:text-[#4945ff]"
                  >
                    {item.filename}
                  </button>
                </td>
                <td className="px-3 py-2 text-[#666687]">{item.contentType ?? "file"}</td>
                <td className="px-3 py-2 text-[#666687]">{formatBytes(item.size)}</td>
                <td className="px-3 py-2 text-[#666687]">{item.createdAt.slice(0, 10)}</td>
                <td className="px-3 py-2 text-right">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => props.onDelete(item.id)}
                    disabled={item.id === props.deletingId}
                    aria-label={`Delete ${item.filename}`}
                  >
                    <Trash2 size={14} />
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Detail drawer                                                              */
/* -------------------------------------------------------------------------- */

function MediaDetailDrawer(props: {
  item: MediaRecord | null;
  open: boolean;
  onClose(): void;
  onDelete(id: string): void;
  deleting: boolean;
}): ReactElement {
  return (
    <aside
      aria-label="Media detail"
      aria-hidden={!props.open}
      className={cn(
        "pointer-events-none absolute inset-y-0 right-0 z-10 w-full max-w-md transition-transform duration-200",
        props.open ? "pointer-events-auto translate-x-0" : "translate-x-full"
      )}
    >
      <div className="flex h-full flex-col rounded-md border border-[#eaeaef] bg-white shadow-lg">
        <header className="flex items-center justify-between border-b border-[#eaeaef] px-4 py-3">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#8e8ea9]">
              Asset detail
            </p>
            <h2 className="truncate text-[15px] font-semibold text-[#32324d]">
              {props.item?.filename ?? "No asset selected"}
            </h2>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={props.onClose}
            aria-label="Close detail panel"
          >
            <X size={14} />
          </Button>
        </header>

        {props.item ? <MediaDetailBody item={props.item} onDelete={props.onDelete} deleting={props.deleting} /> : null}
      </div>
    </aside>
  );
}

function MediaDetailBody(props: {
  item: MediaRecord;
  onDelete(id: string): void;
  deleting: boolean;
}): ReactElement {
  const category = categorize(props.item.contentType);
  const dimensions = dimensionsOf(props.item);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-md border border-[#eaeaef] bg-[#f6f6f9]">
        {category === "image" && props.item.url ? (
          <img
            src={props.item.url}
            alt={props.item.filename}
            className="h-full w-full object-contain"
          />
        ) : (
          <div className="flex flex-col items-center gap-2 text-[#666687]">
            <CategoryIcon category={category} size={48} />
            <span className="text-xs uppercase tracking-wider">{category}</span>
          </div>
        )}
      </div>

      <dl className="grid gap-3 text-sm">
        <DetailRow label="Filename" value={props.item.filename} />
        <DetailRow label="Key" value={props.item.key} mono />
        <DetailRow
          label="URL"
          value={
            <a
              href={props.item.url}
              target="_blank"
              rel="noreferrer"
              className="break-all underline text-[#4945ff]"
            >
              {props.item.url}
            </a>
          }
        />
        <DetailRow label="Content type" value={props.item.contentType ?? "file"} />
        <DetailRow label="Size" value={formatBytes(props.item.size)} />
        {dimensions && <DetailRow label="Dimensions" value={dimensions} />}
        <DetailRow label="Created" value={props.item.createdAt} />
        <DetailRow label="Updated" value={props.item.updatedAt} />
      </dl>

      <div className="mt-auto flex justify-end gap-2 pt-2">
        <Button
          type="button"
          variant="destructive"
          onClick={() => props.onDelete(props.item.id)}
          disabled={props.deleting}
        >
          <Trash2 size={15} /> Delete
        </Button>
      </div>
    </div>
  );
}

function DetailRow(props: { label: string; value: React.ReactNode; mono?: boolean }): ReactElement {
  return (
    <div className="grid grid-cols-[110px_minmax(0,1fr)] items-baseline gap-3">
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-[#8e8ea9]">
        {props.label}
      </dt>
      <dd className={cn("min-w-0 break-words text-[#32324d]", props.mono && "font-mono text-xs")}>
        {props.value}
      </dd>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Empty / skeleton                                                           */
/* -------------------------------------------------------------------------- */

function MediaEmpty(props: { onUpload(): void }): ReactElement {
  return (
    <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-3 rounded-md border border-dashed border-[#dcdce4] bg-white p-12 text-center">
      <div className="flex size-14 items-center justify-center rounded-full bg-[#f0f0ff] text-[#4945ff]">
        <Upload size={22} aria-hidden />
      </div>
      <div className="space-y-1">
        <p className="text-[15px] font-semibold text-[#32324d]">
          Upload your first assets...
        </p>
        <p className="text-[13px] text-[#666687]">
          Drop files here or click below to add your first asset.
        </p>
      </div>
      <Button type="button" onClick={props.onUpload}>
        <Plus size={15} aria-hidden /> Add new assets
      </Button>
    </div>
  );
}

function MediaSkeleton(): ReactElement {
  return (
    <div
      className="grid h-full min-h-[320px] grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
      aria-busy="true"
    >
      {Array.from({ length: 8 }).map((_, index) => (
        <div
          key={index}
          className="aspect-[4/3] animate-pulse rounded-md border border-[#eaeaef] bg-[#f6f6f9]"
        />
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Upload dialog                                                              */
/*                                                                             */
/*  Two tabs: From computer (drop zone + file list with per-file progress) and *
 *  From URL (paste a public URL).                                             *
 * -------------------------------------------------------------------------- */

type UploadJob = {
  id: string;
  file: File;
  progress: number;
  status: "pending" | "uploading" | "done" | "error";
  errorMessage?: string;
};

function newJobId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function UploadDialog(props: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onUpload(file: File): Promise<unknown>;
}): ReactElement {
  const [tab, setTab] = useState<"computer" | "url">("computer");
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [url, setUrl] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!props.open) {
      setJobs([]);
      setUrl("");
      setTab("computer");
      setDragOver(false);
    }
  }, [props.open]);

  const addFiles = (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    const newJobs: UploadJob[] = list.map((file) => ({
      id: newJobId(),
      file,
      progress: 0,
      status: "pending"
    }));
    setJobs((prev) => [...prev, ...newJobs]);
    void runUploads(newJobs);
  };

  const runUploads = async (queue: UploadJob[]) => {
    for (const job of queue) {
      setJobs((prev) =>
        prev.map((j) => (j.id === job.id ? { ...j, status: "uploading", progress: 10 } : j))
      );
      try {
        // Simulate progress while presigned upload runs (we don't have XHR-level progress).
        const tick = window.setInterval(() => {
          setJobs((prev) =>
            prev.map((j) =>
              j.id === job.id && j.status === "uploading" && j.progress < 85
                ? { ...j, progress: j.progress + 7 }
                : j
            )
          );
        }, 120);
        await props.onUpload(job.file);
        window.clearInterval(tick);
        setJobs((prev) =>
          prev.map((j) => (j.id === job.id ? { ...j, status: "done", progress: 100 } : j))
        );
      } catch (error) {
        setJobs((prev) =>
          prev.map((j) =>
            j.id === job.id
              ? {
                  ...j,
                  status: "error",
                  errorMessage: error instanceof Error ? error.message : "Upload failed."
                }
              : j
          )
        );
      }
    }
  };

  const handleUrlSubmit = async () => {
    const trimmed = url.trim();
    if (!trimmed) {
      toast.error("Enter a URL to upload.");
      return;
    }
    try {
      const response = await fetch(trimmed);
      if (!response.ok) throw new Error(`Failed to fetch (${response.status})`);
      const blob = await response.blob();
      const filename = trimmed.split("/").pop()?.split("?")[0] || "remote-asset";
      const file = new File([blob], filename, { type: blob.type || "application/octet-stream" });
      setUrl("");
      addFiles([file]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to download remote asset.");
    }
  };

  const allDone = jobs.length > 0 && jobs.every((j) => j.status === "done");

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>Add new assets</DialogTitle>
          <DialogDescription>
            Upload files from your computer or import them from a public URL.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(value) => setTab(value as "computer" | "url")}>
          <TabsList className="w-full justify-start">
            <TabsTrigger value="computer">From computer</TabsTrigger>
            <TabsTrigger value="url">From URL</TabsTrigger>
          </TabsList>

          <TabsContent value="computer" className="mt-4 space-y-3">
            <div
              role="presentation"
              onDragOver={(event) => {
                event.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragOver(false);
                if (event.dataTransfer.files.length > 0) addFiles(event.dataTransfer.files);
              }}
              onClick={() => fileInputRef.current?.click()}
              className={cn(
                "flex cursor-pointer flex-col items-center justify-center gap-3 rounded-md border-2 border-dashed px-6 py-10 text-center transition-colors",
                dragOver
                  ? "border-[#4945ff] bg-[#f0f0ff]"
                  : "border-[#dcdce4] bg-[#f6f6f9] hover:border-[#4945ff]/60 hover:bg-[#f0f0ff]/40"
              )}
            >
              <div className="flex size-12 items-center justify-center rounded-full bg-[#f0f0ff] text-[#4945ff]">
                <Upload size={22} aria-hidden />
              </div>
              <div className="space-y-0.5">
                <p className="text-[14px] font-semibold text-[#32324d]">
                  Drag &amp; drop here or browse files
                </p>
                <p className="text-[12px] text-[#666687]">
                  Click anywhere in this zone to select files from your computer.
                </p>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                aria-label="Choose files to upload"
                onChange={(event) => {
                  if (event.currentTarget.files) addFiles(event.currentTarget.files);
                  event.currentTarget.value = "";
                }}
              />
            </div>

            {jobs.length > 0 && (
              <ul className="grid gap-2" aria-label="Upload progress">
                {jobs.map((job) => (
                  <li
                    key={job.id}
                    className="grid gap-1 rounded-md border border-[#eaeaef] bg-white px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-2 text-[12px]">
                      <span className="min-w-0 truncate font-medium text-[#32324d]">
                        {job.file.name}
                      </span>
                      <span className="shrink-0 text-[#666687]">
                        {job.status === "done"
                          ? "Done"
                          : job.status === "error"
                            ? "Failed"
                            : `${job.progress}%`}
                      </span>
                    </div>
                    <Progress
                      value={job.status === "error" ? 0 : job.progress}
                      className="gap-0"
                    />
                    {job.errorMessage ? (
                      <p className="text-[11px] text-red-600">{job.errorMessage}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>

          <TabsContent value="url" className="mt-4 space-y-3">
            <label className="grid gap-1.5 text-sm text-[#32324d]">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[#8e8ea9]">
                URL
              </span>
              <div className="relative">
                <LinkIcon
                  size={15}
                  aria-hidden
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#8e8ea9]"
                />
                <Input
                  type="url"
                  value={url}
                  onChange={(event) => setUrl(event.currentTarget.value)}
                  placeholder="https://example.com/image.png"
                  className="h-10 rounded-md border-[#dcdce4] bg-white pl-9 text-[14px] shadow-none"
                />
              </div>
            </label>
            <p className="text-[12px] text-[#666687]">
              The asset will be downloaded then uploaded to your storage.
            </p>
            <div className="flex justify-end">
              <Button type="button" onClick={() => void handleUrlSubmit()}>
                <Upload size={15} aria-hidden /> Fetch &amp; upload
              </Button>
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => props.onOpenChange(false)}
          >
            {allDone ? "Done" : "Cancel"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
