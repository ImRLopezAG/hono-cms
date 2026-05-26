// OpenAPI content-collection route declarations.
//
// Plan-12 U1 migration: every public content-collection route is declared via
// `@hono/zod-openapi` `createRoute` so the route handler and the OpenAPI path
// entry come from a single declaration. The OpenAPI spec for these paths is
// therefore the source of truth — no separate hand-rolled spec entry can
// silently drift from the implementation.
//
// Scope of this module: the seven core CRUD operations exposed for every
// collection (list, get-by-id, create, update, delete, publish, unpublish).
// Locale/translate/schedule/unschedule routes remain on the legacy
// `app.get/post/...` path and are documented from `openapi.ts` until a
// follow-up migration brings them across.
//
// Auth routes, admin routes (/cms/*), media routes, and GraphQL routes are
// likewise NOT migrated here and continue to be described by the hand-rolled
// spec in `./openapi.ts`. See Plan 012 U4–U6 for the rest of the migration.
//
// Implementation note: the request body / params schemas are deliberately
// permissive (loose objects). Runtime validation continues to be performed by
// the existing route handlers (`collectionToZod`, `parseQueryParams`, etc.).
// The createRoute declarations exist to populate the OpenAPI registry —
// `app.getOpenAPI31Document()` returns these paths as the source of truth
// for the migrated cluster. The served `/cms/openapi.json` continues to be
// assembled from the hand-rolled spec in `./openapi.ts` for backwards
// compatibility; a follow-up unit will swap the served document to the
// registry output (Plan 012 U6).

import { createRoute, z } from "@hono/zod-openapi";
import type { RouteConfig } from "@hono/zod-openapi";
import type { CMSCollections, CollectionDefinition, FieldsDefinition } from "@hono-cms/schema";

type CollectionLike = CollectionDefinition<string, FieldsDefinition>;

function pascalCase(value: string): string {
  return value
    .split(/[-_\s]/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("");
}

// Permissive component-named schemas. We register them with `.openapi(name)`
// so they appear as `$ref: #/components/schemas/<name>` in the spec, matching
// the component names already produced by `generateOpenAPISchemas` in
// `@hono-cms/schema`. The structural definition for each component is owned
// by `generateOpenAPISchemas`; this stub only contributes the name reference.
function namedRef(componentName: string): z.ZodType {
  return z.looseObject({}).openapi(componentName, { type: "object" });
}

function errorRefSchema(): z.ZodType {
  return z
    .object({ error: z.string(), issues: z.array(z.any()).optional() })
    .openapi("Error");
}

function paginatedRefSchema(itemComponentName: string): z.ZodType {
  return z
    .object({
      items: z.array(z.any()),
      nextCursor: z.string().optional(),
      total: z.number().optional()
    })
    .openapi(`${itemComponentName}List`);
}

const idParamSchema = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" }, example: "doc_1" })
});

const bearerSecurity: Array<Record<string, string[]>> = [{ bearerAuth: [] }];

export type CollectionRouteConfigs = {
  list: RouteConfig;
  get: RouteConfig;
  create: RouteConfig;
  update: RouteConfig;
  delete: RouteConfig;
  publish: RouteConfig | null;
  unpublish: RouteConfig | null;
};

