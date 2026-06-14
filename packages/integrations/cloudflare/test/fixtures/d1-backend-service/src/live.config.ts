import { d1LiveLoader } from '@astrojs/cloudflare/loaders';
import { defineLiveCollection } from 'astro:content';
import { z } from 'astro/zod';

const posts = defineLiveCollection({
	loader: d1LiveLoader({
		table: 'posts',
		columns: ['title'],
		orderBy: 'id',
	}),
	schema: z.object({
		id: z.number(),
		title: z.string(),
	}),
});

export const collections = { posts };
