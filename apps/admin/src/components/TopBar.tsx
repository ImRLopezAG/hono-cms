import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useAtom, useSetAtom } from "jotai";
import { Bell, ChevronDown, KeyRound, LogOut, Search, Settings as SettingsIcon, User as UserIcon } from "lucide-react";
import { type ReactElement } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
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
import { authTokenAtom, commandPaletteOpenAtom } from "../state/admin-atoms";
import { pageTitleForPath } from "./views/auth-helpers";

const MOD_KEY_LABEL = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform) ? "⌘" : "Ctrl";

/**
 * Strapi-style workspace top-bar.
 *
 * Layout (left → right):
 *   1. Eyebrow + page title derived from the active route.
 *   2. Global search trigger (opens the existing command palette via
 *      `commandPaletteOpenAtom`). Shows `⌘K` / `CtrlK` hint like Strapi.
 *   3. Notifications bell (placeholder — real wiring lands when the
 *      Hono CMS notification stream ships).
 *   4. User avatar dropdown with Profile / Settings / Sign out.
 *
 * All chrome lives in Tailwind utility classes; no `.css` file is
 * introduced. Colors read from the token CSS variables defined in
 * `styles/tokens.css` so light/dark theming Just Works.
 */
export function TopBar(): ReactElement {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pathname = useLocation({ select: (location) => location.pathname });
  const [token, setToken] = useAtom(authTokenAtom);
  const setCommandOpen = useSetAtom(commandPaletteOpenAtom);
  const heading = pageTitleForPath(pathname);
  const signOut = () => {
    setToken(null);
    queryClient.clear();
    void navigate({ to: "/login", replace: true });
  };
  const initials = deriveInitials(token);

  return (
    <header
      className="flex h-14 shrink-0 items-center gap-4 border-b border-[color:var(--color-border)] bg-[color:var(--surface-primary)] px-5"
      aria-label="Workspace header"
    >
      <div className="flex min-w-0 flex-col leading-tight">
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[color:var(--color-ink-faint)]">
          {heading.eyebrow}
        </span>
        <h1 className="m-0 truncate text-[16px] font-semibold tracking-[-0.005em] text-[color:var(--color-ink)]">
          {heading.title}
        </h1>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={() => setCommandOpen(true)}
          aria-label="Open command palette"
          className="hidden h-9 min-w-[260px] items-center gap-2 rounded-[4px] border border-[color:var(--color-border-strong)] bg-[color:var(--surface-primary)] px-3 text-left text-[13px] text-[color:var(--color-ink-mute)] outline-none transition-colors hover:border-[color:var(--color-primary-600)] focus-visible:border-[color:var(--color-primary-600)] focus-visible:shadow-[0_0_0_3px_rgba(73,69,255,0.18)] md:inline-flex"
        >
          <Search size={14} aria-hidden />
          <span className="flex-1 truncate">Search workspace</span>
          <kbd className="rounded-[3px] border border-[color:var(--color-border)] bg-[color:var(--surface-secondary)] px-1.5 py-[1px] text-[10px] font-medium text-[color:var(--color-ink-mute)] tracking-tight">
            {MOD_KEY_LABEL}K
          </kbd>
        </button>

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-9 rounded-[4px] text-[color:var(--color-ink-mute)] hover:bg-[color:var(--surface-secondary)] hover:text-[color:var(--color-ink)] md:hidden"
                onClick={() => setCommandOpen(true)}
                aria-label="Open command palette"
              >
                <Search size={16} aria-hidden />
              </Button>
            }
          />
          <TooltipContent side="bottom">
            Search · {MOD_KEY_LABEL}K
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-9 rounded-[4px] text-[color:var(--color-ink-mute)] hover:bg-[color:var(--surface-secondary)] hover:text-[color:var(--color-ink)]"
                aria-label="Notifications"
              >
                <Bell size={16} aria-hidden />
              </Button>
            }
          />
          <TooltipContent side="bottom">Notifications</TooltipContent>
        </Tooltip>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                className="flex h-9 items-center gap-2 rounded-[4px] border border-transparent px-1 transition-colors hover:border-[color:var(--color-border)] hover:bg-[color:var(--surface-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary-600)]/40"
                aria-label="User menu"
              >
                <Avatar className="size-7 bg-[color:var(--color-primary-100)] text-[color:var(--color-primary-700)]">
                  <AvatarFallback className="bg-transparent text-[11px] font-semibold">
                    {initials}
                  </AvatarFallback>
                </Avatar>
                <ChevronDown size={14} className="text-[color:var(--color-ink-mute)]" aria-hidden />
              </button>
            }
          />
          <DropdownMenuContent align="end" className="min-w-[200px]">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="flex flex-col gap-0.5">
                <span className="text-[12px] font-medium text-[color:var(--color-ink)]">Signed in</span>
                <span className="inline-flex items-center gap-1.5 text-[11px] text-[color:var(--color-ink-mute)]">
                  <KeyRound size={11} aria-hidden />
                  {token ? "Admin token" : "No session"}
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
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={!token}
              onSelect={signOut}
            >
              <LogOut size={14} aria-hidden /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

function deriveInitials(token: string | null): string {
  if (!token) return "HC";
  // Tokens are opaque; use the leading two non-space characters for a
  // deterministic, low-noise initial avatar. Falls back to HC when the
  // token is too short.
  const cleaned = token.replace(/[^A-Za-z0-9]/g, "");
  if (cleaned.length === 0) return "HC";
  return cleaned.slice(0, 2).toUpperCase();
}
