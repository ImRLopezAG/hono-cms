#!/usr/bin/env bun
/**
 * Strapi content-type + record seeder for the pixel-parity harness.
 *
 * Why a separate script?
 *
 * The Strapi v5 content-type-builder API requires `isDevelopmentMode` and
 * triggers a `strapi.reload()` that frequently crashes the parent `npm run
 * develop` child process. Writing schema files directly to disk avoids that
 * reload pathway: Strapi's `develop` mode watches `src/api/` and will restart
 * itself once when the files appear, instead of multiple times per CTB call.
 *
 * What this seeds (per the U1 plan):
 *   - `api::author.author`  (Author CT with name, email, articles reverse rel)
 *   - `api::article.article` (Article CT with title, slug, body, cover, author)
 *   - One Author record (Ada Lovelace)
 *   - Two Article records so the list view actually has rows
 *
 * Idempotency:
 *   - Schema files: only written if missing or different from the canonical form.
 *   - Records: only created if the collection is currently empty.
 *   - Strapi restart: only triggered if schema files changed.
 *
 * Usage:
 *   bash tools/parity/setup-strapi.sh             # boot Strapi (admin registers)
 *   bun tools/parity/seed-strapi.ts               # then seed (this script)
 *   bun tools/parity/capture.ts --side=both       # capture
 *
 * Env vars (same as setup-strapi.sh / capture.ts):
 *   STRAPI_PARITY_DIR              default: /tmp/strapi-parity-ref
 *   STRAPI_PARITY_PORT             default: 1337
 *   STRAPI_PARITY_ADMIN_EMAIL      default: parity@example.com
 *   STRAPI_PARITY_ADMIN_PASSWORD   default: Parity-Demo-1
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

type CtSchema = {
  readonly kind: "collectionType" | "singleType";
  readonly collectionName: string;
  readonly info: {
    readonly singularName: string;
    readonly pluralName: string;
    readonly displayName: string;
    readonly description?: string;
  };
  readonly options: { readonly draftAndPublish: boolean };
  readonly pluginOptions?: Record<string, unknown>;
  readonly attributes: Record<string, Record<string, unknown>>;
};

const STRAPI_DIR =
  process.env.STRAPI_PARITY_DIR ?? "/tmp/strapi-parity-ref";
const STRAPI_PORT = process.env.STRAPI_PARITY_PORT ?? "1337";
const STRAPI_BASE = `http://localhost:${STRAPI_PORT}`;
const ADMIN_EMAIL =
  process.env.STRAPI_PARITY_ADMIN_EMAIL ?? "parity@example.com";
const ADMIN_PASSWORD =
  process.env.STRAPI_PARITY_ADMIN_PASSWORD ?? "Parity-Demo-1";

/* ---------------------------------------------------------------- *
 * Schema definitions — these are written verbatim to src/api/...   *
 * Author must declare `articles` (mappedBy) so the Article side's  *
 * `inversedBy: "articles"` resolves on boot. Without this, Strapi  *
 * refuses to start with                                             *
 *   "inversedBy attribute articles not found target ..."           *
 * which was the original blocker observed during U3 diagnostics.   *
 * ---------------------------------------------------------------- */

const AUTHOR_SCHEMA: CtSchema = {
  kind: "collectionType",
  collectionName: "authors",
  info: {
    singularName: "author",
    pluralName: "authors",
    displayName: "Author",
    description: "Parity seed: byline used by Article relations."
  },
  options: { draftAndPublish: false },
  attributes: {
    name: { type: "string", required: true },
    email: { type: "email" },
    articles: {
      type: "relation",
      relation: "oneToMany",
      target: "api::article.article",
      mappedBy: "author"
    }
  }
};

const ARTICLE_SCHEMA: CtSchema = {
  kind: "collectionType",
  collectionName: "articles",
  info: {
    singularName: "article",
    pluralName: "articles",
    displayName: "Article",
    description: "Parity seed: example editorial entry."
  },
  options: { draftAndPublish: true },
  attributes: {
    title: { type: "string", required: true },
    slug: { type: "uid", targetField: "title" },
    body: { type: "richtext" },
    cover: {
      type: "media",
      multiple: false,
      allowedTypes: ["images"]
    },
    author: {
      type: "relation",
      relation: "manyToOne",
      target: "api::author.author",
      inversedBy: "articles"
    }
  }
};

type ApiScaffold = {
  readonly singular: string;
  readonly plural: string;
  readonly schema: CtSchema;
};

const APIS: readonly ApiScaffold[] = [
  { singular: "author", plural: "authors", schema: AUTHOR_SCHEMA },
  { singular: "article", plural: "articles", schema: ARTICLE_SCHEMA }
];

function log(message: string): void {
  process.stdout.write(`[parity:seed] ${message}\n`);
}

