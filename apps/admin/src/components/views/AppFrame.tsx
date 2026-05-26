/* -------------------------------------------------------------------------- *
 *  AppFrame — Strapi v5 two-rail chassis                                     *
 *                                                                            *
 *  This file owns the workspace chrome. Visually it mirrors Strapi v5's     *
 *  layout structure exactly:                                                 *
 *                                                                            *
 *    +--------+----------+----------------------------------------+         *
 *    | Rail 1 | Rail 2   | Main area                              |         *
 *    | ~56px  | ~200px   | bg-[#f6f6f9]                           |         *
 *    | icons  | section  | per-page header + content              |         *
 *    +--------+----------+----------------------------------------+         *
 *                                                                            *
 *  Rail 1 is full-bleed WHITE (not the old #212134 dark) — we switch        *
 *  per Strapi's chrome and document the change so reviewers don't think     *
 *  the existing dark sidebar tokens were forgotten.                          *
 *                                                                            *
 *  Section content for Rail 2 is supplied by nested views via the           *
 *  `useRail2Slot` hook + context — when no view registers, we render the    *
 *  bare section title derived from the current route. The Settings sub-nav  *
 *  registers itself automatically when the path starts with `/settings/`.   *
 *                                                                            *
 *  Auth routes (login / register / 2fa / etc.) bypass the rails entirely.   *
 * -------------------------------------------------------------------------- */

import { useHotkeys } from "@tanstack/react-hotkeys";
import { Link, Outlet, useBlocker, useLocation, useNavigate } from "@tanstack/react-router";
import { useAtom, useAtomValue } from "jotai";
import {
  FileText,
  Home,
  Image as ImageIcon,
  KeyRound,
  LayoutGrid,
  LogOut,
  Search,
  Settings as SettingsIcon,
  User as UserIcon,
  Workflow
} from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode
} from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  authTokenAtom,
  commandPaletteOpenAtom,
  hasUnsavedChangesAtom
} from "../../state/admin-atoms";
import { CommandPalette, type CommandPaletteRoute } from "../CommandPalette";
import { authRedirectForPath, isAdminAuthRoute, shouldBlockAdminNavigation } from "./auth-helpers";
import { SettingsSubNav } from "./SettingsLayout";
import { SHELL_HOTKEYS, UnsavedChangesDialog } from "./shared";

/* -------------------------------------------------------------------------- */
/*  Primary nav model                                                          */
/* -------------------------------------------------------------------------- */

type PrimaryTo =
  | "/"
  | "/content"
  | "/media"
  | "/settings/content-types"
  | "/settings/api-keys";

type PrimaryItem = {
  to: PrimaryTo;
  label: string;
  icon: ReactElement;
  matches: (pathname: string) => boolean;
};

const PRIMARY_ITEMS: PrimaryItem[] = [
  {
    to: "/",
    label: "Home",
    icon: <Home size={18} aria-hidden />,
    matches: (pathname) => pathname === "/"
  },
  {
    to: "/content",
    label: "Content Manager",
    icon: <FileText size={18} aria-hidden />,
    matches: (pathname) => pathname === "/content" || pathname.startsWith("/content/")
  },
  {
    to: "/media",
    label: "Media Library",
    icon: <ImageIcon size={18} aria-hidden />,
    matches: (pathname) => pathname === "/media" || pathname.startsWith("/media/")
  },
  {
    to: "/settings/content-types",
    label: "Content-Type Builder",
    icon: <LayoutGrid size={18} aria-hidden />,
    matches: (pathname) => pathname.startsWith("/settings/content-types")
  },
  {
    to: "/settings/api-keys",
    label: "Settings",
    icon: <SettingsIcon size={18} aria-hidden />,
    matches: (pathname) =>
      (pathname === "/settings" || pathname.startsWith("/settings/")) &&
      !pathname.startsWith("/settings/content-types")
  }
];

/* -------------------------------------------------------------------------- */
/*  Section title mapping                                                      */
/*                                                                             */
/*  Strapi labels Rail 2's title to match the active section. We mirror the   */
/*  exact strings the user requested.                                          */
/* -------------------------------------------------------------------------- */