export function buildCollectionRouteConfigs(
  collectionName: string,
  collection: CollectionLike
): CollectionRouteConfigs {
  const tag = collectionName;
  const schemaName = pascalCase(collectionName);
  const createSchemaName = `${schemaName}CreateInput`;
  const updateSchemaName = `${schemaName}UpdateInput`;
  const base = `/api/${collectionName}`;

  const recordRef = namedRef(schemaName);
  const createInputRef = namedRef(createSchemaName);
  const updateInputRef = namedRef(updateSchemaName);
  const errorRef = errorRefSchema();
  const paginatedRef = paginatedRefSchema(schemaName);

  const list = createRoute({
    method: "get",
    path: base,
    tags: [tag],
    summary: `List ${collectionName}`,
    operationId: `list${pascalCase(collectionName)}`,
    responses: {
      200: {
        description: "List content records",
        content: { "application/json": { schema: paginatedRef } }
      },
      403: { description: "Forbidden", content: { "application/json": { schema: errorRef } } },
      422: { description: "Validation error", content: { "application/json": { schema: errorRef } } }
    }
  });

  const get = createRoute({
    method: "get",
    path: `${base}/{id}`,
    tags: [tag],
    summary: `Get ${collectionName} record`,
    operationId: `get${pascalCase(collectionName)}ById`,
    request: { params: idParamSchema },
    responses: {
      200: { description: "Get content record", content: { "application/json": { schema: recordRef } } },
      404: { description: "Not found", content: { "application/json": { schema: errorRef } } }
    }
  });

  const create = createRoute({
    method: "post",
    path: base,
    tags: [tag],
    summary: `Create ${collectionName}`,
    operationId: `create${pascalCase(collectionName)}`,
    security: bearerSecurity,
    request: {
      body: { required: true, content: { "application/json": { schema: createInputRef } } }
    },
    responses: {
      201: { description: "Create content record", content: { "application/json": { schema: recordRef } } },
      403: { description: "Forbidden", content: { "application/json": { schema: errorRef } } },
      422: { description: "Validation error", content: { "application/json": { schema: errorRef } } }
    }
  });

  const update = createRoute({
    method: "patch",
    path: `${base}/{id}`,
    tags: [tag],
    summary: `Update ${collectionName} record`,
    operationId: `update${pascalCase(collectionName)}`,
    security: bearerSecurity,
    request: {
      params: idParamSchema,
      body: { required: true, content: { "application/json": { schema: updateInputRef } } }
    },
    responses: {
      200: { description: "Update content record", content: { "application/json": { schema: recordRef } } },
      403: { description: "Forbidden", content: { "application/json": { schema: errorRef } } },
      422: { description: "Validation error", content: { "application/json": { schema: errorRef } } }
    }
  });

  const remove = createRoute({
    method: "delete",
    path: `${base}/{id}`,
    tags: [tag],
    summary: `Delete ${collectionName} record`,
    operationId: `delete${pascalCase(collectionName)}`,
    security: bearerSecurity,
    request: { params: idParamSchema },
    responses: {
      204: { description: "Delete content record" },
      403: { description: "Forbidden", content: { "application/json": { schema: errorRef } } },
      409: { description: "Relation constraint", content: { "application/json": { schema: errorRef } } }
    }
  });

  let publish: RouteConfig | null = null;
  let unpublish: RouteConfig | null = null;
  if (collection.options.draftAndPublish) {
    publish = createRoute({
      method: "post",
      path: `${base}/{id}/publish`,
      tags: [tag],
      summary: `Publish ${collectionName} record`,
      operationId: `publish${pascalCase(collectionName)}`,
      security: bearerSecurity,
      request: { params: idParamSchema },
      responses: {
        200: { description: "Publish content record", content: { "application/json": { schema: recordRef } } },
        403: { description: "Forbidden", content: { "application/json": { schema: errorRef } } },
        404: { description: "Not found", content: { "application/json": { schema: errorRef } } }
      }
    });

    unpublish = createRoute({
      method: "post",
      path: `${base}/{id}/unpublish`,
      tags: [tag],
      summary: `Unpublish ${collectionName} record`,
      operationId: `unpublish${pascalCase(collectionName)}`,
      security: bearerSecurity,
      request: { params: idParamSchema },
      responses: {
        200: { description: "Unpublish content record", content: { "application/json": { schema: recordRef } } },
        403: { description: "Forbidden", content: { "application/json": { schema: errorRef } } },
        404: { description: "Not found", content: { "application/json": { schema: errorRef } } }
      }
    });
  }

  return { list, get, create, update, delete: remove, publish, unpublish };
}

// Returns the set of OpenAPI-style path strings (with `{id}` placeholders)
// that have been migrated to `createRoute`. The merge layer in
// `./openapi.ts` reads this list to know which hand-rolled path entries
// should be replaced by registry-derived entries once the served spec is
// fully driven by `app.getOpenAPI31Document()` (Plan 012 U6).
export function migratedContentRoutePaths(collections: CMSCollections): Set<string> {
  const paths = new Set<string>();
  for (const collection of Object.values(collections)) {
    const base = `/api/${collection.name}`;
    paths.add(base);
    paths.add(`${base}/{id}`);
    if (collection.options.draftAndPublish) {
      paths.add(`${base}/{id}/publish`);
      paths.add(`${base}/{id}/unpublish`);
    }
  }
  return paths;
}
