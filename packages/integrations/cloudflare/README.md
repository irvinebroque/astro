# @astrojs/cloudflare

An SSR adapter for use with Cloudflare Workers targets. Write your code in Astro/JavaScript and deploy to Cloudflare Workers.

## Documentation

Read the [`@astrojs/cloudflare` docs][docs]

## D1 backend service

The Cloudflare adapter can run server-rendered Astro routes inside a SQLite-backed Durable Object. This lets pages and endpoints use D1 through `Astro.locals.d1` or `locals.d1` while static assets stay in the front Worker.

```js
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    d1: {
      backendService: {
        objectName: ({ request }) => `site:${new URL(request.url).hostname}`,
        readReplication: { mode: 'auto' },
        primaryOnlyRoutes: ['/admin/**'],
      },
    },
  }),
});
```

The generated Durable Object uses the current Wrangler configuration shape:

```jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "AstroD1Backend", "class_name": "AstroD1Backend" }],
  },
  "migrations": [{ "tag": "astro-d1-v1", "new_sqlite_classes": ["AstroD1Backend"] }],
}
```

Use `Astro.locals.d1` in server-rendered pages:

```astro
---
export const prerender = false;

const posts = await Astro.locals.d1.query('SELECT id, title FROM posts ORDER BY id DESC LIMIT 10');
---

<ul>{posts.map((post) => <li>{post.title}</li>)}</ul>
```

Use `locals.d1` in endpoints:

```ts
export async function POST({ request, locals }) {
  const input = await request.json();

  const post = await locals.d1.queryOne(
    'INSERT INTO posts (title) VALUES (?) RETURNING id, title',
    [input.title],
  );

  return Response.json(post, { status: 201 });
}
```

Notes:

- `objectName()` defines the logical database boundary and must return a non-empty string.
- The generated binding and class name are `AstroD1Backend`.
- `primaryOnlyRoutes` avoids an extra replica hop for known write-heavy routes.
- Writes discovered on replicas are rerouted to the primary before SQL runs.
- `Astro.locals.cfContext` remains available in D1-rendered routes.
- Custom Worker entrypoints must re-export `AstroD1Backend` from `@astrojs/cloudflare/entrypoints/server`.

## Support

- Get help in the [Astro Discord][discord]. Post questions in our `#support` forum, or visit our dedicated `#dev` channel to discuss current development and more!

- Check our [Astro Integration Documentation][astro-integration] for more on integrations.

- Submit bug reports and feature requests as [GitHub issues][issues].

## Contributing

This package is maintained by Astro's Core team. You're welcome to submit an issue or PR! These links will help you get started:

- [Contributor Manual][contributing]
- [Code of Conduct][coc]
- [Community Guide][community]

## License

MIT

Copyright (c) 2023–present [Astro][astro]

[astro]: https://astro.build/
[docs]: https://docs.astro.build/en/guides/integrations-guide/cloudflare/
[contributing]: https://github.com/withastro/astro/blob/main/CONTRIBUTING.md
[coc]: https://github.com/withastro/.github/blob/main/CODE_OF_CONDUCT.md
[community]: https://github.com/withastro/.github/blob/main/COMMUNITY_GUIDE.md
[discord]: https://astro.build/chat/
[issues]: https://github.com/withastro/astro/issues
[astro-integration]: https://docs.astro.build/en/guides/integrations/