export function sectionTitleForPath(pathname: string): string {
  if (pathname === "/" || pathname === "") return "Home";
  if (pathname.startsWith("/content")) return "Content Manager";
  if (pathname.startsWith("/media")) return "Media Library";
  if (pathname.startsWith("/settings/content-types")) return "Content-Type Builder";
  if (pathname === "/settings" || pathname.startsWith("/settings/")) return "Settings";
  if (pathname.startsWith("/organization")) return "Organization";
  return "Workspace";
}

/* -------------------------------------------------------------------------- */
/*  Rail 2 slot — React context                                                */
/*                                                                             */
/*  Any view rendered under `<Outlet />` can call `useRail2Slot(node)` to     *
 *  inject its own section content into Rail 2. Mount / unmount semantics are *
 *  driven by `useEffect`, so leaving a route automatically clears the slot.  *
 * -------------------------------------------------------------------------- */

type Rail2SlotContextValue = {
  setSlot: (node: ReactNode | null) => void;
};

const Rail2SlotContext = createContext<Rail2SlotContextValue | null>(null);

/**
 * Register Rail 2 content for the current route. Pass `null` to render
 * nothing under the section title (the default).
 */
export function useRail2Slot(node: ReactNode | null): void {
  const ctx = useContext(Rail2SlotContext);
  useEffect(() => {
    if (!ctx) return;
    ctx.setSlot(node);
    return () => ctx.setSlot(null);
    // We re-register whenever the rendered node changes by identity.
  }, [ctx, node]);
}

/* -------------------------------------------------------------------------- */
/*  AppFrame                                                                   */
/* -------------------------------------------------------------------------- */

export function AppFrame(): ReactElement {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const [commandOpen, setCommandOpen] = useAtom(commandPaletteOpenAtom);
  const token = useAtomValue(authTokenAtom);
  const hasUnsavedChanges = useAtomValue(hasUnsavedChangesAtom);
  const [rail2Slot, setRail2Slot] = useState<ReactNode | null>(null);

  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => shouldBlockAdminNavigation(hasUnsavedChanges, current.pathname, next.pathname),
    enableBeforeUnload: () => hasUnsavedChanges,
    disabled: !hasUnsavedChanges,
    withResolver: true
  });

  useHotkeys([{ hotkey: SHELL_HOTKEYS.commandPalette, callback: () => setCommandOpen((open) => !open) }], {
    preventDefault: true,
    stopPropagation: true,
    requireReset: true
  });

  const runCommand = (to: CommandPaletteRoute) => {
    setCommandOpen(false);
    void navigate({ to });
  };

  useEffect(() => {
    const redirect = authRedirectForPath(Boolean(token), pathname);
    if (redirect) void navigate({ to: redirect, replace: true });
  }, [navigate, pathname, token]);

  /* Auth-route isolation: rails do not render on login / register / 2fa etc. */
  if (isAdminAuthRoute(pathname)) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-[#f6f6f9]">
        <Outlet />
      </div>
    );
  }

  const sectionTitle = sectionTitleForPath(pathname);
  /* Settings routes get their dedicated sub-nav as the default Rail 2 content. */
  const inSettings = pathname === "/settings" || pathname.startsWith("/settings/");
  const defaultRail2 = inSettings ? <SettingsSubNav variant="embedded" /> : null;

  const slotContext: Rail2SlotContextValue = useMemo(() => ({ setSlot: setRail2Slot }), []);

  return (
    <Rail2SlotContext.Provider value={slotContext}>
      <div className="flex min-h-screen bg-[#f6f6f9] text-[#32324d]">
        <Rail1 pathname={pathname} token={token} />
        <Rail2 title={sectionTitle}>{rail2Slot ?? defaultRail2}</Rail2>

        <main className="min-w-0 flex-1 overflow-auto bg-[#f6f6f9]" aria-label="Workspace content">
          <Outlet />
        </main>

        <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} onNavigate={runCommand} />
        <UnsavedChangesDialog
          open={blocker.status === "blocked"}
          onStay={() => blocker.reset?.()}
          onLeave={() => blocker.proceed?.()}
        />
      </div>
    </Rail2SlotContext.Provider>
  );
}

/* -------------------------------------------------------------------------- */
/*  Rail 1 — primary nav                                                       */
/* -------------------------------------------------------------------------- */

