import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Command } from "cmdk";
import { useAtom, useSetAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import {
  Building2,
  Database,
  FileText,
  FolderCog,
  Globe2,
  HeartPulse,
  History,
  Image as ImageIcon,
  LogOut,
  MonitorSmartphone,
  PanelLeftClose,
  PlusCircle,
  ShieldCheck,
  UserPlus,
  Users,
  Webhook,
  Workflow,
  type LucideIcon
} from "lucide-react";
import { useMemo, type ReactElement } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { createAdminApiClient } from "../lib/api-client";
import {
  authTokenAtom,
  commandPaletteOpenAtom,
  sidebarCollapsedAtom
} from "../state/admin-atoms";

export type CommandPaletteRoute =
  | "/content"
  | "/media"
  | "/settings/health"
  | "/settings/audit-log"
  | "/settings/webhooks"
  | "/settings/api-keys"
  | "/settings/sessions"
  | "/settings/content-types"
  | "/settings/content-types/visualizer"
  | "/settings/i18n"
  | "/organization/settings"
  | "/organization/members"
  | "/organization/invitations";

type PageEntry = {
  to: CommandPaletteRoute;
  label: string;
  icon: LucideIcon;
  keywords?: ReadonlyArray<string>;
};

const PAGES: ReadonlyArray<PageEntry> = [
  { to: "/content", label: "Content", icon: FileText, keywords: ["records", "entries", "workspace"] },
  { to: "/media", label: "Media library", icon: ImageIcon, keywords: ["assets", "files", "uploads"] },
  { to: "/settings/content-types", label: "Content types", icon: FolderCog, keywords: ["schema", "models", "collections"] },
  { to: "/settings/content-types/visualizer", label: "Schema visualizer", icon: Workflow, keywords: ["graph", "diagram", "schema"] },
  { to: "/settings/i18n", label: "Internationalisation", icon: Globe2, keywords: ["i18n", "locales", "translation"] },
  { to: "/settings/health", label: "Health", icon: HeartPulse, keywords: ["status", "uptime", "monitor"] },
  { to: "/settings/audit-log", label: "Audit log", icon: History, keywords: ["history", "events"] },
  { to: "/settings/webhooks", label: "Webhooks", icon: Webhook, keywords: ["hooks", "events", "integrations"] },
  { to: "/settings/api-keys", label: "API tokens", icon: ShieldCheck, keywords: ["keys", "credentials", "auth"] },
  { to: "/settings/sessions", label: "Sessions", icon: MonitorSmartphone, keywords: ["devices", "logins"] },
  { to: "/organization/settings", label: "Organisation settings", icon: Building2, keywords: ["org", "workspace"] },
  { to: "/organization/members", label: "Members", icon: Users, keywords: ["team", "people"] },
  { to: "/organization/invitations", label: "Invitations", icon: UserPlus, keywords: ["invites", "join"] }
];

const recentRoutesAtom = atomWithStorage<ReadonlyArray<CommandPaletteRoute>>(
  "hono-cms:command-recent",
  []
);

const RECENT_LIMIT = 5;

function pushRecent(current: ReadonlyArray<CommandPaletteRoute>, route: CommandPaletteRoute): ReadonlyArray<CommandPaletteRoute> {
  const next = [route, ...current.filter((entry) => entry !== route)];
  return next.slice(0, RECENT_LIMIT);
}

function pageByRoute(route: CommandPaletteRoute): PageEntry | undefined {
  return PAGES.find((page) => page.to === route);
}

export function CommandPalette(props: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onNavigate(to: CommandPaletteRoute): void;
}): ReactElement {
  const { open, onOpenChange, onNavigate } = props;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [token, setToken] = useAtom(authTokenAtom);
  const setCommandOpen = useSetAtom(commandPaletteOpenAtom);
  const [sidebarCollapsed, setSidebarCollapsed] = useAtom(sidebarCollapsedAtom);
  const [recents, setRecents] = useAtom(recentRoutesAtom);

  const client = useMemo(() => createAdminApiClient(undefined, token), [token]);
  const schemaQuery = useQuery({
    queryKey: ["schema"],
    queryFn: () => client.schema(),
    enabled: open && Boolean(token)
  });

  const collections = useMemo(() => {
    const map = schemaQuery.data?.collections;
    if (!map) return [] as ReadonlyArray<string>;
    return Object.keys(map).sort();
  }, [schemaQuery.data]);

  const rememberAndClose = (route: CommandPaletteRoute) => {
    setRecents((current) => pushRecent(current, route));
    setCommandOpen(false);
    onNavigate(route);
  };

  const navigateToCollection = (collectionName: string) => {
    setCommandOpen(false);
    void navigate({
      to: "/content/$collectionName",
      params: { collectionName }
    });
  };

  const handleCreateRecord = () => {
    const first = collections[0];
    if (first) {
      setCommandOpen(false);
      void navigate({
        to: "/content/$collectionName/new",
        params: { collectionName: first }
      });
      return;
    }
    rememberAndClose("/content");
  };

  const handleSignOut = () => {
    setToken(null);
    queryClient.clear();
    setCommandOpen(false);
    void navigate({ to: "/login", replace: true });
  };

  const handleToggleSidebar = () => {
    setSidebarCollapsed(!sidebarCollapsed);
    setCommandOpen(false);
  };

  const handleOpenVisualizer = () => {
    rememberAndClose("/settings/content-types/visualizer");
  };

  const handleNewCollection = () => {
    rememberAndClose("/settings/content-types");
  };

  const recentPages = useMemo(() => {
    return recents
      .map((route) => pageByRoute(route))
      .filter((entry): entry is PageEntry => Boolean(entry));
  }, [recents]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-1/4 translate-y-0 overflow-hidden rounded-xl! p-0 sm:max-w-xl"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Command palette</DialogTitle>
          <DialogDescription>Search pages, collections, and quick actions.</DialogDescription>
        </DialogHeader>
        <Command
          label="Command palette"
          className="flex flex-col w-full max-w-xl rounded-xl border border-[color:var(--color-border)] bg-white shadow-2xl"
        >
          <div className="border-b border-[color:var(--color-border)] p-3">
            <Command.Input
              autoFocus
              placeholder="Search pages, collections, or actions..."
              className="w-full bg-transparent text-sm outline-none placeholder:text-[color:var(--color-muted-foreground)]"
            />
          </div>
          <Command.List className="max-h-[420px] overflow-y-auto p-2">
            <Command.Empty className="px-3 py-6 text-center text-sm text-[color:var(--color-muted-foreground)]">
              No results found.
            </Command.Empty>

            {recentPages.length > 0 && (
              <Command.Group
                heading="Recent"
                className="px-1 pb-2 text-xs font-medium text-[color:var(--color-muted-foreground)] [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
              >
                {recentPages.map((page) => {
                  const Icon = page.icon;
                  return (
                    <Command.Item
                      key={`recent-${page.to}`}
                      value={`recent ${page.label} ${page.to}`}
                      keywords={page.keywords ? [...page.keywords] : undefined}
                      onSelect={() => rememberAndClose(page.to)}
                      className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer rounded-md aria-selected:bg-[color:var(--color-accent-soft)] aria-selected:text-[color:var(--color-accent-ink)]"
                    >
                      <Icon size={16} aria-hidden="true" />
                      <span className="flex-1 text-[color:var(--color-foreground)]">{page.label}</span>
                      <span className="text-xs text-[color:var(--color-muted-foreground)]">{page.to}</span>
                    </Command.Item>
                  );
                })}
              </Command.Group>
            )}

            <Command.Group
              heading="Pages"
              className="px-1 pb-2 text-xs font-medium text-[color:var(--color-muted-foreground)] [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
            >
              {PAGES.map((page) => {
                const Icon = page.icon;
                return (
                  <Command.Item
                    key={page.to}
                    value={`${page.label} ${page.to}`}
                    keywords={page.keywords ? [...page.keywords] : undefined}
                    onSelect={() => rememberAndClose(page.to)}
                    className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer rounded-md aria-selected:bg-[color:var(--color-accent-soft)] aria-selected:text-[color:var(--color-accent-ink)]"
                  >
                    <Icon size={16} aria-hidden="true" />
                    <span className="flex-1 text-[color:var(--color-foreground)]">{page.label}</span>
                    <span className="text-xs text-[color:var(--color-muted-foreground)]">{page.to}</span>
                  </Command.Item>
                );
              })}
            </Command.Group>

            {collections.length > 0 && (
              <Command.Group
                heading="Collections"
                className="px-1 pb-2 text-xs font-medium text-[color:var(--color-muted-foreground)] [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
              >
                {collections.map((collectionName) => (
                  <Command.Item
                    key={`collection-${collectionName}`}
                    value={`open ${collectionName} content collection`}
                    keywords={[collectionName, "collection", "content"]}
                    onSelect={() => navigateToCollection(collectionName)}
                    className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer rounded-md aria-selected:bg-[color:var(--color-accent-soft)] aria-selected:text-[color:var(--color-accent-ink)]"
                  >
                    <Database size={16} aria-hidden="true" />
                    <span className="flex-1 text-[color:var(--color-foreground)]">Open {collectionName} content</span>
                    <span className="text-xs text-[color:var(--color-muted-foreground)]">/content/{collectionName}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            <Command.Group
              heading="Actions"
              className="px-1 pb-2 text-xs font-medium text-[color:var(--color-muted-foreground)] [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
            >
              <Command.Item
                value="create record new entry"
                keywords={["new", "record", "entry", "draft"]}
                onSelect={handleCreateRecord}
                className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer rounded-md aria-selected:bg-[color:var(--color-accent-soft)] aria-selected:text-[color:var(--color-accent-ink)]"
              >
                <PlusCircle size={16} aria-hidden="true" />
                <span className="flex-1 text-[color:var(--color-foreground)]">Create record</span>
              </Command.Item>
              <Command.Item
                value="new collection content type"
                keywords={["schema", "type", "collection"]}
                onSelect={handleNewCollection}
                className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer rounded-md aria-selected:bg-[color:var(--color-accent-soft)] aria-selected:text-[color:var(--color-accent-ink)]"
              >
                <FolderCog size={16} aria-hidden="true" />
                <span className="flex-1 text-[color:var(--color-foreground)]">New collection</span>
              </Command.Item>
              <Command.Item
                value="open visualizer schema graph"
                keywords={["visualizer", "graph", "diagram", "schema"]}
                onSelect={handleOpenVisualizer}
                className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer rounded-md aria-selected:bg-[color:var(--color-accent-soft)] aria-selected:text-[color:var(--color-accent-ink)]"
              >
                <Workflow size={16} aria-hidden="true" />
                <span className="flex-1 text-[color:var(--color-foreground)]">Open visualizer</span>
              </Command.Item>
              <Command.Item
                value="toggle sidebar navigation"
                keywords={["sidebar", "panel", "navigation"]}
                onSelect={handleToggleSidebar}
                className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer rounded-md aria-selected:bg-[color:var(--color-accent-soft)] aria-selected:text-[color:var(--color-accent-ink)]"
              >
                <PanelLeftClose size={16} aria-hidden="true" />
                <span className="flex-1 text-[color:var(--color-foreground)]">Toggle sidebar</span>
              </Command.Item>
              <Command.Item
                value="sign out logout"
                keywords={["logout", "exit", "session"]}
                onSelect={handleSignOut}
                className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer rounded-md aria-selected:bg-[color:var(--color-accent-soft)] aria-selected:text-[color:var(--color-accent-ink)]"
              >
                <LogOut size={16} aria-hidden="true" />
                <span className="flex-1 text-[color:var(--color-foreground)]">Sign out</span>
              </Command.Item>
            </Command.Group>
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
