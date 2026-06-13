import cloudflare from '@astrojs/cloudflare';
import { defineConfig } from 'astro/config';

export default defineConfig({
	adapter: cloudflare({
		d1: {
			backendService: {
				objectName: ({ request }) => `site:${new URL(request.url).hostname}`,
				primaryOnlyRoutes: ['/admin/**'],
				readReplication: false,
			},
		},
	}),
	output: 'server',
});