async function fileEqualsJson(
  path: string,
  expected: unknown
): Promise<boolean> {
  if (!existsSync(path)) return false;
  try {
    const actual = JSON.parse(await readFile(path, "utf8"));
    return JSON.stringify(actual) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

/**
 * Write the four files Strapi v5 expects for an API:
 *   src/api/<n>/content-types/<n>/schema.json
 *   src/api/<n>/controllers/<n>.ts
 *   src/api/<n>/routes/<n>.ts
 *   src/api/<n>/services/<n>.ts
 *
 * Returns true if any file changed (so the caller knows to restart Strapi).
 */
async function writeApiIfMissing(api: ApiScaffold): Promise<boolean> {
  const base = join(STRAPI_DIR, "src", "api", api.singular);
  const schemaPath = join(
    base,
    "content-types",
    api.singular,
    "schema.json"
  );
  const controllerPath = join(base, "controllers", `${api.singular}.ts`);
  const routePath = join(base, "routes", `${api.singular}.ts`);
  const servicePath = join(base, "services", `${api.singular}.ts`);

  let changed = false;

  if (!(await fileEqualsJson(schemaPath, api.schema))) {
    await mkdir(join(base, "content-types", api.singular), {
      recursive: true
    });
    await writeFile(schemaPath, `${JSON.stringify(api.schema, null, 2)}\n`);
    log(`wrote schema: ${schemaPath}`);
    changed = true;
  }

  if (!existsSync(controllerPath)) {
    await mkdir(join(base, "controllers"), { recursive: true });
    await writeFile(
      controllerPath,
      `/**\n * ${api.singular} controller (parity seed)\n */\n\n` +
        `import { factories } from "@strapi/strapi";\n\n` +
        `export default factories.createCoreController(` +
        `"api::${api.singular}.${api.singular}");\n`
    );
    log(`wrote controller: ${controllerPath}`);
    changed = true;
  }

  if (!existsSync(routePath)) {
    await mkdir(join(base, "routes"), { recursive: true });
    await writeFile(
      routePath,
      `/**\n * ${api.singular} router (parity seed)\n */\n\n` +
        `import { factories } from "@strapi/strapi";\n\n` +
        `export default factories.createCoreRouter(` +
        `"api::${api.singular}.${api.singular}");\n`
    );
    log(`wrote route: ${routePath}`);
    changed = true;
  }

  if (!existsSync(servicePath)) {
    await mkdir(join(base, "services"), { recursive: true });
    await writeFile(
      servicePath,
      `/**\n * ${api.singular} service (parity seed)\n */\n\n` +
        `import { factories } from "@strapi/strapi";\n\n` +
        `export default factories.createCoreService(` +
        `"api::${api.singular}.${api.singular}");\n`
    );
    log(`wrote service: ${servicePath}`);
    changed = true;
  }

  return changed;
}

async function isStrapiAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${STRAPI_BASE}/admin/init`, {
      signal: AbortSignal.timeout(3_000)
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Wait up to `timeoutMs` for Strapi to respond on /admin/init.
 */
async function waitForStrapi(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isStrapiAlive()) return;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(
    `Strapi did not become reachable on ${STRAPI_BASE} within ${timeoutMs}ms.`
  );
}

/**
 * Kill any process tracked in `.parity-strapi.pid` and start a fresh
 * `npm run develop`. Detaches the child so it survives this script's exit.
 */
function restartStrapi(): void {
  const pidFile = join(STRAPI_DIR, ".parity-strapi.pid");
  const logFile = join(STRAPI_DIR, ".parity-strapi.log");
  if (existsSync(pidFile)) {
    const pid = Number((spawnSync("cat", [pidFile]).stdout ?? "").toString().trim());
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, "SIGTERM");
        log(`stopped existing Strapi (pid ${pid})`);
      } catch {
        // No-op: process already exited.
      }
    }
  }

  const child = spawn("npm", ["run", "develop"], {
    cwd: STRAPI_DIR,
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, PORT: STRAPI_PORT }
  });
  child.unref();
  // Record the new PID so subsequent runs can stop it too.
  spawnSync("sh", ["-c", `echo ${child.pid} > ${pidFile}`]);
  // Redirect via shell after the fact is messy; for log inspection the
  // operator can `tail -f /tmp/strapi-parity-ref/.parity-strapi.log` if they
  // started Strapi via setup-strapi.sh. This restart prioritises survival
  // over log capture.
  log(`started Strapi (pid ${child.pid}); log: ${logFile}`);
}

/**
 * Login + return the JWT. Retries through Strapi's rate-limiter window
 * (HTTP 429) — repeated login failures during U3 diagnostics tripped it.
 */
async function loginRetry(): Promise<string> {
  let lastError = "";
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const res = await fetch(`${STRAPI_BASE}/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
        signal: AbortSignal.timeout(10_000)
      });
      if (res.status === 429) {
        lastError = "rate-limited (429)";
      } else if (res.ok) {
        const body = (await res.json()) as { data?: { token?: string } };
        const token = body?.data?.token;
        if (token) return token;
        lastError = "no token in response";
      } else {
        lastError = `HTTP ${res.status}`;
      }
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    const wait = Math.min(15_000, 2_000 + attempt * 1_500);
    log(`login retry ${attempt + 1}: ${lastError} (waiting ${wait}ms)`);
    await new Promise((r) => setTimeout(r, wait));
  }
  throw new Error(`Strapi login failed after 12 attempts: ${lastError}`);
}