function Rail1(props: { pathname: string; token: string | null }): ReactElement {
  return (
    <aside
      aria-label="Primary navigation"
      data-rail="1"
      className="sticky top-0 z-20 flex h-screen w-[56px] shrink-0 flex-col items-center border-r border-[#eaeaef] bg-white"
    >
      <BrandMark />
      <nav aria-label="Sections" className="mt-2 flex flex-1 flex-col items-center gap-1 py-2">
        {PRIMARY_ITEMS.map((item) => (
          <Rail1Link
            key={item.to}
            to={item.to}
            label={item.label}
            icon={item.icon}
            active={item.matches(props.pathname)}
          />
        ))}
      </nav>
      <Rail1UserMenu token={props.token} />
    </aside>
  );
}

function BrandMark(): ReactElement {
  return (
    <Link
      to="/"
      aria-label="Hono CMS home"
      className="mt-3 inline-flex size-8 items-center justify-center rounded-[6px] bg-[#4945ff] text-white no-underline transition-opacity hover:opacity-90"
    >
      <Workflow size={16} aria-hidden />
    </Link>
  );
}

function Rail1Link(props: {
  to: PrimaryTo;
  label: string;
  icon: ReactElement;
  active: boolean;
}): ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            to={props.to}
            aria-label={props.label}
            aria-current={props.active ? "page" : undefined}
            className={cn(
              "inline-flex size-7 items-center justify-center rounded-[6px] text-[#666687] no-underline transition-colors",
              "hover:bg-[#f6f6f9] hover:text-[#32324d]",
              props.active && "bg-[#f0f0ff] text-[#4945ff] hover:bg-[#f0f0ff] hover:text-[#4945ff]"
            )}
          >
            {props.icon}
          </Link>
        }
      />
      <TooltipContent side="right">{props.label}</TooltipContent>
    </Tooltip>
  );
}

function Rail1UserMenu(props: { token: string | null }): ReactElement {
  const navigate = useNavigate();
  const [, setCommandOpen] = useAtom(commandPaletteOpenAtom);
  const [, setToken] = useAtom(authTokenAtom);
  const initials = deriveInitials(props.token);
  return (
    <div className="mb-3 mt-2 flex items-center justify-center">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label="Account menu"
              className="inline-flex items-center justify-center rounded-full transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4945ff]/40"
            >
              <Avatar className="size-10 bg-[#4945ff] text-white">
                <AvatarFallback className="bg-[#4945ff] text-[12px] font-semibold text-white">
                  {initials}
                </AvatarFallback>
              </Avatar>
            </button>
          }
        />
        <DropdownMenuContent align="start" side="right" className="min-w-[220px]">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="flex flex-col gap-0.5">
              <span className="text-[12px] font-medium text-[#32324d]">Signed in</span>
              <span className="inline-flex items-center gap-1.5 text-[11px] text-[#666687]">
                <KeyRound size={11} aria-hidden />
                {props.token ? "Admin token" : "No session"}
              </span>
            </DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void navigate({ to: "/organization/settings" })}>
            <UserIcon size={14} aria-hidden /> Profile
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void navigate({ to: "/settings/api-keys" })}>
            <SettingsIcon size={14} aria-hidden /> Settings
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setCommandOpen(true)}>
            <Search size={14} aria-hidden /> Search workspace
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={!props.token}
            onSelect={() => {
              setToken(null);
              void navigate({ to: "/login", replace: true });
            }}
          >
            <LogOut size={14} aria-hidden /> Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Rail 2 — section rail                                                      */
/* -------------------------------------------------------------------------- */

function Rail2(props: { title: string; children?: ReactNode }): ReactElement {
  return (
    <aside
      aria-label="Section navigation"
      aria-labelledby="hcms-rail2-title"
      data-rail="2"
      className="sticky top-0 z-10 hidden h-screen w-[232px] shrink-0 flex-col border-r border-[#eaeaef] bg-white md:flex"
    >
      <header className="px-4 pb-3 pt-5">
        <p className="m-0 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8e8ea9]">
          Hono CMS
        </p>
        <h2
          id="hcms-rail2-title"
          className="m-0 mt-0.5 text-[18px] font-bold leading-tight tracking-tight text-[#32324d]"
        >
          {props.title}
        </h2>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{props.children}</div>
    </aside>
  );
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function deriveInitials(token: string | null): string {
  if (!token) return "HC";
  const cleaned = token.replace(/[^A-Za-z0-9]/g, "");
  if (cleaned.length === 0) return "HC";
  return cleaned.slice(0, 2).toUpperCase();
}
