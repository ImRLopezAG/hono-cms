# API Reference

This reference summarizes the API surface currently implemented by the CMS runtime. The exact collection schemas are generated from the active `defineSchema` configuration, and the canonical machine-readable contract is available from the configured OpenAPI spec route, usually `/cms/openapi.json`.

## Authentication

Protected endpoints accept bearer credentials:

```http
Authorization: Bearer <token-or-api-key>
```

The core supports static admin tokens, API keys, Better Auth-backed session helpers, collection RBAC, and field-level read/write permissions. Public read access depends on the collection and auth configuration.

## Content API

Collection routes are mounted under `/api/:collection`, where `:collection` is a configured collection name.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/:collection` | List records. |
| `POST` | `/api/:collection` | Create a record. |
| `GET` | `/api/:collection/:id` | Read one record. |
| `PUT` | `/api/:collection/:id` | Update one record. |
| `DELETE` | `/api/:collection/:id` | Delete one record. |

Common list/read query parameters include:

| Parameter | Purpose |
| --- | --- |
| `filters` | Field and relation filters. Nested relation filters are supported. |
| `sort` | Sort fields and directions. |
| `cursor` | Cursor pagination. |
| `pagination` | Page/page-size style pagination. |
| `populate` | Relation and media population. |
| `fields` | Projection for selected output fields. |
| `locale` | Locale selection for localized content. |
| `fallback` | Locale fallback behavior. |
| `status` | Draft/published state filtering where supported. |

Draft and publish collections expose:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/:collection/:id/publish` | Publish a draft. |
| `POST` | `/api/:collection/:id/unpublish` | Move published content back to draft state. |
| `POST` | `/api/:collection/:id/schedule` | Schedule a future publish. |
| `POST` | `/api/:collection/:id/unschedule` | Remove a scheduled publish. |

i18n-enabled collections expose:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/:collection/:id/locales` | List locale variants for a record. |
| `PUT` | `/api/:collection/:id/locales/:locale` | Upsert a locale variant. |
| `POST` | `/api/:collection/:id/translate` | Start or run translation for a record. |

Preview tokens:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/preview-tokens` | Create a preview token. |
| `DELETE` | `/api/preview-tokens/:token` | Revoke a preview token. |

## Media API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/media` | List media assets. |
| `POST` | `/api/media` | Upload media directly. |
| `POST` | `/api/media/presign` | Create a presigned upload target. |
| `POST` | `/api/media/confirm` | Confirm a presigned upload. |
| `GET` | `/api/media/:id` | Read media metadata. |
| `GET` | `/api/media/:id/file` | Read the stored media file. |
| `DELETE` | `/api/media/:id` | Delete media when not referenced by content. |

Storage keys are validated by shared adapter logic. Active content types such as SVG, HTML, XML, and JavaScript are denied by default unless `media.allowActiveContent` is explicitly enabled.

## Schema And Content-Type API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/cms/schema` | Read the active CMS schema summary. |
| `GET` | `/cms/content-types/capabilities` | Read content-type builder capabilities. |
| `GET` | `/cms/content-types` | List configured content types. |
| `POST` | `/cms/content-types` | Create a content type through a configured schema writer. |
| `PUT` | `/cms/content-types/:name` | Update a content type through a configured schema writer. |

Content-type writes validate field definitions before source generation. The current checks include empty field maps, invalid field names, invalid numeric/string ranges, duplicate enum values, missing relation targets, invalid relation inverses, invalid UID target fields, and malformed options.

When a schema writer is configured, successful writes can return generated source, generated artifact summaries, migration information, and UI-ready summaries for the admin Content-Type Builder.

## GraphQL API

GraphQL is mounted at the configured GraphQL path. The runtime supports:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `<graphqlSchemaPath>` | Return generated SDL as plain text. |
| `GET` | `<graphqlPath>` | Execute a GraphQL query from the URL. |
| `POST` | `<graphqlPath>` | Execute a GraphQL request body. |

The generated GraphQL API includes collection queries and mutations, relation population, relation filters, and private-field exclusion.

## OpenAPI And Docs

When OpenAPI is configured:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `<openapi.path>` | Return the generated OpenAPI document. |
| `OPTIONS` | `<openapi.path>` | CORS preflight for the spec route. |
| `GET` | `<openapi.docs>` | Serve hosted API docs. |
| `OPTIONS` | `<openapi.docs>` | CORS preflight for the docs route. |

The generated spec includes schemas for configured collections plus CMS/admin surfaces such as media, jobs, webhooks, API keys, organizations, health, and content-type management.

## Admin Settings API

Audit log:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/cms/audit-log` | List audit log events. |

Webhooks:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/cms/settings/webhooks` | List webhook targets. |
| `POST` | `/cms/settings/webhooks` | Create a webhook target. |
| `PUT` | `/cms/settings/webhooks/:id` | Update a webhook target. |
| `DELETE` | `/cms/settings/webhooks/:id` | Delete a webhook target. |
| `GET` | `/cms/settings/webhooks/:id/deliveries` | List deliveries for a webhook target. |
| `POST` | `/cms/settings/webhooks/:id/deliveries/:deliveryId/retry` | Retry a delivery. |
| `POST` | `/cms/settings/webhooks/:id/test` | Send a test webhook. |

API keys:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/cms/settings/api-keys` | List API keys. |
| `POST` | `/cms/settings/api-keys` | Create an API key. |
| `DELETE` | `/cms/settings/api-keys/:id` | Delete an API key. |

Organization:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/cms/settings/organization` | Read organization settings. |
| `PUT` | `/cms/settings/organization` | Update organization settings. |
| `GET` | `/cms/settings/organization/members` | List members. |
| `DELETE` | `/cms/settings/organization/members/:id` | Remove a member. |
| `GET` | `/cms/settings/organization/invitations` | List invitations. |
| `POST` | `/cms/settings/organization/invitations` | Create an invitation. |
| `POST` | `/cms/settings/organization/invitations/:id/revoke` | Revoke an invitation. |

i18n admin:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/cms/admin/i18n/backfill` | Start locale backfill work. |
| `GET` | `/cms/admin/i18n/backfill/status` | Read backfill status. |

## Jobs API

Configured jobs expose Hono routes for scheduler integrations. Production QStash configuration fails fast unless required URL, token/client, and signing verification settings are present, unless explicitly configured for local skip/development.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET`, `POST` | `/cms/jobs/scheduled-publish` | Run scheduled publish work. |
| `GET`, `POST` | `/cms/jobs/audit-log-cleanup` | Run audit cleanup work. |
| `GET`, `POST` | `/cms/jobs/cache-sweep` | Run cache sweep work. |
| `POST` | `/cms/jobs/webhook-retry` | Run webhook retry work. |
| `POST` | `/cms/jobs/translation` | Run translation work. |

## Health API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/cms/health/live` | Lightweight liveness check. |
| `GET` | `/cms/health` | Aggregate health check. |
| `GET` | `/cms/health/ready` | Readiness check for dependencies. |

## Generated Clients

Use the CLI to generate and check client contracts:

```sh
bun packages/cli/src/index.ts schema generate --schema src/schema.ts --out src/generated/sdk.ts
bun packages/cli/src/index.ts schema check-sdk --schema src/schema.ts --out src/generated/sdk.ts
bun packages/cli/src/index.ts schema openapi --schema src/schema.ts --out src/generated/openapi.json
bun packages/cli/src/index.ts schema check-openapi --schema src/schema.ts --out src/generated/openapi.json
```

The generated TypeScript SDK is the preferred typed client for application code. The OpenAPI output is the preferred integration contract for non-TypeScript clients and external tooling.
