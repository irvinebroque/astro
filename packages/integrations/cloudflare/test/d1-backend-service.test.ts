import * as assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import * as cheerio from 'cheerio';
import { type Fixture, loadFixture, type PreviewServer } from './test-utils.ts';

describe('D1 backend service', () => {
	let fixture: Fixture;
	let previewServer: PreviewServer;

	before(async () => {
		fixture = await loadFixture({
			root: './fixtures/d1-backend-service/',
		});
		await fixture.build();
		previewServer = await fixture.preview();
	});

	after(async () => {
		await previewServer.stop();
	});

	it('generates current Durable Objects binding and SQLite migration config', async () => {
		const wrangler = JSON.parse(await fixture.readFile('server/wrangler.json'));

		assert.deepEqual(wrangler.durable_objects, {
			bindings: [{ name: 'AstroD1Backend', class_name: 'AstroD1Backend' }],
		});
		assert.deepEqual(wrangler.migrations, [
			{ tag: 'astro-d1-v1', new_sqlite_classes: ['AstroD1Backend'] },
		]);
		assert.ok(!wrangler.compatibility_flags.includes('replica_routing'));
	});

	it('renders Astro pages inside the D1 backend object', async () => {
		const response = await fixture.fetch('/');
		const html = await response.text();
		const $ = cheerio.load(html);

		assert.equal($('#hasD1').text(), 'true');
		assert.equal($('#hasCfContext').text(), 'true');
		assert.equal($('#hasWaitUntil').text(), 'true');
		assert.equal($('#posts li').first().text(), 'Hello from D1');
		assert.equal($('#contentPosts li').first().text(), 'Hello from D1');
		assert.equal($('#contentPost').text(), 'Hello from D1');
	});

	it('writes from an Astro endpoint through locals.d1', async () => {
		const response = await fixture.fetch('/api/posts', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ title: 'Created from endpoint' }),
		});

		assert.equal(response.status, 201);
		const post = (await response.json()) as { id: number; title: string };
		assert.equal(typeof post.id, 'number');
		assert.equal(post.title, 'Created from endpoint');
	});

	it('serves static assets from the front Worker', async () => {
		const response = await fixture.fetch('/static.txt');

		assert.equal(response.status, 200);
		assert.equal(await response.text(), 'static asset\n');
	});
});
