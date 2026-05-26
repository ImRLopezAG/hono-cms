export type ContentTypeSmokeHarness = {
  enabled: boolean;
  requests: Array<{ url: string; method: string; body?: string }>;
};

export function installContentTypeSmokeHarness(location: Pick<Location, "search"> = globalThis.location, storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): ContentTypeSmokeHarness {
  const enabled = new URLSearchParams(location.search).get("cmsSmoke") === "content-types";
  const requests: ContentTypeSmokeHarness["requests"] = [];
  if (!enabled) return { enabled, requests };

  storage?.setItem("hono-cms:auth-token", JSON.stringify("smoke-admin"));
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(requestUrl(input), init);
    const url = new URL(request.url, globalThis.location.origin);
    if (!url.pathname.startsWith("/cms/content-types")) return originalFetch(input, init);

    const method = request.method.toUpperCase();
    const body = method === "GET" ? undefined : await request.clone().text();
    requests.push({ url: url.pathname, method, ...(body ? { body } : {}) });

    if (method === "POST") {
      const parsed = body ? JSON.parse(body) as { name?: string; fields?: Record<string, unknown>; options?: Record<string, unknown> } : {};
      const name = parsed.name ?? "smoke-products";
      return Response.json({
        collection: {
          name,
          fields: parsed.fields ?? { title: { kind: "string", required: true } },
          options: parsed.options ?? {}
        },
        source: `export const ${camelCase(name)} = defineCollection("${name}", ${JSON.stringify(parsed.fields ?? {}, null, 2)});`,
        path: `cms/collections/${name}.ts`,
        artifacts: ["node_modules/.cms/sdk/index.ts", "node_modules/.cms/drizzle-schema.ts"],
        migrations: [`.hono-cms/migrations/create_${name}.sql`],
        message: "Smoke generated typed SDK and database schema"
      }, { status: 201 });
    }

    return Response.json({
      collections: {},
      capabilities: {
        writable: true,
        mode: "development",
        endpoints: {
          list: "/cms/content-types",
          create: "/cms/content-types",
          update: "/cms/content-types/{name}"
        }
      }
    });
  };

  globalThis.__honoCmsContentTypeSmoke = { enabled, requests };
  return { enabled, requests };
}

function requestUrl(input: RequestInfo | URL): string | URL {
  if (input instanceof Request) return input.url;
  if (input instanceof URL) return input;
  if (typeof input === "string" && input.startsWith("/")) return new URL(input, globalThis.location.origin).toString();
  return input;
}

function camelCase(value: string): string {
  const words = value.split(/[^A-Za-z0-9]+/).filter(Boolean).map((word) => word.toLowerCase());
  if (!words.length) return "collection";
  return words.map((word, index) => index === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)).join("");
}

declare global {
  var __honoCmsContentTypeSmoke: ContentTypeSmokeHarness | undefined;
}
