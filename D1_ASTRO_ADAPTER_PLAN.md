# Plan: D1 Backend Service Support for `@astrojs/cloudflare`

## Summary

Build D1 support as an opt-in backend service mode in the existing `@astrojs/cloudflare` adapter. The front Worker keeps serving static assets and routing requests. Dynamic Astro rendering that needs SQL runs inside a SQLite-backed Durable Object, where `Astro.locals.d1` is backed by `ctx.storage.sql`.

Use the current Durable Objects Wrangler configuration model for the implementation:

```jsonc
{
  "main": "@astrojs/cloudflare/entrypoints/server",
  "durable_objects": {
    "bindings": [{ "name": "AstroD1Backend", "class_name": "AstroD1Backend" }],
  },
  "migrations": [{ "tag": "astro-d1-v1", "new_sqlite_classes": ["AstroD1Backend"] }],
}
```

Do not use the forward-looking D1 docs branch `exports` syntax for this build.

## Research Inputs

- Local D1 docs branch: `/Users/brendan/src/cloudflare-docs`, branch `d1-durable-object-application-docs`.
- D1 Astro page: `/Users/brendan/src/cloudflare-docs/src/content/docs/d1/frameworks/astro.mdx`.
- D1 adapter guidance: `/Users/brendan/src/cloudflare-docs/src/content/docs/d1/reference/community-projects.mdx`.
- D1 architecture: `/Users/brendan/src/cloudflare-docs/src/content/docs/d1/reference/architecture.mdx`.
- D1 read replication: `/Users/brendan/src/cloudflare-docs/src/content/docs/d1/best-practices/read-replication.mdx`.
- D1 migrations: `/Users/brendan/src/cloudflare-docs/src/content/docs/d1/reference/migrations.mdx`.
- Current Cloudflare adapter package: `/Users/brendan/src/astro/packages/integrations/cloudflare`.
- Current adapter runtime entrypoint: `packages/integrations/cloudflare/src/entrypoints/server.ts`.
- Current adapter request handler: `packages/integrations/cloudflare/src/utils/handler.ts`.
- Current adapter Wrangler customizer: `packages/integrations/cloudflare/src/wrangler.ts`.
- Current adapter locals helper: `packages/integrations/cloudflare/src/utils/cf-helpers.ts`.
- Current public Durable Objects docs still use `durable_objects.bindings` and `migrations.new_sqlite_classes`.

## Product Shape

### User-facing Astro config

Start with an opt-in adapter option. Keep the public shape close to the D1 docs, but map it to current Durable Objects config.

```js
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    d1: {
      backendService: {
        bindingName: 'AstroD1Backend',
        className: 'AstroD1Backend',
        objectName: ({ request }) => `site:${new URL(request.url).hostname}`,
        readReplication: { mode: 'auto' },
        primaryOnlyRoutes: ['/admin/**'],
      },
    },
  }),
});
```

Recommended MVP constraints:

- Default `bindingName` to `AstroD1Backend`.
- Default `className` to `AstroD1Backend`.
- Require `bindingName` and `className` to be valid JavaScript identifiers.
- Keep `className` fixed to `AstroD1Backend` for the first implementation unless a generated entrypoint spike proves arbitrary class names are safe in dev, build, preview, and deploy.
- Treat `objectName` as a runtime-safe pure function. It must not close over Node-only values.
- Do not implicitly route every request through D1. Static assets and prerendered assets stay in the front Worker.
- Treat `primaryOnlyRoutes` as an optimization for known write-heavy routes, not as the only correctness mechanism for `GET` routes that write.

### User-facing application API

Server-rendered pages and endpoints use `Astro.locals.d1` or `locals.d1`:

```astro
---
export const prerender = false;

const posts = await Astro.locals.d1.query('SELECT id, title FROM posts ORDER BY id DESC LIMIT 10');
---

<ul>{posts.map((post) => <li>{post.title}</li>)}</ul>
```

Initial client API:

```ts
export interface AstroD1Client {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | null;
}
```

Keep the first client intentionally small. ORM integration, raw cursors, migration helpers, and transaction helpers can be added after the request-routing model is proven.

## Architecture

### Request flow

