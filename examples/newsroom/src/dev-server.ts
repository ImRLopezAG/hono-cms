import { createServer } from "node:http";
import { createCMS, MemoryApiKeyStore, MemoryMediaStore } from "@hono-cms/core";
import { createMemoryDatabase } from "@hono-cms/adapter-memory";
import { createMemoryStorage } from "@hono-cms/storage-memory";
import { createMemoryCache } from "@hono-cms/cache";
import { createNodeHandler } from "@hono-cms/platform/node";
import "@hono-cms/jobs";
import { newsroomSchema } from "./schema";
import { createFileSchemaWriter } from "./schema-writer";

const PORT = Number(process.env.PORT ?? 8787);

const schemaWriter = createFileSchemaWriter({
  baseDir: new URL("../generated-collections/", import.meta.url).pathname
});

const cms = createCMS({
  collections: newsroomSchema,
  db: createMemoryDatabase({ provider: "memory", collections: newsroomSchema }),
  storage: createMemoryStorage({ provider: "memory" }),
  cache: createMemoryCache(),
  mediaStore: new MemoryMediaStore(),
  apiKeyStore: new MemoryApiKeyStore(),
  contentTypeBuilder: { writer: schemaWriter },
  auth: {
    tokens: {
      admin: { userId: "admin_1", roles: ["admin"] },
      editor: { userId: "editor_1", roles: ["editor"] }
    }
  },
  rbac: { publicRead: true },
  cors: {
    origin: true,
    credentials: true,
    allowedHeaders: ["authorization", "content-type", "x-requested-with"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
  },
  openapi: {
    path: "/cms/openapi.json",
    docs: "/cms/docs",
    title: "Newsroom CMS API",
    version: "0.1.0",
    description: "Example newsroom API built with Hono CMS.",
    servers: [{ url: "https://newsroom.example.com", description: "Production" }]
  }
});

const server = createServer(createNodeHandler(cms));

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[newsroom] listening on http://127.0.0.1:${PORT}`);
});

const shutdown = () => {
  console.log("[newsroom] shutting down...");
  server.close(() => process.exit(0));
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
