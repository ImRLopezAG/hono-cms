import { Link, useLocation } from "@tanstack/react-router";
import { type ReactElement, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Strapi v5's `/settings/*` shell renders a two-level navigation: the
 * primary MainNav collapses to icons, and a sub-nav surfaces every
 * settings section grouped by domain ("GLOBAL SETTINGS",
 * "ADMINISTRATION PANEL", "EMAIL PLUGIN", "USERS & PERMISSIONS PLUGIN").
 *
 * `SettingsLayout` ports that pattern into Hono CMS. The sub-nav is
 * rendered as `embedded` Rail 2 content (registered by AppFrame's
 * `useRail2Slot` for any `/settings/*` route) so the chrome stays
 * fully Strapi-shaped.
 *
 * Sections + ordering mirror Strapi's `useSettingsMenu()`, adapted to
 * Hono CMS' surfaces (System / Schema / Security / Internationalization
 * / Organization).
 *
 * Visual treatment is pinned to the values called out in the U9 plan:
 *   section header  text-[11px] font-semibold uppercase tracking-wider
 *                   text-[#666687] mt-4 first:mt-0
 *   item base       rounded-md
 *   item hover      bg-[#f6f6f9]
 *   item active     bg-[#f0f0ff] text-[#4945ff] font-medium
 */

type SettingsRoute =
  | "/settings/health"
  | "/settings/audit-log"
  | "/settings/webhooks"
  | "/settings/api-keys"
  | "/settings/sessions"
  | "/settings/content-types"
  | "/settings/roles"
  | "/settings/i18n"
  | "/organization/members"
  | "/organization/invitations"
  | "/organization/settings";

type SettingsLink = {
  to: SettingsRoute;
  label: string;
};

type SettingsSection = {
  label: string;
  items: SettingsLink[];
};

const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    label: "System",
    items: [
      { to: "/settings/health", label: "Health" },
      { to: "/settings/audit-log", label: "Audit log" },
      { to: "/settings/webhooks", label: "Webhooks" },
      { to: "/settings/api-keys", label: "API Tokens" },
      { to: "/settings/sessions", label: "Sessions" }
    ]
  },
  {
    label: "Schema",
    items: [
      { to: "/settings/content-types", label: "Content types" }
    ]
  },
  {
    label: "Security",
    items: [
      { to: "/settings/roles", label: "Roles & Permissions" }
    ]
  },
  {
    label: "Internationalization",
    items: [
      { to: "/settings/i18n", label: "i18n" }
    ]
  },
  {
    label: "Organization",
    items: [
      { to: "/organization/members", label: "Members" },
      { to: "/organization/invitations", label: "Invitations" },
      { to: "/organization/settings", label: "Workspace" }
    ]
  }
];

export function SettingsLayout(props: { children: ReactNode }): ReactElement {
  return (
    <div className="flex min-h-0 flex-1">
      <SettingsSubNav />
      <div className="flex min-w-0 flex-1 flex-col">{props.children}</div>
    </div>
  );
}

/**
 * Second-level navigation rail. Two render modes:
 *
 *   - `standalone` (default): legacy 240px sidebar with its own header.
 *     Kept for fallback use and unit tests that pre-date U4's two-rail
 *     chassis. Hidden below `md`.
 *   - `embedded`: rendered inside Rail 2 (`AppFrame.tsx`); skips the
 *     duplicate "Settings" header — Rail 2 already provides the section
 *     title — and uses tighter outer padding.
 */
export function SettingsSubNav(props: { variant?: "standalone" | "embedded" } = {}): ReactElement {
  const pathname = useLocation({ select: (location) => location.pathname });
  const embedded = props.variant === "embedded";
  return (
    <nav
      aria-label="Settings sections"
      className={cn(
        "flex flex-col bg-white",
        embedded
          ? "px-3 pb-6 pt-1"
          : "hidden w-[240px] shrink-0 border-r border-[#eaeaef] px-3 py-6 md:flex"
      )}
    >
      {!embedded && (
        <div className="mb-4 px-2">
          <p className="m-0 text-[15px] font-semibold leading-tight text-[#32324d]">Settings</p>
          <p className="mt-1 text-[12px] text-[#666687]">Workspace-wide configuration</p>
        </div>
      )}
      {SETTINGS_SECTIONS.map((section, index) => (
        <SettingsSubNavSection
          key={section.label}
          section={section}
          pathname={pathname}
          first={index === 0}
        />
      ))}
    </nav>
  );
}

function SettingsSubNavSection(props: {
  section: SettingsSection;
  pathname: string;
  first: boolean;
}): ReactElement {
  const { section, pathname, first } = props;
  return (
    <div className="flex flex-col gap-1">
      <p
        className={cn(
          "px-2 text-[11px] font-semibold uppercase tracking-wider text-[#666687]",
          first ? "mt-0" : "mt-4"
        )}
      >
        {section.label}
      </p>
      <ul className="m-0 flex flex-col gap-0.5 p-0">
        {section.items.map((item) => {
          const active = isActive(pathname, item.to);
          return (
            <li key={item.to} className="list-none">
              <Link
                to={item.to}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-8 items-center rounded-md px-2 text-[13px] text-[#32324d] no-underline transition-colors",
                  "hover:bg-[#f6f6f9]",
                  active && "bg-[#f0f0ff] font-medium text-[#4945ff] hover:bg-[#f0f0ff]"
                )}
              >
                <span className="truncate">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Active matcher. We rely on prefix matching so deep links like
 * `/settings/content-types/visualizer` keep `Content types` highlighted.
 * The exception is `/settings/audit-log` which would otherwise also
 * highlight when navigating to `/settings/audit-log/<id>` — that's the
 * expected behaviour.
 */
function isActive(pathname: string, to: SettingsRoute): boolean {
  if (pathname === to) return true;
  return pathname.startsWith(`${to}/`);
}
