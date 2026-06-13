export const DEFAULT_D1_BACKEND_BINDING_NAME = 'AstroD1Backend';
export const DEFAULT_D1_BACKEND_CLASS_NAME = 'AstroD1Backend';
export const DEFAULT_D1_BACKEND_MIGRATION_TAG = 'astro-d1-v1';

export type D1ObjectNameContext = {
	request: Request;
};

export type D1ObjectNameFunction = (context: D1ObjectNameContext) => string;

export type D1ReadReplicationConfig = {
	mode: 'auto';
};

export interface D1BackendServiceOptions {
	/** Durable Object binding name available on `env`. */
	bindingName?: string;

	/** Durable Object class name. MVP supports the generated `AstroD1Backend` class. */
	className?: string;

	/** Maps an incoming request to a logical SQLite-backed object database. */
	objectName: D1ObjectNameFunction;

	/** Enables D1 read replicas for objects created by this backend service. */
	readReplication?: D1ReadReplicationConfig | false;

	/** Routes known write-heavy routes to the primary before rendering. */
	primaryOnlyRoutes?: string[];
}

export interface D1BackendServiceConfig {
	bindingName: string;
	className: string;
	objectName: D1ObjectNameFunction;
	readReplication: D1ReadReplicationConfig | null;
	primaryOnlyRoutes: string[];
}

export interface D1Options {
	backendService?: D1BackendServiceOptions;
}

const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

export function isValidIdentifier(name: string): boolean {
	return IDENTIFIER_RE.test(name);
}

export function isSerializableObjectNameFunction(fn: D1ObjectNameFunction): boolean {
	const source = fn.toString().trim();
	if (source.includes('[native code]')) {
		return false;
	}

	return /^function\b/.test(source) || /^(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(source);
}

export function normalizeD1BackendService(
	options: D1Options | undefined,
): D1BackendServiceConfig | null {
	const backendService = options?.backendService;
	if (!backendService) {
		return null;
	}

	const bindingName = backendService.bindingName ?? DEFAULT_D1_BACKEND_BINDING_NAME;
	const className = backendService.className ?? DEFAULT_D1_BACKEND_CLASS_NAME;

	if (!isValidIdentifier(bindingName)) {
		throw new Error(
			`Invalid Cloudflare D1 backendService.bindingName "${bindingName}". The binding name must be a valid JavaScript identifier.`,
		);
	}

	if (!isValidIdentifier(className)) {
		throw new Error(
			`Invalid Cloudflare D1 backendService.className "${className}". The class name must be a valid JavaScript identifier.`,
		);
	}

	if (className !== DEFAULT_D1_BACKEND_CLASS_NAME) {
		throw new Error(
			`Cloudflare D1 backendService.className currently must be "${DEFAULT_D1_BACKEND_CLASS_NAME}". Custom class names require generated entrypoint support.`,
		);
	}

	if (!isSerializableObjectNameFunction(backendService.objectName)) {
		throw new Error(
			'Cloudflare D1 backendService.objectName must be a synchronous plain function or arrow function that can run in the Workers runtime.',
		);
	}

	return {
		bindingName,
		className,
		objectName: backendService.objectName,
		readReplication:
			backendService.readReplication === false ? null : (backendService.readReplication ?? null),
		primaryOnlyRoutes: backendService.primaryOnlyRoutes ?? [],
	};
}
