import type { LiveLoader } from 'astro/loaders';
import type { AstroD1Client } from './utils/d1.js';

export type D1LiveLoaderRow = Record<string, unknown>;

export type D1LiveLoaderOrderBy =
	| string
	| {
			column: string;
			direction?: 'asc' | 'desc';
	  };

export interface D1LiveLoaderOptions<
	TData extends Record<string, any> = D1LiveLoaderRow,
	TRow extends D1LiveLoaderRow = D1LiveLoaderRow,
> {
	/** The SQLite table to expose as a live content collection. */
	table: string;

	/** The column used as each content entry ID. Defaults to `id`. */
	idColumn?: string;

	/** Columns to select. Defaults to every column. */
	columns?: string[];

	/** Optional ordering for collection queries. */
	orderBy?: D1LiveLoaderOrderBy;

	/** Maps a database row to the live collection entry `data`. */
	mapRow?: (row: TRow) => TData | Promise<TData>;
}

export interface D1LiveLoaderContext {
	/** The D1 client available as `Astro.locals.d1` on Cloudflare. */
	d1: AstroD1Client;
}

export interface D1LiveLoaderEntryFilter extends D1LiveLoaderContext {
	id: string | number;
}

export interface D1LiveLoaderCollectionFilter extends D1LiveLoaderContext {
	limit?: number;
	offset?: number;
}

export class D1LiveLoaderError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'D1LiveLoaderError';
	}
}

export function d1LiveLoader<
	TData extends Record<string, any> = D1LiveLoaderRow,
	TRow extends D1LiveLoaderRow = D1LiveLoaderRow,
>(
	options: D1LiveLoaderOptions<TData, TRow>,
): LiveLoader<TData, D1LiveLoaderEntryFilter, D1LiveLoaderCollectionFilter, D1LiveLoaderError> {
	const table = quoteIdentifier(options.table, 'table');
	const idColumnName = options.idColumn ?? 'id';
	const idColumn = quoteIdentifier(idColumnName, 'idColumn');
	const columns = getSelectColumns(idColumnName, options.columns);
	const orderBy = options.orderBy ? ` ORDER BY ${serializeOrderBy(options.orderBy)}` : '';
	const mapRow = options.mapRow ?? ((row: TRow) => row as unknown as TData);

	return {
		name: '@astrojs/cloudflare:d1-live-loader',
		async loadEntry({ filter }) {
			const d1 = getD1Client(filter);
			if (d1 instanceof D1LiveLoaderError) {
				return { error: d1 };
			}

			try {
				const row = d1.queryOne<TRow>(
					`SELECT ${columns} FROM ${table} WHERE ${idColumn} = ? LIMIT 1`,
					[filter.id],
				);
				if (!row) {
					return undefined;
				}

				return {
					id: String(row[idColumnName] ?? filter.id),
					data: await mapRow(row),
				};
			} catch (error) {
				return {
					error:
						error instanceof D1LiveLoaderError
							? error
							: new D1LiveLoaderError('Failed to load D1 content entry.', {
									cause: error,
								}),
				};
			}
		},
		async loadCollection({ filter }) {
			const d1 = getD1Client(filter);
			if (d1 instanceof D1LiveLoaderError) {
				return { error: d1 };
			}
			const collectionFilter = filter!;

			try {
				const { sql, params } = addPagination(
					`SELECT ${columns} FROM ${table}${orderBy}`,
					collectionFilter,
				);
				const rows = d1.query<TRow>(sql, params);

				return {
					entries: await Promise.all(
						rows.map(async (row) => ({
							id: getRowId(row, idColumnName),
							data: await mapRow(row),
						})),
					),
				};
			} catch (error) {
				return {
					error:
						error instanceof D1LiveLoaderError
							? error
							: new D1LiveLoaderError('Failed to load D1 content collection.', {
									cause: error,
								}),
				};
			}
		},
	};
}

function getD1Client(filter: unknown): AstroD1Client | D1LiveLoaderError {
	const d1 = (filter as Partial<D1LiveLoaderContext> | undefined)?.d1;
	if (!d1 || typeof d1.query !== 'function' || typeof d1.queryOne !== 'function') {
		return new D1LiveLoaderError(
			'Cloudflare D1 live collections require `{ d1: Astro.locals.d1 }` in the live collection filter.',
		);
	}
	return d1;
}

function getSelectColumns(idColumn: string, columns: string[] | undefined): string {
	if (!columns) {
		return '*';
	}
	if (!Array.isArray(columns) || columns.some((column) => typeof column !== 'string')) {
		throw new D1LiveLoaderError('Cloudflare D1 live collection columns must be strings.');
	}

	const selectColumns = columns.includes(idColumn) ? columns : [idColumn, ...columns];
	return selectColumns.map((column) => quoteIdentifier(column, 'columns')).join(', ');
}

function serializeOrderBy(orderBy: D1LiveLoaderOrderBy): string {
	if (typeof orderBy === 'string') {
		return quoteIdentifier(orderBy, 'orderBy');
	}

	const direction = orderBy.direction ?? 'asc';
	if (direction !== 'asc' && direction !== 'desc') {
		throw new D1LiveLoaderError(
			'Cloudflare D1 live collection orderBy.direction must be "asc" or "desc".',
		);
	}
	return `${quoteIdentifier(orderBy.column, 'orderBy.column')} ${direction.toUpperCase()}`;
}

function addPagination(
	sql: string,
	filter: D1LiveLoaderCollectionFilter,
): { sql: string; params: unknown[] } {
	const params: unknown[] = [];
	let nextSql = sql;

	if (filter.limit !== undefined) {
		nextSql += ' LIMIT ?';
		params.push(normalizePaginationValue(filter.limit, 'limit'));
	} else if (filter.offset !== undefined) {
		nextSql += ' LIMIT -1';
	}

	if (filter.offset !== undefined) {
		nextSql += ' OFFSET ?';
		params.push(normalizePaginationValue(filter.offset, 'offset'));
	}

	return { sql: nextSql, params };
}

function getRowId(row: D1LiveLoaderRow, idColumnName: string): string {
	const id = row[idColumnName];
	if (id === undefined || id === null) {
		throw new D1LiveLoaderError(
			`Cloudflare D1 live collection rows must include the "${idColumnName}" ID column.`,
		);
	}
	return String(id);
}

function normalizePaginationValue(value: number, name: 'limit' | 'offset'): number {
	if (!Number.isInteger(value) || value < 0) {
		throw new D1LiveLoaderError(
			`Cloudflare D1 live collection ${name} must be a non-negative integer.`,
		);
	}
	return value;
}

function quoteIdentifier(identifier: string, name: string): string {
	if (typeof identifier !== 'string' || identifier.length === 0) {
		throw new D1LiveLoaderError(`Cloudflare D1 live collection ${name} must be a string.`);
	}

	return `"${identifier.replaceAll('"', '""')}"`;
}
