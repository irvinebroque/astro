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

export type D1PartitionBy = 'hostname';

export interface D1BackendServiceOptions {
	/** Durable Object binding name available on `env`. */
	bindingName?: string;

	/** Durable Object class name. MVP supports the generated `AstroD1Backend` class. */
	className?: string;

	/** Maps an incoming request to a logical SQLite-backed object database. */
	objectName: D1ObjectNameFunction;

	/** Configures D1 read replicas. Enabled by default; set to false to opt out. */
	readReplication?: D1ReadReplicationConfig | false;

	/** Routes known write-heavy routes to the primary before rendering. */
	primaryOnlyRoutes?: string[];
}

export interface D1SimpleOptions {
	/** Partitions the D1 backend by request properties. Defaults to one database for the app. */
	partitionBy?: D1PartitionBy;

	/** Routes known write-heavy routes directly to the writable database. */
	writeRoutes?: string[];

	backendService?: never;
}

export interface D1AdvancedOptions {
	/** Low-level D1 backend configuration. Most apps should use `d1: true` instead. */
	backendService: D1BackendServiceOptions;

	partitionBy?: never;
	writeRoutes?: never;
}

export interface D1BackendServiceConfig {
	bindingName: string;
	className: string;
	objectName: D1ObjectNameFunction;
	readReplication: D1ReadReplicationConfig | null;
	primaryOnlyRoutes: string[];
}

export type D1Options = boolean | D1SimpleOptions | D1AdvancedOptions;

const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

export function isValidIdentifier(name: string): boolean {
	return IDENTIFIER_RE.test(name);
}

export function isSerializableObjectNameFunction(fn: D1ObjectNameFunction): boolean {
	const source = fn.toString().trim();
	if (source.includes('[native code]')) {
		return false;
	}

	return /^function(?:\s|\()/.test(source) || /^(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(source);
}

function normalizeReadReplication(
	readReplication: D1BackendServiceOptions['readReplication'],
): D1ReadReplicationConfig | null {
	if (readReplication === false) {
		return null;
	}

	if (readReplication === undefined) {
		return { mode: 'auto' };
	}

	if (!readReplication || typeof readReplication !== 'object' || readReplication.mode !== 'auto') {
		throw new Error(
			'Cloudflare D1 backendService.readReplication must be false or { mode: "auto" }.',
		);
	}

	return { mode: 'auto' };
}

function normalizePrimaryOnlyRoutes(
	primaryOnlyRoutes: D1BackendServiceOptions['primaryOnlyRoutes'],
): string[] {
	if (primaryOnlyRoutes === undefined) {
		return [];
	}

	if (
		!Array.isArray(primaryOnlyRoutes) ||
		primaryOnlyRoutes.some((route) => typeof route !== 'string')
	) {
		throw new Error('Cloudflare D1 backendService.primaryOnlyRoutes must be an array of strings.');
	}

	return [...primaryOnlyRoutes];
}

function normalizeWriteRoutes(writeRoutes: D1SimpleOptions['writeRoutes']): string[] {
	if (writeRoutes === undefined) {
		return [];
	}

	if (!Array.isArray(writeRoutes) || writeRoutes.some((route) => typeof route !== 'string')) {
		throw new Error('Cloudflare D1 writeRoutes must be an array of strings.');
	}

	return [...writeRoutes];
}

function getDefaultD1ObjectName(): string {
	return 'default';
}

function getHostnameD1ObjectName({ request }: D1ObjectNameContext): string {
	return `site:${new URL(request.url).hostname}`;
}

function normalizeSimpleD1BackendService(options: true | D1SimpleOptions): D1BackendServiceConfig {
	const partitionBy = options === true ? undefined : options.partitionBy;

	if (partitionBy !== undefined && partitionBy !== 'hostname') {
		throw new Error('Cloudflare D1 partitionBy must be "hostname".');
	}

	return {
		bindingName: DEFAULT_D1_BACKEND_BINDING_NAME,
		className: DEFAULT_D1_BACKEND_CLASS_NAME,
		objectName: partitionBy === 'hostname' ? getHostnameD1ObjectName : getDefaultD1ObjectName,
		readReplication: null,
		primaryOnlyRoutes: normalizeWriteRoutes(options === true ? undefined : options.writeRoutes),
	};
}

export function normalizeD1BackendService(
	options: D1Options | undefined,
): D1BackendServiceConfig | null {
	if (options === undefined || options === false) {
		return null;
	}

	if (options === true) {
		return normalizeSimpleD1BackendService(options);
	}

	if (!options || typeof options !== 'object') {
		throw new Error('Cloudflare D1 config must be true or an object.');
	}

	if ('backendService' in options) {
		if ('partitionBy' in options || 'writeRoutes' in options) {
			throw new Error(
				'Cloudflare D1 config cannot mix backendService with partitionBy or writeRoutes.',
			);
		}

		if (!options.backendService) {
			return null;
		}

		return normalizeAdvancedD1BackendService(options.backendService);
	}

	return normalizeSimpleD1BackendService(options);
}

function normalizeAdvancedD1BackendService(
	backendService: D1BackendServiceOptions,
): D1BackendServiceConfig {
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

	if (typeof backendService.objectName !== 'function') {
		throw new Error(
			'Cloudflare D1 backendService.objectName must be a synchronous plain function or arrow function that can run in the Workers runtime.',
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
		readReplication: normalizeReadReplication(backendService.readReplication),
		primaryOnlyRoutes: normalizePrimaryOnlyRoutes(backendService.primaryOnlyRoutes),
	};
}