1. Front Worker receives the request through `@astrojs/cloudflare/entrypoints/server`.
2. Front Worker serves known static assets from `env.ASSETS` without touching D1.
3. Front Worker uses Astro route matching to decide whether a route exists.
4. Front Worker computes an object name with the configured `objectName({ request })` function.
5. Front Worker gets a Durable Object stub from `env[bindingName].getByName(name, options)`.
6. Front Worker sets `{ routingMode: "primary-only" }` for known writes.
7. Durable Object receives the request and renders Astro inside the object.
8. Durable Object injects `locals.d1`, reads any incoming `x-d1-bookmark`, and returns a new `x-d1-bookmark` header.

### Front Worker responsibilities

- Serve static assets with `matchStaticAsset()` and `fallbackToAssets()`.
- Avoid SQL and avoid creating D1 clients.
- Choose the D1 object name from request data.
- Route known writes primary-only to avoid an extra replica hop.
- Preserve existing Cloudflare adapter behavior when D1 mode is disabled.

### Durable Object responsibilities

- Export a SQLite-backed Durable Object class.
- Optionally configure read replication from the primary object.
- Forward known write requests to `ctx.primaryStub` when a write reaches a replica.
- Wait for incoming bookmarks before rendering when the request has `x-d1-bookmark`.
- Render the Astro app inside the object.
- Inject `locals.d1` backed by `ctx.storage.sql`.
- Consume SQL cursors synchronously before any `await`.
- Detect mutation SQL on replicas and reroute the original request to the primary before executing the mutation.
- Return the current bookmark after rendering.

## Current Durable Objects Config Strategy

Use current stable Wrangler fields:

```jsonc
{
  "durable_objects": {
    "bindings": [
      {
        "name": "AstroD1Backend",
        "class_name": "AstroD1Backend",
      },
    ],
  },
  "migrations": [
    {
      "tag": "astro-d1-v1",
      "new_sqlite_classes": ["AstroD1Backend"],
    },
  ],
}
```

Implementation notes:

- Extend `packages/integrations/cloudflare/src/wrangler.ts`.
- Add only missing Durable Object bindings, following the existing KV and Images pattern.
- Add a SQLite class migration only when safe.
- If user migrations already exist, verify merge behavior before auto-appending a new migration entry.
- If merge behavior is unsafe, require users with existing migrations to add the D1 migration manually and log a clear adapter warning.
- Do not generate or document `[exports.AstroD1Backend]` for this implementation.

## Implementation Plan

### Phase 0: Spike the hard platform seams

Verify these before implementing the full runtime:

- `@cloudflare/vite-plugin` emits and runs current `durable_objects.bindings` plus `migrations.new_sqlite_classes` from an adapter config customizer.
- A Durable Object class exported from `@astrojs/cloudflare/entrypoints/server` is included in the built Worker and visible to Wrangler.
- The generated Worker works in `astro dev`, `astro build`, and `astro preview`.
- `defu` merge behavior in the Cloudflare Vite plugin does not corrupt user `migrations` arrays.
- `ctx.primaryStub`, `ctx.configureReadReplication()`, `ctx.storage.waitForBookmark()`, and `ctx.storage.getCurrentBookmark()` are present in the target `@cloudflare/workers-types` and runtime.
- Requests forwarded through a Durable Object preserve the data Astro users expect, especially URL, headers, cookies, method, body, and ideally `request.cf`.

Success criteria:

- A minimal fixture exports a DO class from the adapter entrypoint and can call `ctx.storage.sql.exec()` locally.
- Generated Wrangler config contains current DO binding and SQLite migration fields.

### Phase 1: Add config and generated runtime config

Files:

- `packages/integrations/cloudflare/src/index.ts`
- `packages/integrations/cloudflare/src/vite-plugin-config.ts`
- `packages/integrations/cloudflare/virtual.d.ts`

Tasks:

- Add `Options.d1?.backendService` types.
- Normalize defaults for `bindingName`, `className`, `readReplication`, and `primaryOnlyRoutes`.
- Validate identifier-like names early in `astro:config:setup`.
- Pass normalized D1 config into `createConfigPlugin()`.
- Generate runtime config in `virtual:astro-cloudflare:config`.
- Decide final `objectName` representation.

Recommended `objectName` approach for MVP:

- Support inline function serialization only if it is a plain function or arrow function.
- Document that it must be pure and closure-free.
- Add a follow-up option for module-based object naming if function serialization proves brittle.

