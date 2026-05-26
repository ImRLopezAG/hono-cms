#!/usr/bin/env bun
/**
 * Idempotent seed for parity capture: ensures at least one author and one
 * article record exist on the newsroom CMS so capture screens are populated.
 *
 * Per docs/plans/2026-05-23-001-feat-strapi-pixel-parity-admin-plan.md U2.
 *
 * Usage:
 *   bun examples/newsroom/src/seed-parity.ts --cms-url <url> --token <bearer>
 */

type CliArgs = { cmsUrl: string; token: string };

function parseArgs(argv: readonly string[]): CliArgs {
  const args = new Map<string, string>();
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    if (flag?.startsWith("--")) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        args.set(flag.slice(2), next);
        i++;
      }
    }
  }
  const cmsUrl = args.get("cms-url") ?? "http://localhost:8787";
  const token = args.get("token") ?? "admin";
  return { cmsUrl, token };
}

async function request(
  url: string,
  init: RequestInit & { token: string }
): Promise<unknown> {
  const { token, ...rest } = init;
  const response = await fetch(url, {
    ...rest,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(rest.headers ?? {})
    }
  });
  const text = await response.text();
  const body = text ? safeJson(text) : null;
  if (!response.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${url} -> ${response.status}: ${text.slice(0, 240)}`
    );
  }
  return body;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

type RecordList<T> = { items: T[] };

const PARITY_AUTHOR_NAME = "Ada Lovelace";
const PARITY_ARTICLE_SLUG = "hello-parity";

async function ensureAuthor(args: CliArgs): Promise<string> {
  const query = `filter[name]=${encodeURIComponent(PARITY_AUTHOR_NAME)}&limit=1`;
  const existing = (await request(`${args.cmsUrl}/api/authors?${query}`, {
    method: "GET",
    token: args.token
  })) as RecordList<{ id: string }>;
  const first = existing.items?.[0];
  if (first?.id) {
    console.log(`[seed-parity] reusing author ${first.id}`);
    return first.id;
  }
  const created = (await request(`${args.cmsUrl}/api/authors`, {
    method: "POST",
    token: args.token,
    body: JSON.stringify({
      name: PARITY_AUTHOR_NAME,
      bio: "Reference author for parity capture."
    })
  })) as { id: string };
  console.log(`[seed-parity] created author ${created.id}`);
  return created.id;
}

async function ensureArticle(args: CliArgs, authorId: string): Promise<string> {
  const query = `filter[slug]=${encodeURIComponent(PARITY_ARTICLE_SLUG)}&limit=1`;
  const existing = (await request(`${args.cmsUrl}/api/articles?${query}`, {
    method: "GET",
    token: args.token
  })) as RecordList<{ id: string }>;
  const first = existing.items?.[0];
  if (first?.id) {
    console.log(`[seed-parity] reusing article ${first.id}`);
    return first.id;
  }
  const created = (await request(`${args.cmsUrl}/api/articles`, {
    method: "POST",
    token: args.token,
    body: JSON.stringify({
      title: "Hello Parity",
      slug: PARITY_ARTICLE_SLUG,
      summary: "Reference article for parity capture.",
      views: 0,
      author: authorId
    })
  })) as { id: string };
  console.log(`[seed-parity] created article ${created.id}`);
  return created.id;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  console.log(`[seed-parity] target: ${args.cmsUrl}`);
  const authorId = await ensureAuthor(args);
  await ensureArticle(args, authorId);
  console.log("[seed-parity] done");
}

main().catch((error: unknown) => {
  console.error("[seed-parity] failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
