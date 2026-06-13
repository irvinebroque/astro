import type { PluginOption } from 'vite';
import type { D1BackendServiceConfig } from './utils/d1-config.js';

const VIRTUAL_CONFIG_ID = 'virtual:astro-cloudflare:config';
const RESOLVED_VIRTUAL_CONFIG_ID = '\0' + VIRTUAL_CONFIG_ID;

export interface CompileImageConfig {
	base: string;
	assetsPrefix: string | undefined;
	imageServiceEntrypoint: string;
	buildAssets: string;
}

export interface Config {
	sessionKVBindingName: string;
	compileImageConfig: CompileImageConfig | null;
	d1BackendService: D1BackendServiceConfig | null;
	isPrerender: boolean;
}

export function createConfigPlugin(config: Omit<Config, 'isPrerender'>): PluginOption {
	return {
		name: VIRTUAL_CONFIG_ID,
		resolveId: {
			filter: {
				id: new RegExp(`^${VIRTUAL_CONFIG_ID}$`),
			},
			handler() {
				return RESOLVED_VIRTUAL_CONFIG_ID;
			},
		},
		load: {
			filter: {
				id: new RegExp(`^${RESOLVED_VIRTUAL_CONFIG_ID}$`),
			},
			handler() {
				return [
					...Object.entries(config).map(([k, v]) => serializeConfigExport(k, v)),
					`export const isPrerender = ${this.environment?.name === 'prerender'};`,
				].join('\n');
			},
		},
	};
}

function serializeConfigExport(key: string, value: unknown): string {
	if (key === 'd1BackendService') {
		return `export const ${key} = ${serializeD1BackendService(value as D1BackendServiceConfig | null)};`;
	}

	return `export const ${key} = ${JSON.stringify(value)};`;
}

function serializeD1BackendService(config: D1BackendServiceConfig | null): string {
	if (!config) {
		return 'null';
	}

	return `{
		bindingName: ${JSON.stringify(config.bindingName)},
		className: ${JSON.stringify(config.className)},
		objectName: (${config.objectName.toString()}),
		readReplication: ${JSON.stringify(config.readReplication)},
		primaryOnlyRoutes: ${JSON.stringify(config.primaryOnlyRoutes)},
	}`;
}
