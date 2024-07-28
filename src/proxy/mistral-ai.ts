import { RequestHandler, Router } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { config } from "../config";
import { keyPool } from "../shared/key-management";
import {
  getMistralAIModelFamily,
  MistralAIModelFamily,
  ModelFamily,
} from "../shared/models";
import { logger } from "../logger";
import { createQueueMiddleware } from "./queue";
import { ipLimiter } from "./rate-limit";
import { handleProxyError } from "./middleware/common";
import {
  addKey,
  createOnProxyReqHandler,
  createPreprocessorMiddleware,
  finalizeBody,
} from "./middleware/request";
import {
  createOnProxyResHandler,
  ProxyResHandlerWithBody,
} from "./middleware/response";

// Mistral can't settle on a single naming scheme and deprecates models within
// months of releasing them so this list is hard to keep up to date. 2024-07-28
// https://docs.mistral.ai/platform/endpoints
export const KNOWN_MISTRAL_AI_MODELS = [
  /*
  Mistral Nemo
  "A 12B model built with the partnership with Nvidia.  It is easy to use and a
  drop-in replacement in any system using Mistral 7B that it supersedes."
  */
  "open-mistral-nemo",
  "open-mistral-nemo-2407",
  /*
  Mistral Large
  "Our flagship model with state-of-the-art reasoning, knowledge, and coding
  capabilities."
  */
  "mistral-large-latest",
  "mistral-large-2407",
  "mistral-large-2402", // deprecated
  /*
  Codestral
  "A cutting-edge generative model that has been specifically designed and
  optimized for code generation tasks, including fill-in-the-middle and code
  completion."
  note: this uses a separate bidi completion endpoint that is not implemented
  */
  "codestral-latest",
  "codestral-2405",
  /* So-called "Research Models" */
  "open-mistral-7b",
  "open-mixtral-8x7b",
  "open-mistral-8x22b",
  "open-codestral-mamba",
  /* Deprecated production models */
  "mistral-small-latest",
  "mistral-small-2402",
  "mistral-medium-latest",
  "mistral-medium-2312",
  "mistral-tiny",
  "mistral-tiny-2312"
];

let modelsCache: any = null;
let modelsCacheTime = 0;

export function generateModelList(models = KNOWN_MISTRAL_AI_MODELS) {
  let available = new Set<MistralAIModelFamily>();
  for (const key of keyPool.list()) {
    if (key.isDisabled || key.service !== "mistral-ai") continue;
    key.modelFamilies.forEach((family) =>
      available.add(family as MistralAIModelFamily)
    );
  }
  const allowed = new Set<ModelFamily>(config.allowedModelFamilies);
  available = new Set([...available].filter((x) => allowed.has(x)));

  return models
    .map((id) => ({
      id,
      object: "model",
      created: new Date().getTime(),
      owned_by: "mistral-ai",
    }))
    .filter((model) => available.has(getMistralAIModelFamily(model.id)));
}

const handleModelRequest: RequestHandler = (_req, res) => {
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return res.status(200).json(modelsCache);
  }
  const result = generateModelList();
  modelsCache = { object: "list", data: result };
  modelsCacheTime = new Date().getTime();
  res.status(200).json(modelsCache);
};

const mistralAIResponseHandler: ProxyResHandlerWithBody = async (
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

const mistralAIProxy = createQueueMiddleware({
  proxyMiddleware: createProxyMiddleware({
    target: "https://api.mistral.ai",
    changeOrigin: true,
    selfHandleResponse: true,
    logger,
    on: {
      proxyReq: createOnProxyReqHandler({
        pipeline: [addKey, finalizeBody],
      }),
      proxyRes: createOnProxyResHandler([mistralAIResponseHandler]),
      error: handleProxyError,
    },
  }),
});

const mistralAIRouter = Router();
mistralAIRouter.get("/v1/models", handleModelRequest);
// General chat completion endpoint.
mistralAIRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware({
    inApi: "mistral-ai",
    outApi: "mistral-ai",
    service: "mistral-ai",
  }),
  mistralAIProxy
);

export const mistralAI = mistralAIRouter;
