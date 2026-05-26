import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import qs from "qs";
import { describe, expect, test } from "vitest";
import { generateOpenAPISchemas, generateTypeScriptSDK } from "@hono-cms/schema";
import { createNewsroomCMS, fetchHandler } from "./app";
import { createNewsroomClient, seedAndReadPublishedArticle } from "./consumer";
import { createNewsroomCloudflareWorker, createNewsroomVercelHandler, newsroomCronSecret, newsroomVercelJson } from "./edge";
import { startNewsroomNodeServer } from "./node-server";
import { newsroomSchema } from "./schema";

const exampleDir = dirname(fileURLToPath(import.meta.url));

describe("newsroom example", () => {
  test("runs a real content workflow over the Web Request API", async () => {
    const cms = createNewsroomCMS();
    const author = await cms.fetch(new Request("https://cms.test/api/authors", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada Lovelace", bio: "Computing notes", apiKey: "private" })
    }));
    expect(author.status).toBe(201);
    const authorBody = await author.json() as { id: string; name: string; apiKey?: string };
    expect(authorBody).toMatchObject({ name: "Ada Lovelace" });
    expect(authorBody.apiKey).toBeUndefined();

    const publicAuthor = await cms.fetch(new Request(`https://cms.test/api/authors/${authorBody.id}`));
    expect(publicAuthor.status).toBe(200);
    await expect(publicAuthor.json()).resolves.toMatchObject({ id: authorBody.id, name: "Ada Lovelace" });

    const created = await cms.fetch(new Request("https://cms.test/api/articles", {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({
        title: "Edge CMS Launch",
        slug: "edge-cms-launch",
        summary: "A portable CMS built on Web Request APIs.",
        views: 42,
        author: authorBody.id
      })
    }));
    expect(created.status).toBe(201);
    const article = await created.json() as { id: string; status: string };

    const published = await cms.fetch(new Request(`https://cms.test/api/articles/${article.id}/publish`, {
      method: "POST",
      headers: { authorization: "Bearer admin" }
    }));
    expect(published.status).toBe(200);

    const query = qs.stringify({
      filters: { title: { $contains: "Edge" } },
      pagination: { limit: 10 },
      populate: ["author"]
    }, { encodeValuesOnly: true, arrayFormat: "brackets" });
    const list = await cms.fetch(new Request(`https://cms.test/api/articles?${query}`));
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      items: [{
        id: article.id,
        title: "Edge CMS Launch",
        status: "published",
        author: { id: authorBody.id, name: "Ada Lovelace" }
      }]
    });
  });

  test("ships generated contracts for SDK and OpenAPI consumers", async () => {
    const sdk = generateTypeScriptSDK(newsroomSchema);
    expect(sdk).toContain("export function buildArticlesQuery(query: ArticlesQuery = {}): string");
    expect(sdk).toContain("export type ArticlesRelationKey = \"author\";");
    expect(sdk).toContain("createCMSClient");

    const schemas = generateOpenAPISchemas(newsroomSchema);
    expect(schemas).toHaveProperty("Articles");
    expect(schemas).toHaveProperty("ArticlesCreateInput");

    const spec = await fetchHandler(new Request("https://cms.test/cms/openapi.json"));
    expect(spec.status).toBe(200);
    const specBody = await spec.json() as { paths: Record<string, unknown> };
    expect(specBody).toMatchObject({
      info: {
        title: "Newsroom CMS API",
        version: "0.1.0",
        description: "Example newsroom API built with Hono CMS."
      },
      servers: [{ url: "https://newsroom.example.com", description: "Production" }]
    });
    expect(specBody.paths).toHaveProperty("/graphql");
    expect(specBody.paths).toHaveProperty("/graphql/schema");
  });

  test("keeps the committed generated SDK in sync with the schema generator", async () => {
    const generated = await readFile(join(exampleDir, "generated/sdk.ts"), "utf8");

    expect(generated).toBe(generateTypeScriptSDK(newsroomSchema));
  });

  test("uses the committed generated SDK against the real CMS handler", async () => {
    const cms = createNewsroomCMS();
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = input instanceof Request
        ? new Request(input, init)
        : new Request(input, init);
      return cms.fetch(request);
    };
    const client = createNewsroomClient(fetch);

    const result = await seedAndReadPublishedArticle(client);

    expect(result).toMatchObject({
      listedTitle: "Typed CMS Ships",
      listedAuthor: "Grace Hopper"
    });
    expect(result.query).toBe("filters[title][$contains]=Typed&pagination[limit]=5&populate[]=author");
  });

  test("serves the generated SDK workflow through the Node HTTP adapter", async () => {
    const server = await startNewsroomNodeServer();
    try {
      const client = createNewsroomClient(fetch, server.url);
      const result = await seedAndReadPublishedArticle(client);

      expect(result).toMatchObject({
        listedTitle: "Typed CMS Ships",
        listedAuthor: "Grace Hopper"
      });

      const health = await fetch(`${server.url}/cms/health/live`);
      await expect(health.json()).resolves.toMatchObject({ status: "ok" });
    } finally {
      await server.close();
    }
  });

  test("runs the generated SDK workflow through Cloudflare and Vercel edge handlers", async () => {
    const worker = createNewsroomCloudflareWorker();
    const cloudflareFetch: typeof globalThis.fetch = async (input, init) => {
      const request = input instanceof Request
        ? new Request(input, init)
        : new Request(input, init);
      return worker.fetch(request, { CMS_ENV: "test" }, { waitUntil: () => undefined });
    };
    const cloudflareResult = await seedAndReadPublishedArticle(createNewsroomClient(cloudflareFetch));

    expect(cloudflareResult).toMatchObject({
      listedTitle: "Typed CMS Ships",
      listedAuthor: "Grace Hopper"
    });

    const vercel = createNewsroomVercelHandler();
    const vercelFetch: typeof globalThis.fetch = async (input, init) => {
      const request = input instanceof Request
        ? new Request(input, init)
        : new Request(input, init);
      return vercel(request);
    };
    const vercelResult = await seedAndReadPublishedArticle(createNewsroomClient(vercelFetch));

    expect(vercelResult).toMatchObject({
      listedTitle: "Typed CMS Ships",
      listedAuthor: "Grace Hopper"
    });
    const unauthorizedCron = await vercel(new Request("https://cms.test/cms/jobs/scheduled-publish", {
      method: "GET"
    }));
    expect(unauthorizedCron.status).toBe(401);

    const cron = await vercel(new Request("https://cms.test/cms/jobs/scheduled-publish", {
      method: "GET",
      headers: { authorization: `Bearer ${newsroomCronSecret}` }
    }));
    expect(cron.status).toBe(200);
    await expect(cron.json()).resolves.toEqual({ published: 0 });

    expect(newsroomVercelJson).toEqual({
      crons: [{ path: "/cms/jobs/scheduled-publish", schedule: "*/5 * * * *" }]
    });
  });
});
