const AUTH_ROUTES = new Set(["/login", "/register", "/forgot-password", "/magic-link", "/verify-email", "/2fa/setup", "/2fa/verify"]);

export function isAdminAuthRoute(pathname: string): boolean {
  return AUTH_ROUTES.has(pathname);
}

export function authRedirectForPath(isAuthenticated: boolean, pathname: string): "/login" | "/content" | null {
  if (!isAuthenticated && !isAdminAuthRoute(pathname)) return "/login";
  if (isAuthenticated && isAdminAuthRoute(pathname)) return "/content";
  return null;
}

export function readStoredAdminAuthToken(storage: Pick<Storage, "getItem"> | undefined = typeof globalThis.localStorage === "undefined" ? undefined : globalThis.localStorage): string | null {
  const raw = storage?.getItem("hono-cms:auth-token");
  if (!raw || raw === "null") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "string" && parsed.trim() ? parsed : null;
  } catch {
    return raw.trim() ? raw : null;
  }
}

export function authRedirectForStoredToken(pathname: string, storage?: Pick<Storage, "getItem">): "/login" | "/content" | null {
  return authRedirectForPath(Boolean(readStoredAdminAuthToken(storage)), pathname);
}

export function shouldBlockAdminNavigation(hasUnsavedChanges: boolean, currentPath: string, nextPath: string): boolean {
  return hasUnsavedChanges && currentPath !== nextPath;
}

export type ContentRouteState = {
  collectionName?: string;
  recordId?: string | null;
  createNew?: boolean;
  routeSearch?: Partial<import("../../lib/route-search").ContentSearchState>;
};

export type MediaRouteState = {
  mediaId?: string | null;
};

export function contentRouteStateFromParams(params: ContentRouteState): Required<ContentRouteState> {
  return {
    collectionName: params.collectionName ?? "",
    recordId: params.recordId ?? null,
    createNew: params.createNew ?? false,
    routeSearch: params.routeSearch ?? { q: "", status: "all", sort: "-updatedAt" }
  };
}

export function mediaRouteStateFromParams(params: MediaRouteState): Required<MediaRouteState> {
  return {
    mediaId: params.mediaId ?? null
  };
}

/**
 * Returns true when the path is anywhere under `/settings/*`. Used by the
 * shell to decide whether to render the nested settings sub-nav and
 * auto-collapse the primary sidebar.
 */
export function isSettingsRoute(pathname: string): boolean {
  return pathname === "/settings" || pathname.startsWith("/settings/");
}

const ROUTE_TITLES: ReadonlyArray<{ prefix: string; eyebrow: string; title: string }> = [
  { prefix: "/content", eyebrow: "Workspace", title: "Content manager" },
  { prefix: "/media", eyebrow: "Workspace", title: "Media library" },
  { prefix: "/organization/members", eyebrow: "Organisation", title: "Members" },
  { prefix: "/organization/invitations", eyebrow: "Organisation", title: "Invitations" },
  { prefix: "/organization/settings", eyebrow: "Organisation", title: "Organisation settings" },
  { prefix: "/organization", eyebrow: "Organisation", title: "Organisation" },
  { prefix: "/settings/webhooks", eyebrow: "Settings", title: "Webhooks" },
  { prefix: "/settings/api-keys", eyebrow: "Settings", title: "API tokens" },
  { prefix: "/settings/sessions", eyebrow: "Settings", title: "Sessions" },
  { prefix: "/settings/audit-log", eyebrow: "Settings", title: "Audit log" },
  { prefix: "/settings/health", eyebrow: "Settings", title: "Health" },
  { prefix: "/settings/content-types/visualizer", eyebrow: "Settings", title: "Content-type visualizer" },
  { prefix: "/settings/content-types", eyebrow: "Settings", title: "Content types" },
  { prefix: "/settings/i18n", eyebrow: "Settings", title: "Internationalisation" },
  { prefix: "/settings", eyebrow: "Global", title: "Settings" },
  { prefix: "/login", eyebrow: "Account", title: "Sign in" },
  { prefix: "/register", eyebrow: "Account", title: "Create account" },
  { prefix: "/forgot-password", eyebrow: "Account", title: "Reset password" },
  { prefix: "/magic-link", eyebrow: "Account", title: "Magic link" },
  { prefix: "/verify-email", eyebrow: "Account", title: "Verify email" },
  { prefix: "/2fa/setup", eyebrow: "Account", title: "Two-factor setup" },
  { prefix: "/2fa/verify", eyebrow: "Account", title: "Two-factor challenge" }
];

export type ShellPageTitle = { eyebrow: string; title: string };

/**
 * Best-effort page title derived from the pathname, used by `TopBar` to
 * mirror Strapi's behaviour where the workspace header always tells the
 * operator where they are.
 */
export function pageTitleForPath(pathname: string): ShellPageTitle {
  const match = ROUTE_TITLES.find((entry) => pathname.startsWith(entry.prefix));
  return match ? { eyebrow: match.eyebrow, title: match.title } : { eyebrow: "Hono CMS", title: "Workspace" };
}
