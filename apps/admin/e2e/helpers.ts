import type { APIRequestContext, BrowserContext } from "@playwright/test";

export const AUTH_STORAGE_KEY = "hono-cms:auth-token";
export const ADMIN_TOKEN = "admin";
export const CMS_BASE_URL = process.env.PLAYWRIGHT_CMS_URL ?? "http://127.0.0.1:8787";

/**
 * Seeds the admin bearer token into the browser context so the very first
 * navigation lands on an authenticated route instead of `/login`.
 */
export async function seedAdminToken(
  context: BrowserContext,
  token: string = ADMIN_TOKEN
): Promise<void> {
  await context.addInitScript(([key, value]) => {
    window.localStorage.setItem(key, JSON.stringify(value));
  }, [AUTH_STORAGE_KEY, token] as const);
}

export type ArticleOverrides = {
  title?: string;
  slug?: string;
  summary?: string;
  views?: number;
};

export type ArticleRecord = {
  id: string;
  title: string;
  slug: string;
  status?: "draft" | "published" | "archived";
  [key: string]: unknown;
};

/**
 * Creates a record via the CMS REST API using the admin bearer token.
 *
 * Defaults to the `articles` collection (newsroom example schema). The
 * resulting document is returned so specs can navigate directly to it.
 */
export async function createPostViaApi(
  request: APIRequestContext,
  overrides: ArticleOverrides & { collection?: string; token?: string } = {}
): Promise<ArticleRecord> {
  const collection = overrides.collection ?? "articles";
  const token = overrides.token ?? ADMIN_TOKEN;
  const unique = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const title = overrides.title ?? `E2E Article ${unique}`;
  const slug = overrides.slug ?? `e2e-article-${unique}`;
  const body = {
    title,
    slug,
    summary: overrides.summary ?? "Created by Playwright e2e suite.",
    views: overrides.views ?? 0
  };
  const response = await request.post(`${CMS_BASE_URL}/api/${collection}`, {
    data: body,
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json"
    }
  });
  if (!response.ok()) {
    const text = await response.text().catch(() => "<unreadable>");
    throw new Error(
      `createPostViaApi: ${response.status()} ${response.statusText()} — ${text}`
    );
  }
  return (await response.json()) as ArticleRecord;
}
