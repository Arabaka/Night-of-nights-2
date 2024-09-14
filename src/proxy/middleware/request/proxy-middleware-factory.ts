import { Request, Response } from "express";
import { Readable } from "stream";
import ProxyServer from "http-proxy";
import {
  createProxyMiddleware,
  Options,
  debugProxyErrorsPlugin,
  proxyEventsPlugin,
} from "http-proxy-middleware";
import { ProxyReqMutator, RequestPreprocessor } from "./index";
import { logger } from "../../../logger";
import { handleProxyError } from "../common";
import { createOnProxyResHandler, ProxyResHandlerWithBody } from "../response";
import { createQueueMiddleware } from "../../queue";
import { getHttpAgents } from "../../../shared/network";
import { Logger } from "pino";

/**
 * Options for the `createQueuedProxyMiddleware` factory function.
 */
type ProxyMiddlewareFactoryOptions = {
  /**
   * Functions to run just before the request is proxied. This API is deprecated
   * and `mutators` should be used instead.
   * @deprecated
   */
  beforeProxy?: RequestPreprocessor[];
  /**
   * Functions which receive a ProxyReqManager and can modify the request before
   * it is proxied. The modifications will be automatically reverted if the
   * request needs to be returned to the queue.
   */
  mutators?: ProxyReqMutator[];
  /**
   * The target URL to proxy requests to. This can be a string or a function
   * which accepts the request and returns a string.
   */
  target: string | Options<Request>["router"];
  /**
   * A function which receives the proxy response and the JSON-decoded request
   * body. Only fired for non-streaming responses; streaming responses are
   * handled in `handle-streaming-response.ts`.
   */
  blockingResponseHandler?: ProxyResHandlerWithBody;
};

/**
 * Returns a middleware function that accepts incoming requests and places them
 * into the request queue. When the request is dequeued, it is proxied to the
 * target URL using the given options and middleware. Non-streaming responses
 * are handled by the given `blockingResponseHandler`.
 */
export function createQueuedProxyMiddleware({
  target,
  mutators,
  beforeProxy,
  blockingResponseHandler,
}: ProxyMiddlewareFactoryOptions) {
  const hpmTarget = typeof target === "string" ? target : "set by router";
  const hpmRouter = typeof target === "function" ? target : undefined;

  const agent = hpmTarget.startsWith("http:")
    ? getHttpAgents()[0]
    : getHttpAgents()[1];

  const proxyMiddleware = createProxyMiddleware({
    target: hpmTarget,
    router: hpmRouter,
    agent,
    changeOrigin: true,
    toProxy: true,
    selfHandleResponse: typeof blockingResponseHandler === "function",
    // Disable HPM logger plugin (requires re-adding the other default plugins).
    // Contrary to name, debugProxyErrorsPlugin is not just for debugging and
    // fixes several error handling/connection close issues in http-proxy core.
    ejectPlugins: true,
    // Inferred (via Options<express.Request>) as Plugin<express.Request>, but
    // the default plugins only allow http.IncomingMessage for TReq. They are
    // compatible with express.Request, so we can use them. `Plugin` type is not
    // exported for some reason.
    plugins: [
      debugProxyErrorsPlugin,
      pinoLoggerPlugin,
      proxyEventsPlugin,
    ] as any,
    on: {
      proxyRes: createOnProxyResHandler(
        blockingResponseHandler ? [blockingResponseHandler] : []
      ),
      error: handleProxyError,
    },
    buffer: ((req: Request) => {
      // This is a hack/monkey patch and is not part of the official
      // http-proxy-middleware package. See patches/http-proxy+1.18.1.patch.
      const stream = new Readable();
      stream.push(req.body);
      stream.push(null);
      return stream;
    }) as any,
  });

  return createQueueMiddleware({ beforeProxy, mutators, proxyMiddleware });
}

function pinoLoggerPlugin(proxyServer: ProxyServer<Request>) {
  proxyServer.on("error", (err, req, res, target) => {
    const originalUrl = req.originalUrl;
    const targetUrl = target?.toString();
    req.log.error(
      { originalUrl, targetUrl, err },
      "Error occurred while proxying request to target"
    );
  });
  proxyServer.on("proxyReq", (proxyReq, req, res) => {
    const originalUrl = req.originalUrl;
    const targetUrl = res.req.url;
    const target = `${proxyReq.protocol}://${proxyReq.host}`;
    req.log.info(
      { originalUrl, targetUrl, target },
      "Sending upstream request..."
    );
  });
  proxyServer.on("proxyRes", (proxyRes, req, res) => {
    const originalUrl = req.originalUrl;
    const targetUrl = res.req.url;
    const statusCode = proxyRes.statusCode;
    const host = res.req.headers["host"];
    req.log.info(
      { originalUrl, targetUrl, statusCode, host },
      "Got upstream response."
    );
  });
}