Safer later API:

```js
backendService: {
  objectNameModule: "./src/d1-object-name.ts",
}
```

This avoids serializing closures from `astro.config.mjs`, but it is a larger API decision and should not block an MVP if the docs expect inline functions.

### Phase 2: Refactor Cloudflare request handling into reusable pieces

Files:

- `packages/integrations/cloudflare/src/utils/handler.ts`
- `packages/integrations/cloudflare/src/utils/cf-helpers.ts`
- Potential new file: `packages/integrations/cloudflare/src/utils/render.ts`

Tasks:

- Extract an internal `renderAstroRequest()` helper from `handle()` so both normal Worker mode and D1 Durable Object mode can render consistently.
- Keep existing `handle(request, env, context)` behavior unchanged when D1 is disabled.
- Extend `createLocals()` to accept optional additions, but do not make `d1` globally available for non-D1 projects.
- Preserve current cookie handling via `app.setCookieHeaders(response)`.
- Preserve existing asset matching, error page fetch, `waitUntil`, and client address behavior where possible.

Important constraint:

- Preserve `Astro.locals.cfContext` for D1-rendered routes with a compatibility object. It should support the user-facing APIs Astro users expect, especially `waitUntil()` and `exports`, while documenting any methods whose Durable Object semantics differ from the front Worker `ExecutionContext`.

### Phase 3: Implement D1 runtime helpers

Potential new file:

- `packages/integrations/cloudflare/src/utils/d1.ts`

Helpers:

- `createAstroD1Client(ctx: DurableObjectState): AstroD1Client`
- `isKnownWriteRequest(request: Request, primaryOnlyRoutes: string[]): boolean`
- `isMutationSql(sql: string): boolean`
- `createPrimaryRerouteSignal(request: Request): Error`
- `cloneWithBookmark(response: Response, bookmark: string): Response`
- `getD1Namespace(env: Env, bindingName: string): DurableObjectNamespace`
- `matchPrimaryOnlyRoute(pathname: string, patterns: string[]): boolean`

D1 client MVP:

```ts
export function createAstroD1Client(ctx: DurableObjectState): AstroD1Client {
  return {
    query<T>(sql: string, params: unknown[] = []): T[] {
      return ctx.storage.sql.exec<T>(sql, ...params).toArray();
    },
    queryOne<T>(sql: string, params: unknown[] = []): T | null {
      return ctx.storage.sql.exec<T>(sql, ...params).toArray()[0] ?? null;
    },
  };
}
```

Write classification MVP:

- Treat every non-`GET` and non-`HEAD` request as a known write at the front Worker.
- Treat configured `primaryOnlyRoutes` as known writes, including `GET` requests.
- Astro actions are covered because RPC and form actions use `POST`.
- Do not attempt to infer endpoint method exports from route metadata in MVP. `IntegrationResolvedRoute` does not currently expose method-level write intent.
- `GET` routes that write are allowed. If they are not listed in `primaryOnlyRoutes`, they may first reach a replica and then be rerouted to the primary by the D1 client.

Replica safety:

- In the Durable Object `fetch()`, if `ctx.primaryStub` exists and `isKnownWriteRequest()` is true, forward to `ctx.primaryStub.fetch(request)` before rendering.
- If rendering begins on a replica and `locals.d1` sees mutation SQL, do not execute it locally. Throw an internal reroute signal that carries the original request.
- The Durable Object `fetch()` catches the reroute signal and forwards the original request to `ctx.primaryStub.fetch(request)`.
- The primary re-renders the route and executes the mutation.
- `primaryOnlyRoutes` remains useful for known write-heavy `GET` routes because it avoids the extra replica hop and full rerender.
- Document the replay caveat: if a route performs non-idempotent side effects before its first SQL mutation, a replica reroute will replay those effects on the primary. Users can avoid this by marking the route primary-only or moving side effects after D1 mutation intent is known.

### Phase 4: Add the Durable Object and D1 front dispatch

Files:

- `packages/integrations/cloudflare/src/entrypoints/server.ts`
- Potential new file: `packages/integrations/cloudflare/src/entrypoints/d1.ts`

MVP entrypoint shape:

```ts
export class AstroD1Backend extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    ctx.blockConcurrencyWhile(async () => {
      if (!ctx.primaryStub && d1BackendService?.readReplication) {
        await ctx.configureReadReplication(d1BackendService.readReplication);
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    // Render Astro inside the object with locals.d1.
  }
}

export default {
  async fetch(request, env, ctx) {
    if (!d1BackendService) {
      return handle(request, env, ctx);
    }

    return handleD1FrontRequest(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
```

Reason for a fixed class in MVP:

- Current Wrangler config needs a concrete exported class name.
- A package entrypoint cannot easily export an arbitrary user-configured class name without generated entrypoint code.
- A fixed `AstroD1Backend` keeps dev, preview, and deployment simpler.
- If arbitrary `className` is required later, generate a virtual or physical entrypoint and point Wrangler `main` at it after proving that path works in `@cloudflare/vite-plugin`.

### Phase 5: Extend Wrangler config generation

File:

- `packages/integrations/cloudflare/src/wrangler.ts`

Tasks:

- Add D1 backend options to `CloudflareConfigOptions`.
- Detect existing `durable_objects.bindings` by binding `name` and `class_name`.
- Return only missing generated bindings, not the user's existing bindings.
- Add top-level current SQLite migration when safe.
- Add unit tests for all merge cases.

Test cases:

- Adds default DO binding when D1 backend is enabled.
- Does not add DO binding when user already declared the binding.
- Does not echo unrelated user DO bindings.
- Adds `new_sqlite_classes` migration when no user migrations exist.
- Handles existing migrations without duplication.
- Does not add any DO config when D1 backend is disabled.
- Keeps current KV, Images, Assets behavior unchanged.

### Phase 6: Types

Files:

- `packages/integrations/cloudflare/src/index.ts`
- `packages/integrations/cloudflare/types.d.ts`
- `packages/integrations/cloudflare/virtual.d.ts`

Tasks:

- Export `AstroD1Client` from the package.
- Conditionally inject a D1-specific type declaration when `d1.backendService` is enabled.
- Avoid making `App.Locals.d1` required for all Cloudflare adapter users.

Preferred type injection when enabled:

```ts
declare namespace App {
  interface Locals {
    d1: import('@astrojs/cloudflare').AstroD1Client;
  }
}
```

### Phase 7: Tests and fixtures

Unit tests:

- `packages/integrations/cloudflare/test/wrangler.test.ts`
- `packages/integrations/cloudflare/test/cf-helpers.test.ts`
- New D1 helper tests for write classification, object route matching, and client behavior.

Integration fixtures:

- New fixture: `packages/integrations/cloudflare/test/fixtures/d1-backend-service/`.
- `astro.config.mjs` enables `cloudflare({ d1: { backendService: ... } })`.
- `src/pages/index.astro` reads from `Astro.locals.d1`.
- `src/pages/api/posts.ts` writes via `locals.d1`.
- Static asset page verifies `ASSETS` path still works.
- Optional route under `/admin` verifies `primaryOnlyRoutes` avoids the replica path.
- A `GET` route that writes without `primaryOnlyRoutes` verifies replica-to-primary rerouting.
- A D1-rendered route verifies `Astro.locals.cfContext` is still available.

Integration tests:

- Build output contains current DO binding and SQLite migration config.
- `astro dev` can render a page using `Astro.locals.d1`.
- `astro preview` can render a page using `Astro.locals.d1`.
- Static assets are served without entering the Durable Object. Add a diagnostic header or counter only in the fixture if needed.
- POST endpoint writes and returns data.
- Response includes `x-d1-bookmark` after D1 rendering.
- Mutation SQL discovered on a replica forwards the original request to the primary.
- Existing `astro-dev-platform` legacy `d1_databases` binding tests still pass.

Commands:

```sh
pnpm -C packages/integrations/cloudflare run build
pnpm -C packages/integrations/cloudflare exec astro-scripts test "test/wrangler.test.ts"
pnpm -C packages/integrations/cloudflare exec astro-scripts test "test/cf-helpers.test.ts"
pnpm -C packages/integrations/cloudflare exec astro-scripts test "test/d1-backend-service.test.ts"
```

### Phase 8: Documentation updates

Docs to update after implementation:

- Astro Cloudflare integration docs.
- D1 Astro docs in `/Users/brendan/src/cloudflare-docs/src/content/docs/d1/frameworks/astro.mdx`.

Required doc correction:

- Replace the D1 branch `exports` Wrangler example with current `durable_objects.bindings` plus `migrations.new_sqlite_classes` for this adapter work.

Example current config for docs:

```toml
name = "astro-d1-app"
main = "@astrojs/cloudflare/entrypoints/server"
compatibility_date = "2026-06-12"

[assets]
directory = "./dist"
binding = "ASSETS"

[[durable_objects.bindings]]
name = "AstroD1Backend"
class_name = "AstroD1Backend"

[[migrations]]
tag = "astro-d1-v1"
new_sqlite_classes = ["AstroD1Backend"]
```

## Non-goals for MVP

- No old `d1_databases` binding abstraction.
- No automatic SQL migration runner.
- No Drizzle or Kysely adapter.
- No arbitrary generated Durable Object class names unless the Phase 0 spike proves it is safe.
- No route-source static analysis to infer whether a `GET` route writes. Unknown writes are handled at runtime by replica-to-primary rerouting.
- No custom entrypoint automation. Users with custom `main` need a documented helper path or must export the DO class themselves.
- No external REST or Wrangler command for querying application-object D1 databases.

## Risks and Decisions

### Object name function serialization

Risk: `objectName` is supplied in `astro.config.mjs`, but runtime code runs in workerd. Serializing arbitrary functions can break if they close over config-time variables or Node APIs.

Decision for MVP: support pure inline functions with clear docs and tests. Revisit a module-based API if this proves fragile.

### Fixed class name versus configured class name

Risk: Current Durable Objects config requires a class exported by the Worker. Supporting arbitrary class names likely requires generated entrypoint code.

Decision for MVP: use fixed `AstroD1Backend`. Treat arbitrary class names as a later enhancement.

### Existing user migrations

Risk: Wrangler migrations are ordered and persistent. Incorrect auto-merge could corrupt deployment config.

Decision for MVP: only auto-add migrations after verifying merge behavior. Otherwise warn and require manual migration config.

### `cfContext` inside the Durable Object

Risk: Astro Cloudflare currently exposes `Astro.locals.cfContext` as the front Worker `ExecutionContext`. D1-rendered routes execute inside a Durable Object, so the adapter must preserve the user-facing `cfContext` API without assuming the original front Worker object is still in scope.

Decision for MVP: expose `Astro.locals.cfContext` in D1-rendered routes through a compatibility object backed by the Durable Object context/state. Support `waitUntil()` and `exports`; document any semantic differences from the front Worker `ExecutionContext`.

### Write discovery in `GET` routes

Risk: The front Worker cannot know whether a `GET` route will write before rendering starts. Routing every `GET` to the primary would lose read-replica benefits.

Decision for MVP: let `GET` routes render on replicas by default. If `locals.d1` detects mutation SQL on a replica, reroute the original request to the primary and re-render there. Keep `primaryOnlyRoutes` as an optional way to skip the replica hop for known write routes.

### Read replication API availability

Risk: D1 branch docs use `ctx.primaryStub`, `ctx.configureReadReplication()`, `routingMode: "primary-only"`, and bookmark APIs. Public Durable Objects docs may lag these APIs.

Decision for MVP: gate read replication behavior behind the explicit `readReplication` option and verify runtime/types before shipping.

## Definition of Done

- An Astro app can enable D1 backend service mode through `@astrojs/cloudflare`.
- Generated Wrangler config uses current `durable_objects.bindings` and `migrations.new_sqlite_classes`.
- Static assets are served from the front Worker without entering the Durable Object.
- Dynamic Astro pages and endpoints can call `Astro.locals.d1.query()` and `locals.d1.queryOne()` inside the Durable Object.
- Non-GET requests route primary-only from the front Worker.
- `GET` routes that write are supported through replica-to-primary rerouting.
- `primaryOnlyRoutes` avoids the extra replica hop for known write routes.
- `Astro.locals.cfContext` is available in D1-rendered routes.
- Bookmark headers are accepted and returned.
- Existing Cloudflare adapter behavior is unchanged when D1 mode is disabled.
- Unit and integration tests cover config generation, runtime routing, locals injection, and basic SQL reads/writes.
