import { DurableObject } from 'cloudflare:workers';
import { d1BackendService } from 'virtual:astro-cloudflare:config';
import {
	createAstroD1Client,
	createD1CfContext,
	isD1PrimaryReroute,
	isKnownWriteRequest,
	waitForD1Bookmark,
	withD1Bookmark,
} from '../utils/d1.js';
import { handle, renderAstroRequest } from '../utils/handler.js';

type D1DurableObjectState = DurableObjectState & {
	primaryStub?: DurableObjectStub;
	configureReadReplication?: (
		config: NonNullable<typeof d1BackendService>['readReplication'],
	) => Promise<void>;
};

export class AstroD1Backend extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);

		const d1Ctx = ctx as D1DurableObjectState;
		ctx.blockConcurrencyWhile(async () => {
			if (
				!d1Ctx.primaryStub &&
				d1Ctx.configureReadReplication &&
				d1BackendService?.readReplication
			) {
				await d1Ctx.configureReadReplication(d1BackendService.readReplication);
			}
		});
	}

	async fetch(request: Request): Promise<Response> {
		if (!d1BackendService) {
			return new Response('Astro D1 backend service is not enabled.', { status: 500 });
		}

		const d1Ctx = this.ctx as D1DurableObjectState;
		if (d1Ctx.primaryStub && isKnownWriteRequest(request, d1BackendService.primaryOnlyRoutes)) {
			return d1Ctx.primaryStub.fetch(request as unknown as RequestInfo);
		}

		// If rendering discovers a write on a replica, replay this clean request on
		// the primary. The active request body may already be consumed by then.
		const replayRequest = d1Ctx.primaryStub ? request.clone() : null;
		try {
			await waitForD1Bookmark(this.ctx, request);
			const response = await renderAstroRequest(request, this.env, createD1CfContext(this.ctx), {
				d1: createAstroD1Client(this.ctx),
			});
			return await withD1Bookmark(this.ctx, response);
		} catch (error) {
			if (d1Ctx.primaryStub && replayRequest && isD1PrimaryReroute(error)) {
				return d1Ctx.primaryStub.fetch(replayRequest as unknown as RequestInfo);
			}
			throw error;
		}
	}
}

export default {
	fetch: handle,
} satisfies ExportedHandler<Env>;
