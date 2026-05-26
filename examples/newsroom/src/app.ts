import { createCMS, type CMSConfig, type SchemaWriter } from "@hono-cms/core";
import { createMemoryDatabase } from "@hono-cms/adapter-memory";
import { createFetchHandler } from "@hono-cms/platform";
import "@hono-cms/jobs";
import { newsroomSchema } from "./schema";

export type NewsroomCMSOptions = {
  jobs?: CMSConfig<typeof newsroomSchema>["jobs"];
  /**
   * Optional content-type builder writer. When provided, the Content-Type
   * Builder routes become writable (Strapi-style). Callers using
   * `createNewsroomCMS()` with no options keep the default read-only behavior.
   */
  schemaWriter?: SchemaWriter;
};

export function createNewsroomCMS(options: NewsroomCMSOptions = {}) {
  return createCMS({
    collections: newsroomSchema,
    db: createMemoryDatabase({ provider: "memory", collections: newsroomSchema }),
    ...(options.jobs ? { jobs: options.jobs } : {}),
    ...(options.schemaWriter ? { contentTypeBuilder: { writer: options.schemaWriter } } : {}),
    auth: {
      tokens: {
        admin: { userId: "admin_1", roles: ["admin"] },
        editor: { userId: "editor_1", roles: ["editor"] }
      }
    },
    rbac: { publicRead: true },
    openapi: {
      path: "/cms/openapi.json",
      docs: "/cms/docs",
      title: "Newsroom CMS API",
      version: "0.1.0",
      description: "Example newsroom API built with Hono CMS.",
      servers: [{ url: "https://newsroom.example.com", description: "Production" }]
    }
  });
}

export const cms = createNewsroomCMS();
export const fetchHandler = createFetchHandler(cms);