async function listRecords(
  token: string,
  uid: string
): Promise<readonly { documentId: string }[]> {
  const res = await fetch(
    `${STRAPI_BASE}/content-manager/collection-types/${uid}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    throw new Error(
      `listRecords(${uid}) failed: HTTP ${res.status} ${await res.text()}`
    );
  }
  const body = (await res.json()) as {
    results?: { documentId: string }[];
  };
  return body.results ?? [];
}

async function createRecord(
  token: string,
  uid: string,
  data: Record<string, unknown>
): Promise<{ documentId: string }> {
  const res = await fetch(
    `${STRAPI_BASE}/content-manager/collection-types/${uid}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(data)
    }
  );
  if (!res.ok) {
    throw new Error(
      `createRecord(${uid}) failed: HTTP ${res.status} ${await res.text()}`
    );
  }
  const body = (await res.json()) as { data?: { documentId: string } };
  if (!body.data?.documentId) {
    throw new Error(`createRecord(${uid}): missing documentId in response`);
  }
  return { documentId: body.data.documentId };
}

async function ensureRecords(token: string): Promise<void> {
  // Author records first so Article can reference one via relation.
  const existingAuthors = await listRecords(token, "api::author.author");
  let authorDocId: string;
  if (existingAuthors.length > 0) {
    authorDocId = existingAuthors[0]!.documentId;
    log(`author record already present (documentId=${authorDocId})`);
  } else {
    const created = await createRecord(token, "api::author.author", {
      name: "Ada Lovelace",
      email: "ada@example.com"
    });
    authorDocId = created.documentId;
    log(`created author (documentId=${authorDocId})`);
  }

  const existingArticles = await listRecords(token, "api::article.article");
  if (existingArticles.length >= 2) {
    log(`articles already seeded (${existingArticles.length} present)`);
    return;
  }

  const needed = 2 - existingArticles.length;
  const payloads: ReadonlyArray<Record<string, unknown>> = [
    {
      title: "Hello Strapi",
      slug: "hello-strapi",
      body:
        "Reference content for the parity diff. This article demonstrates " +
        "the standard Strapi v5 content manager edit experience that the " +
        "hono-cms admin mirrors."
    },
    {
      title: "Second post",
      slug: "second-post",
      body:
        "Another draft entry so the list view renders with status chips and " +
        "timestamps. Without two rows the table chrome collapses and the " +
        "diff against hono-cms looks misleading."
    }
  ];
  for (const payload of payloads.slice(0, needed)) {
    const created = await createRecord(
      token,
      "api::article.article",
      payload
    );
    log(`created article "${payload.title}" (documentId=${created.documentId})`);
  }
}

/**
 * Persist the first article's documentId to a sentinel file. `capture.ts`
 * reads this so it can navigate to a real edit page rather than guessing
 * `/1` (which fails because Strapi v5 routes by documentId).
 */
async function writeDocumentIdSentinel(token: string): Promise<void> {
  const articles = await listRecords(token, "api::article.article");
  if (articles.length === 0) {
    log("WARNING: no articles to record in sentinel");
    return;
  }
  const sentinelPath = join(STRAPI_DIR, ".parity-document-ids.json");
  const payload = {
    articleDocumentId: articles[0]!.documentId,
    generatedAt: new Date().toISOString()
  };
  await writeFile(sentinelPath, `${JSON.stringify(payload, null, 2)}\n`);
  log(`wrote document-id sentinel: ${sentinelPath}`);
}

async function main(): Promise<void> {
  if (!existsSync(STRAPI_DIR)) {
    throw new Error(
      `Strapi reference project not found at ${STRAPI_DIR}. ` +
        `Run \`bash tools/parity/setup-strapi.sh\` first.`
    );
  }

  log(`Strapi project: ${STRAPI_DIR}`);
  log(`Strapi base:    ${STRAPI_BASE}`);

  // Write schema files first so a fresh boot picks them up.
  let anyChange = false;
  for (const api of APIS) {
    if (await writeApiIfMissing(api)) anyChange = true;
  }

  const alive = await isStrapiAlive();
  if (!alive) {
    log("Strapi not running — starting it.");
    restartStrapi();
    await waitForStrapi(180_000);
  } else if (anyChange) {
    log("Schema files changed — restarting Strapi to apply.");
    restartStrapi();
    await waitForStrapi(180_000);
  } else {
    log("Strapi already running and schemas unchanged.");
  }

  const token = await loginRetry();
  log("authenticated");
  await ensureRecords(token);
  await writeDocumentIdSentinel(token);
  log("done");
}

main().catch((error: unknown) => {
  process.stderr.write(
    `[parity:seed] failed: ${
      error instanceof Error ? error.stack ?? error.message : String(error)
    }\n`
  );
  process.exit(1);
});
