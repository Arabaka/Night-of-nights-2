import type { Request } from "express";

import { ProxyReqManager } from "./proxy-req-manager";
export {
  createPreprocessorMiddleware,
  createEmbeddingsPreprocessorMiddleware,
} from "./preprocessor-factory";

// Preprocessors (runs before request is queued, usually body transformation/validation)
export { addAzureKey } from "./preprocessors/add-azure-key";
export { applyQuotaLimits } from "./preprocessors/apply-quota-limits";
export { blockZoomerOrigins } from "./preprocessors/block-zoomer-origins";
export { countPromptTokens } from "./preprocessors/count-prompt-tokens";
export { languageFilter } from "./preprocessors/language-filter";
export { setApiFormat } from "./preprocessors/set-api-format";
export { signAwsRequest } from "./preprocessors/sign-aws-request";
export { signGcpRequest } from "./preprocessors/sign-vertex-ai-request";
export { transformOutboundPayload } from "./preprocessors/transform-outbound-payload";
export { validateContextSize } from "./preprocessors/validate-context-size";
export { validateModelFamily } from "./preprocessors/validate-model-family";
export { validateVision } from "./preprocessors/validate-vision";

// Proxy request mutators (runs just before proxying, usually to modify HTTP params)
export {
  addKey,
  addKeyForEmbeddingsRequest,
} from "./proxy-req-mutators/add-key";
export { finalizeBody } from "./proxy-req-mutators/finalize-body";
export { finalizeSignedRequest } from "./proxy-req-mutators/finalize-signed-request";
export { stripHeaders } from "./proxy-req-mutators/strip-headers";

/**
 * Middleware that runs prior to the request being handled by http-proxy-
 * middleware.
 *
 * Async functions can be used here, but you will not have access to the proxied
 * request/response objects, nor the data set by ProxyRequestMiddleware
 * functions as they have not yet been run.
 *
 * User will have been authenticated by the time this middleware runs, but your
 * request won't have been assigned an API key yet.
 *
 * Note that these functions only run once ever per request, even if the request
 * is automatically retried by the request queue middleware.
 */
export type RequestPreprocessor = (req: Request) => void | Promise<void>;

/**
 * Middleware that runs immediately before the request is proxied to the
 * upstream API, after dequeueing the request from the request queue.
 *
 * Because these middleware may be run multiple times per request if a retryable
 * error occurs and the request put back in the queue, they must be idempotent.
 * A change manager is provided to allow the middleware to make changes to the
 * request which can be automatically reverted.
 */
export type ProxyReqMutator = (
  changeManager: ProxyReqManager
) => void | Promise<void>;

/**
 * Callbacks that run immediately before the request is sent to the API in
 * response to http-proxy-middleware's `proxyReq` event.
 *
 * Async functions cannot be used here as HPM's event emitter is not async and
 * will not wait for the promise to resolve before sending the request.
 *
 * Note that these functions may be run multiple times per request if the
 * first attempt is rate limited and the request is automatically retried by the
 * request queue middleware.
 */
export type HPMRequestCallback = any;

export const forceModel = (model: string) => (req: Request) =>
  void (req.body.model = model);
