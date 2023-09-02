import { RequestHandler, Request, Router } from "express";
import * as http from "http";
import { createProxyMiddleware } from "http-proxy-middleware";
import { config } from "../config";
import {
  ModelFamily,
  OpenAIModelFamily,
  getOpenAIModelFamily,
  keyPool,
} from "../shared/key-management";
import { logger } from "../logger";
import { createQueueMiddleware } from "./queue";
import { ipLimiter } from "./rate-limit";
import { handleProxyError } from "./middleware/common";
import {
  addKey,
  applyQuotaLimits,
  blockZoomerOrigins,
  createPreprocessorMiddleware,
  finalizeBody,
  languageFilter,
  limitCompletions,
  removeOriginHeaders,
} from "./middleware/request";
import {
  createOnProxyResHandler,
  ProxyResHandlerWithBody,
} from "./middleware/response";

let modelsCache: any = null;
let modelsCacheTime = 0;

function getModelsResponse() {
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return modelsCache;
  }

  // https://platform.openai.com/docs/models/overview
  const knownModels = [
    "gpt-4",
    "gpt-4-0613",
    "gpt-4-0314", // EOL 2024-06-13
    "gpt-4-32k",
    "gpt-4-32k-0613",
    "gpt-4-32k-0314", // EOL 2024-06-13
    "gpt-3.5-turbo",
    "gpt-3.5-turbo-0301", // EOL 2024-06-13
    "gpt-3.5-turbo-0613",
    "gpt-3.5-turbo-16k",
    "gpt-3.5-turbo-16k-0613",
  ];

  let available = new Set<OpenAIModelFamily>();
  for (const key of keyPool.list()) {
    if (key.isDisabled || key.service !== "openai") continue;
    key.modelFamilies.forEach((family) =>
      available.add(family as OpenAIModelFamily)
    );
  }
  const allowed = new Set<ModelFamily>(config.allowedModelFamilies);
  available = new Set([...available].filter((x) => allowed.has(x)));

  const models = knownModels
    .map((id) => ({
      id,
      object: "model",
      created: new Date().getTime(),
      owned_by: "openai",
      permission: [
        {
          id: "modelperm-" + id,
          object: "model_permission",
          created: new Date().getTime(),
          organization: "*",
          group: null,
          is_blocking: false,
        },
      ],
      root: id,
      parent: null,
    }))
    .filter((model) => available.has(getOpenAIModelFamily(model.id)));

  modelsCache = { object: "list", data: models };
  modelsCacheTime = new Date().getTime();

  return modelsCache;
}

const handleModelRequest: RequestHandler = (_req, res) => {
  res.status(200).json(getModelsResponse());
};

const rewriteRequest = (
  proxyReq: http.ClientRequest,
  req: Request,
  res: http.ServerResponse
) => {
  const rewriterPipeline = [
    applyQuotaLimits,
    addKey,
    languageFilter,
    limitCompletions,
    blockZoomerOrigins,
    removeOriginHeaders,
    finalizeBody,
  ];

  try {
    for (const rewriter of rewriterPipeline) {
      rewriter(proxyReq, req, res, {});
    }
  } catch (error) {
    req.log.error(error, "Error while executing proxy rewriter");
    proxyReq.destroy(error as Error);
  }
};

const openaiResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }

  if (config.promptLogging) {
    const host = req.get("host");
    body.proxy_note = `Prompts are logged on this proxy instance. See ${host} for more information.`;
  }

  // TODO: Remove once tokenization is stable
  if (req.debug) {
    body.proxy_tokenizer_debug_info = req.debug;
  }

  res.status(200).json(body);
};

const openaiProxy = createQueueMiddleware(
  createProxyMiddleware({
    target: "https://api.openai.com",
    changeOrigin: true,
    on: {
      proxyReq: rewriteRequest,
      proxyRes: createOnProxyResHandler([openaiResponseHandler]),
      error: handleProxyError,
    },
    selfHandleResponse: true,
    logger,
  })
);

const openaiRouter = Router();
// Fix paths because clients don't consistently use the /v1 prefix.
openaiRouter.use((req, _res, next) => {
  if (!req.path.startsWith("/v1/")) {
    req.url = `/v1${req.url}`;
  }
  next();
});
openaiRouter.get("/v1/models", handleModelRequest);
openaiRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware({ inApi: "openai", outApi: "openai" }),
  openaiProxy
);
// Redirect browser requests to the homepage.
openaiRouter.get("*", (req, res, next) => {
  const isBrowser = req.headers["user-agent"]?.includes("Mozilla");
  if (isBrowser) {
    res.redirect("/");
  } else {
    next();
  }
});
openaiRouter.use((req, res) => {
  req.log.warn(`Blocked openai proxy request: ${req.method} ${req.path}`);
  res.status(404).json({ error: "Not found" });
});

export const openai = openaiRouter;
