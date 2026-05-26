# Newsroom Example

This example is a real content app wired against the CMS packages. It uses a typed schema, a committed generated SDK, and the same Web `Request`/`Response` flow across direct fetch, Node HTTP, Cloudflare Workers, and Vercel-style handlers.

## Production Stores

The default `createNewsroomCMS` in `src/app.ts` uses in-memory stores so the quickstart and tests stay hermetic. For a production-style configuration, `src/production.ts` exposes an optional factory that wires Drizzle-backed audit + translation stores and an AI translation provider:

```ts
import { createProductionNewsroomCMS } from "./production";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";

const db = drizzle(new Database("./newsroom.db"));
const cms = createProductionNewsroomCMS({
  db,
  dialect: "sqlite",
  aiProvider: { type: "anthropic", apiKey: process.env.ANTHROPIC_API_KEY! }
});
```

`aiProvider` is optional — omit it to run with Drizzle stores but no automatic translation. `better-sqlite3` (or `pg` for Postgres) is **not** a dependency of this example; install the driver that matches your deployment. The `audit_log` and `locale_variants` tables must already exist on the underlying database — run the migrations emitted by `@hono-cms/schema`'s Drizzle generator before booting the CMS.

## Commands

```sh
bun run generate:sdk
bun run check:sdk
bun run typecheck
bun run test
```

`check:sdk` fails when `src/generated/sdk.ts` drifts from `src/schema.ts`, so consumers get a stable generated contract in version control.

## Entrypoints

- `src/app.ts` creates the CMS and exposes the direct Web Request handler.
- `src/node-server.ts` runs the same CMS through the Node platform adapter.
- `src/edge.ts` exports Cloudflare Worker and Vercel-style handlers.
- `src/consumer.ts` is a generated-SDK consumer that creates, publishes, filters, paginates, and populates content.
- `src/production.ts` is the optional production-style factory that wires Drizzle audit + translation stores and an AI translation provider.
