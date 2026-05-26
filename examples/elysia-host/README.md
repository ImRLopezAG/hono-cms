# ElysiaJS Host Example

Demonstrates hosting `createCMS` as a child route inside an [ElysiaJS](https://elysiajs.com) application running on Bun.

The Elysia app owns the root (`GET /`) and forwards everything under `/api/cms/*` to the CMS. A small `stripPrefix` helper rewrites the URL pathname before invoking `cms.fetch`, so the CMS still sees its canonical `/cms/...` and `/api/...` paths.

## Run it

```sh
cd examples/elysia-host
bun src/index.ts
```

The host listens on `http://127.0.0.1:8792`.

## Try it

```sh
# Elysia-owned route (not the CMS)
curl http://127.0.0.1:8792/

# CMS health behind the /api/cms prefix
curl http://127.0.0.1:8792/api/cms/cms/health/live

# CMS schema introspection
curl http://127.0.0.1:8792/api/cms/cms/schema

# Create a draft post (admin token)
curl -X POST http://127.0.0.1:8792/api/cms/api/posts \
  -H "authorization: Bearer admin" \
  -H "content-type: application/json" \
  -d '{"title":"Elysia post","slug":"elysia-post"}'

# Publish the draft
curl -X POST http://127.0.0.1:8792/api/cms/api/posts/<id>/publish \
  -H "authorization: Bearer admin"
```

## Tokens

The example wires two memory tokens:

- `admin` — full admin role (`Bearer admin`)
- `editor` — editor role (`Bearer editor`)

Public reads are enabled, so unauthenticated `GET` requests against published content succeed.

## Tests

```sh
bun run --filter @hono-cms/example-elysia-host test
```

The vitest suite boots Elysia on an ephemeral port (`listen(0)`) and exercises the host with real HTTP fetches.
