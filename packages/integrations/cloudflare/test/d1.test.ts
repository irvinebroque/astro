import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	D1PrimaryReroute,
	createAstroD1Client,
	createD1CfContext,
	getD1ObjectName,
	getD1Stub,
	isKnownWriteRequest,
	isMutationSql,
	matchPrimaryOnlyRoute,
} from '../dist/utils/d1.js';
import {
	DEFAULT_D1_BACKEND_BINDING_NAME,
	DEFAULT_D1_BACKEND_CLASS_NAME,
	normalizeD1BackendService,
} from '../dist/utils/d1-config.js';

describe('D1 helpers', () => {
	describe('normalizeD1BackendService', () => {
		it('returns null when no D1 backend service is configured', () => {
			assert.equal(normalizeD1BackendService(undefined), null);
			assert.equal(normalizeD1BackendService({}), null);
		});

		it('normalizes default binding and class names', () => {
			const objectName = ({ request }: { request: Request }) => new URL(request.url).hostname;
			const config = normalizeD1BackendService({ backendService: { objectName } });

			assert.equal(config?.bindingName, DEFAULT_D1_BACKEND_BINDING_NAME);
			assert.equal(config?.className, DEFAULT_D1_BACKEND_CLASS_NAME);
			assert.equal(config?.objectName, objectName);
			assert.deepEqual(config?.readReplication, { mode: 'auto' });
			assert.deepEqual(config?.primaryOnlyRoutes, []);
		});

		it('opts out of read replication when configured false', () => {
			const config = normalizeD1BackendService({
				backendService: {
					objectName: () => 'site:example.com',
					readReplication: false,
				},
			});

			assert.equal(config?.readReplication, null);
		});

		it('normalizes read replication and primary-only routes', () => {
			const config = normalizeD1BackendService({
				backendService: {
					objectName: () => 'site:example.com',
					readReplication: { mode: 'auto', ignored: true } as any,
					primaryOnlyRoutes: ['/admin/**'],
				},
			});

			assert.deepEqual(config?.readReplication, { mode: 'auto' });
			assert.deepEqual(config?.primaryOnlyRoutes, ['/admin/**']);
		});

		it('rejects missing or non-function objectName config from JavaScript users', () => {
			assert.throws(
				() => normalizeD1BackendService({ backendService: {} as any }),
				/synchronous plain function/,
			);
			assert.throws(
				() =>
					normalizeD1BackendService({
						backendService: { objectName: 'site:example.com' as any },
					}),
				/synchronous plain function/,
			);
		});

		it('rejects invalid binding and class names', () => {
			const objectName = () => 'site:example.com';

			assert.throws(
				() =>
					normalizeD1BackendService({ backendService: { bindingName: 'bad-name', objectName } }),
				/backendService\.bindingName/,
			);
			assert.throws(
				() => normalizeD1BackendService({ backendService: { className: 'bad-name', objectName } }),
				/backendService\.className/,
			);
		});

		it('rejects custom class names until generated entrypoints exist', () => {
			assert.throws(
				() =>
					normalizeD1BackendService({
						backendService: { className: 'CustomD1Backend', objectName: () => 'site:example.com' },
					}),
				/generated entrypoint support/,
			);
		});

		it('rejects async or native objectName functions', () => {
			assert.throws(
				() =>
					normalizeD1BackendService({
						backendService: { objectName: (async () => 'site:example.com') as any },
					}),
				/synchronous plain function/,
			);
			assert.throws(
				() =>
					normalizeD1BackendService({
						backendService: { objectName: Date.now as any },
					}),
				/synchronous plain function/,
			);
		});

		it('rejects generator objectName functions', () => {
			const generatorObjectName = function* objectName() {
				yield 'site:example.com';
			};

			assert.throws(
				() =>
					normalizeD1BackendService({
						backendService: { objectName: generatorObjectName as any },
					}),
				/synchronous plain function/,
			);
		});

		it('rejects invalid readReplication config from JavaScript users', () => {
			assert.throws(
				() =>
					normalizeD1BackendService({
						backendService: { objectName: () => 'site:example.com', readReplication: true as any },
					}),
				/must be false or \{ mode: "auto" \}/,
			);
			assert.throws(
				() =>
					normalizeD1BackendService({
						backendService: {
							objectName: () => 'site:example.com',
							readReplication: { mode: 'manual' } as any,
						},
					}),
				/must be false or \{ mode: "auto" \}/,
			);
		});

		it('rejects invalid primaryOnlyRoutes config from JavaScript users', () => {
			assert.throws(
				() =>
					normalizeD1BackendService({
						backendService: {
							objectName: () => 'site:example.com',
							primaryOnlyRoutes: '/admin/**' as any,
						},
					}),
				/primaryOnlyRoutes must be an array of strings/,
			);
			assert.throws(
				() =>
					normalizeD1BackendService({
						backendService: {
							objectName: () => 'site:example.com',
							primaryOnlyRoutes: ['/admin/**', 123] as any,
						},
					}),
				/primaryOnlyRoutes must be an array of strings/,
			);
		});
	});

	describe('isKnownWriteRequest', () => {
		it('treats non-GET and non-HEAD requests as known writes', () => {
			assert.equal(
				isKnownWriteRequest(new Request('https://example.com/', { method: 'POST' }), []),
				true,
			);
			assert.equal(
				isKnownWriteRequest(new Request('https://example.com/', { method: 'PUT' }), []),
				true,
			);
			assert.equal(
				isKnownWriteRequest(new Request('https://example.com/', { method: 'GET' }), []),
				false,
			);
			assert.equal(
				isKnownWriteRequest(new Request('https://example.com/', { method: 'HEAD' }), []),
				false,
			);
		});

		it('treats primary-only route matches as known writes', () => {
			assert.equal(
				isKnownWriteRequest(new Request('https://example.com/admin/posts'), ['/admin/**']),
				true,
			);
			assert.equal(
				isKnownWriteRequest(new Request('https://example.com/public/posts'), ['/admin/**']),
				false,
			);
		});
	});

	describe('getD1ObjectName', () => {
		it('returns the configured object name', () => {
			assert.equal(
				getD1ObjectName(
					{
						bindingName: 'AstroD1Backend',
						className: 'AstroD1Backend',
						objectName: ({ request }: { request: Request }) =>
							`site:${new URL(request.url).hostname}`,
						readReplication: null,
						primaryOnlyRoutes: [],
					},
					new Request('https://example.com/'),
				),
				'site:example.com',
			);
		});

		it('rejects empty or non-string object names', () => {
			const baseConfig = {
				bindingName: 'AstroD1Backend',
				className: 'AstroD1Backend',
				readReplication: null,
				primaryOnlyRoutes: [],
			};

			assert.throws(
				() =>
					getD1ObjectName(
						{ ...baseConfig, objectName: () => '' },
						new Request('https://example.com/'),
					),
				/non-empty string/,
			);
			assert.throws(
				() =>
					getD1ObjectName(
						{ ...baseConfig, objectName: (() => undefined) as any },
						new Request('https://example.com/'),
					),
				/non-empty string/,
			);
		});
	});

	describe('matchPrimaryOnlyRoute', () => {
		it('matches exact, single-segment, and deep patterns', () => {
			assert.equal(matchPrimaryOnlyRoute('/refresh-cache', '/refresh-cache'), true);
			assert.equal(matchPrimaryOnlyRoute('/admin/posts', '/admin/*'), true);
			assert.equal(matchPrimaryOnlyRoute('/admin/posts/1', '/admin/*'), false);
			assert.equal(matchPrimaryOnlyRoute('/admin/posts/1', '/admin/**'), true);
		});
	});

	describe('isMutationSql', () => {
		it('allows simple reads on replicas', () => {
			assert.equal(isMutationSql('SELECT * FROM posts'), false);
			assert.equal(isMutationSql('EXPLAIN SELECT * FROM posts'), false);
			assert.equal(isMutationSql('-- comment\n /* next comment */ SELECT * FROM posts'), false);
		});

		it('classifies writes and unknown statements as mutations', () => {
			assert.equal(isMutationSql('INSERT INTO posts (title) VALUES (?)'), true);
			assert.equal(isMutationSql('UPDATE posts SET title = ?'), true);
			assert.equal(
				isMutationSql('WITH recent AS (SELECT * FROM posts) SELECT * FROM recent'),
				true,
			);
			assert.equal(isMutationSql('/* unfinished comment'), true);
		});
	});

	describe('createAstroD1Client', () => {
		it('executes queries and consumes cursors synchronously', () => {
			const calls: unknown[][] = [];
			const ctx = {
				storage: {
					sql: {
						exec(sql: string, ...params: unknown[]) {
							calls.push([sql, ...params]);
							return { toArray: () => [{ id: 1 }] };
						},
					},
				},
			};

			const client = createAstroD1Client(ctx as any);
			assert.deepEqual(client.query('SELECT id FROM posts WHERE id = ?', [1]), [{ id: 1 }]);
			assert.deepEqual(calls, [['SELECT id FROM posts WHERE id = ?', 1]]);
		});

		it('throws an internal reroute signal for mutation SQL on replicas', () => {
			const ctx = {
				primaryStub: {},
				storage: {
					sql: {
						exec() {
							throw new Error('should not execute on replica');
						},
					},
				},
			};

			const client = createAstroD1Client(ctx as any);
			assert.throws(() => client.query('INSERT INTO posts (title) VALUES (?)'), D1PrimaryReroute);
		});
	});

	describe('createD1CfContext', () => {
		it('preserves waitUntil and exports on Astro.locals.cfContext', () => {
			const waits: Promise<unknown>[] = [];
			const exports = { Test: {} };
			const cfContext = createD1CfContext({
				exports,
				waitUntil(promise: Promise<unknown>) {
					waits.push(promise);
				},
			} as any);

			const promise = Promise.resolve();
			cfContext.waitUntil(promise);

			assert.deepEqual(waits, [promise]);
			assert.equal((cfContext as any).exports, exports);
		});
	});

	describe('getD1Stub', () => {
		it('passes primary-only routing for known writes', () => {
			const calls: unknown[][] = [];
			const env = {
				AstroD1Backend: {
					getByName(...args: unknown[]) {
						calls.push(args);
						return {};
					},
				},
			};

			getD1Stub(
				env as any,
				{
					bindingName: 'AstroD1Backend',
					className: 'AstroD1Backend',
					objectName: () => 'site:example.com',
					readReplication: null,
					primaryOnlyRoutes: [],
				},
				'site:example.com',
				new Request('https://example.com/api/posts', { method: 'POST' }),
			);

			assert.deepEqual(calls, [['site:example.com', { routingMode: 'primary-only' }]]);
		});

		it('uses default routing for reads', () => {
			const calls: unknown[][] = [];
			const env = {
				AstroD1Backend: {
					getByName(...args: unknown[]) {
						calls.push(args);
						return {};
					},
				},
			};

			getD1Stub(
				env as any,
				{
					bindingName: 'AstroD1Backend',
					className: 'AstroD1Backend',
					objectName: () => 'site:example.com',
					readReplication: null,
					primaryOnlyRoutes: [],
				},
				'site:example.com',
				new Request('https://example.com/posts'),
			);

			assert.deepEqual(calls, [['site:example.com', undefined]]);
		});
	});
});
