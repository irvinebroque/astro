import type { D1BackendServiceConfig } from './d1-config.js';

export interface AstroD1Client {
	query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
	queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | null;
}

type D1DurableObjectState = DurableObjectState & {
	primaryStub?: DurableObjectStub;
	configureReadReplication?: (
		config: NonNullable<D1BackendServiceConfig['readReplication']>,
	) => Promise<void>;
};

type BookmarkStorage = DurableObjectStorage & {
	waitForBookmark?: (bookmark: string) => Promise<void>;
	getCurrentBookmark?: () => Promise<string>;
};

export class D1PrimaryReroute extends Error {
	constructor() {
		super('D1 write must be rerouted to the primary Durable Object.');
		this.name = 'D1PrimaryReroute';
	}
}

export function isD1PrimaryReroute(error: unknown): error is D1PrimaryReroute {
	return error instanceof D1PrimaryReroute;
}

export function createAstroD1Client(ctx: DurableObjectState): AstroD1Client {
	const d1Ctx = ctx as D1DurableObjectState;

	function assertCanExecute(sql: string): void {
		// Replicas cannot write. Signal the object fetch handler to replay the
		// original request on the primary before any mutation is executed.
		if (d1Ctx.primaryStub && isMutationSql(sql)) {
			throw new D1PrimaryReroute();
		}
	}

	return {
		query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
			assertCanExecute(sql);
			return ctx.storage.sql.exec(sql, ...params).toArray() as T[];
		},
		queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | null {
			assertCanExecute(sql);
			return (ctx.storage.sql.exec(sql, ...params).toArray()[0] as T | undefined) ?? null;
		},
	};
}

export function isKnownWriteRequest(
	request: Request,
	primaryOnlyRoutes: D1BackendServiceConfig['primaryOnlyRoutes'],
): boolean {
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return true;
	}

	const { pathname } = new URL(request.url);
	return primaryOnlyRoutes.some((pattern) => matchPrimaryOnlyRoute(pathname, pattern));
}

export function getD1ObjectName(config: D1BackendServiceConfig, request: Request): string {
	const name = config.objectName({ request });
	if (typeof name !== 'string' || name.length === 0) {
		throw new Error('Cloudflare D1 backendService.objectName must return a non-empty string.');
	}
	return name;
}

export function matchPrimaryOnlyRoute(pathname: string, pattern: string): boolean {
	if (pattern.endsWith('/**')) {
		const prefix = pattern.slice(0, -3);
		return pathname === prefix || pathname.startsWith(`${prefix}/`);
	}

	if (pattern.endsWith('/*')) {
		const prefix = pattern.slice(0, -2);
		const rest = pathname.slice(prefix.length + 1);
		return pathname.startsWith(`${prefix}/`) && rest.length > 0 && !rest.includes('/');
	}

	return pathname === pattern;
}

export function isMutationSql(sql: string): boolean {
	const token = getFirstSqlToken(sql);
	if (!token) {
		return true;
	}

	// Be conservative: unknown statements should run on the primary. This keeps
	// replicas safe at the cost of occasionally sending a complex read to primary.
	return token !== 'select' && token !== 'explain';
}

export function getD1Namespace(env: Env, bindingName: string): DurableObjectNamespace {
	const namespace = env[bindingName];
	if (
		!namespace ||
		typeof namespace !== 'object' ||
		typeof (namespace as DurableObjectNamespace).getByName !== 'function'
	) {
		throw new Error(
			`Cloudflare D1 backend binding "${bindingName}" was not found. Add a Durable Object binding for the generated Astro D1 backend.`,
		);
	}
	return namespace as DurableObjectNamespace;
}

export function getD1Stub(
	env: Env,
	config: D1BackendServiceConfig,
	name: string,
	request: Request,
): DurableObjectStub {
	const namespace = getD1Namespace(env, config.bindingName);
	const options = isKnownWriteRequest(request, config.primaryOnlyRoutes)
		? { routingMode: 'primary-only' as const }
		: undefined;

	return (namespace.getByName as (name: string, options?: unknown) => DurableObjectStub)(
		name,
		options,
	);
}

export function createD1CfContext(ctx: DurableObjectState): ExecutionContext {
	// Astro users expect `Astro.locals.cfContext` on Cloudflare. D1 rendering runs
	// inside a Durable Object, so expose the compatible context surface there.
	const context = {
		waitUntil(promise: Promise<unknown>) {
			ctx.waitUntil?.(promise);
		},
		passThroughOnException() {},
	};

	Object.defineProperty(context, 'exports', {
		enumerable: true,
		get() {
			return (ctx as DurableObjectState & { exports?: unknown }).exports;
		},
	});

	return context as ExecutionContext;
}

export async function waitForD1Bookmark(ctx: DurableObjectState, request: Request): Promise<void> {
	const bookmark = request.headers.get('x-d1-bookmark');
	const storage = ctx.storage as BookmarkStorage;
	if (bookmark && storage.waitForBookmark) {
		await storage.waitForBookmark(bookmark);
	}
}

export async function withD1Bookmark(
	ctx: DurableObjectState,
	response: Response,
): Promise<Response> {
	const storage = ctx.storage as BookmarkStorage;
	if (!storage.getCurrentBookmark) {
		return response;
	}

	const nextResponse = new Response(response.body, response);
	nextResponse.headers.set('x-d1-bookmark', await storage.getCurrentBookmark());
	return nextResponse;
}

function getFirstSqlToken(sql: string): string | undefined {
	let source = sql.trimStart();

	while (source.startsWith('--') || source.startsWith('/*')) {
		if (source.startsWith('--')) {
			const newlineIndex = source.indexOf('\n');
			source = newlineIndex === -1 ? '' : source.slice(newlineIndex + 1).trimStart();
			continue;
		}

		const commentEndIndex = source.indexOf('*/');
		if (commentEndIndex === -1) {
			return undefined;
		}
		source = source.slice(commentEndIndex + 2).trimStart();
	}

	return /^[A-Za-z]+/.exec(source)?.[0].toLowerCase();
}
