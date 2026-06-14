import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { D1LiveLoaderError, d1LiveLoader } from '../dist/loaders.js';

function createD1Client({
	rows = [],
	row = null,
	error = null,
}: {
	rows?: Record<string, unknown>[];
	row?: Record<string, unknown> | null;
	error?: unknown;
} = {}) {
	const calls: Array<{ method: 'query' | 'queryOne'; sql: string; params: unknown[] }> = [];
	return {
		calls,
		client: {
			query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
				calls.push({ method: 'query', sql, params });
				if (error) throw error;
				return rows as T[];
			},
			queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
				calls.push({ method: 'queryOne', sql, params });
				if (error) throw error;
				return row as T | null;
			},
		},
	};
}

describe('d1LiveLoader', () => {
	it('loads a single D1 row as a live content entry', async () => {
		const { client, calls } = createD1Client({
			row: { slug: 'hello', title: 'Hello from D1', internal: 'hidden' },
		});
		const loader = d1LiveLoader({
			table: 'posts',
			idColumn: 'slug',
			columns: ['title'],
			mapRow: (row) => ({ title: row.title }),
		});

		const result = await loader.loadEntry({
			collection: 'posts',
			filter: { d1: client, id: 'hello' },
		});

		assert.deepEqual(result, {
			id: 'hello',
			data: { title: 'Hello from D1' },
		});
		assert.deepEqual(calls, [
			{
				method: 'queryOne',
				sql: 'SELECT "slug", "title" FROM "posts" WHERE "slug" = ? LIMIT 1',
				params: ['hello'],
			},
		]);
	});

	it('loads a D1 table as a live content collection', async () => {
		const { client, calls } = createD1Client({
			rows: [
				{ id: 2, title: 'Second' },
				{ id: 1, title: 'First' },
			],
		});
		const loader = d1LiveLoader({
			table: 'posts',
			columns: ['title'],
			orderBy: { column: 'id', direction: 'desc' },
		});

		const result = await loader.loadCollection({
			collection: 'posts',
			filter: { d1: client, limit: 2, offset: 1 },
		});

		assert.deepEqual(result, {
			entries: [
				{ id: '2', data: { id: 2, title: 'Second' } },
				{ id: '1', data: { id: 1, title: 'First' } },
			],
		});
		assert.deepEqual(calls, [
			{
				method: 'query',
				sql: 'SELECT "id", "title" FROM "posts" ORDER BY "id" DESC LIMIT ? OFFSET ?',
				params: [2, 1],
			},
		]);
	});

	it('returns undefined when an entry does not exist', async () => {
		const { client } = createD1Client();
		const loader = d1LiveLoader({ table: 'posts' });

		const result = await loader.loadEntry({
			collection: 'posts',
			filter: { d1: client, id: 'missing' },
		});

		assert.equal(result, undefined);
	});

	it('returns a helpful error when no D1 client is passed', async () => {
		const loader = d1LiveLoader({ table: 'posts' });

		const result = await loader.loadCollection({ collection: 'posts' });

		assert.ok('error' in result);
		assert.ok(result.error instanceof D1LiveLoaderError);
		assert.match(result.error.message, /Astro\.locals\.d1/);
	});

	it('returns D1 query failures as loader errors', async () => {
		const cause = new Error('database unavailable');
		const { client } = createD1Client({ error: cause });
		const loader = d1LiveLoader({ table: 'posts' });

		const result = await loader.loadCollection({
			collection: 'posts',
			filter: { d1: client },
		});

		assert.ok('error' in result);
		assert.ok(result.error instanceof D1LiveLoaderError);
		assert.equal(result.error.cause, cause);
	});

	it('validates pagination filters', async () => {
		const { client } = createD1Client();
		const loader = d1LiveLoader({ table: 'posts' });

		const result = await loader.loadCollection({
			collection: 'posts',
			filter: { d1: client, limit: 1.5 },
		});

		assert.ok('error' in result);
		assert.ok(result.error instanceof D1LiveLoaderError);
		assert.match(result.error.message, /limit must be a non-negative integer/);
	});

	it('returns a helpful error when collection rows do not include the ID column', async () => {
		const { client } = createD1Client({ rows: [{ title: 'No ID' }] });
		const loader = d1LiveLoader({ table: 'posts' });

		const result = await loader.loadCollection({
			collection: 'posts',
			filter: { d1: client },
		});

		assert.ok('error' in result);
		assert.ok(result.error instanceof D1LiveLoaderError);
		assert.match(result.error.message, /must include the "id" ID column/);
	});

	it('validates JavaScript loader options', () => {
		assert.throws(() => d1LiveLoader({ table: '' }), /table must be a string/);
		assert.throws(
			() => d1LiveLoader({ table: 'posts', columns: ['title', 1] as any }),
			/columns must be strings/,
		);
		assert.throws(
			() =>
				d1LiveLoader({
					table: 'posts',
					orderBy: { column: 'title', direction: 'sideways' as any },
				}),
			/orderBy\.direction/,
		);
	});
});
