import { RequestHandler, Router } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { config } from "../config";
import { logger } from "../logger";
import { generateModelList } from "./openai";
import { createQueueMiddleware } from "./queue";
import { ipLimiter } from "./rate-limit";
import { handleProxyError } from "./middleware/common";
import {
  addAzureKey,
  createOnProxyReqHandler,
  createPreprocessorMiddleware,
  finalizeSignedRequest,
} from "./middleware/request";
import {
  createOnProxyResHandler,
  ProxyResHandlerWithBody,
} from "./middleware/response";
import { getHttpAgents } from "../shared/network";

let modelsCache: any = null;
let modelsCacheTime = 0;

const handleModelRequest: RequestHandler = (_req, res) => {
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return res.status(200).json(modelsCache);
  }

  if (!config.azureCredentials) return { object: "list", data: [] };

  const result = generateModelList("azure");

  modelsCache = { object: "list", data: result };
  modelsCacheTime = new Date().getTime();
  res.status(200).json(modelsCache);
};

const azureOpenaiResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }

  res.status(200).json({ ...body, proxy: body.proxy });
};

const azureOpenAIProxy = createQueueMiddleware({
  beforeProxy: addAzureKey,
  proxyMiddleware: createProxyMiddleware({
    target: "will be set by router",
    agent: getHttpAgents()[0],
    router: (req) => {
      if (!req.signedRequest) throw new Error("signedRequest not set");
      const { hostname, path } = req.signedRequest;
      return `https://${hostname}${path}`;
    },
    changeOrigin: true,
    selfHandleResponse: true,
    logger,
    on: {
      proxyReq: createOnProxyReqHandler({ pipeline: [finalizeSignedRequest] }),
      proxyRes: createOnProxyResHandler([azureOpenaiResponseHandler]),
      error: handleProxyError,
    },
  }),
});

const azureOpenAIRouter = Router();
azureOpenAIRouter.get("/v1/models", handleModelRequest);
azureOpenAIRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware({
    inApi: "openai",
    outApi: "openai",
    service: "azure",
  }),
  azureOpenAIProxy
);
azureOpenAIRouter.post(
  "/v1/images/generations",
  ipLimiter,
  createPreprocessorMiddleware({
    inApi: "openai-image",
    outApi: "openai-image",
    service: "azure",
  }),
  azureOpenAIProxy
);

export const azure = azureOpenAIRouter;
