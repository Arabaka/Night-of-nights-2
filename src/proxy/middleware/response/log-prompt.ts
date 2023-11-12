import { Request } from "express";
import { config } from "../../../config";
import { logQueue } from "../../../shared/prompt-logging";
import {
  getCompletionFromBody,
  getModelFromBody,
  isImageGenerationRequest,
  isTextGenerationRequest,
} from "../common";
import { ProxyResHandlerWithBody } from ".";
import { assertNever } from "../../../shared/utils";

/** If prompt logging is enabled, enqueues the prompt for logging. */
export const logPrompt: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  _res,
  responseBody
) => {
  if (!config.promptLogging) {
    return;
  }
  if (typeof responseBody !== "object") {
    throw new Error("Expected body to be an object");
  }

  const loggable =
    isTextGenerationRequest(req) || isImageGenerationRequest(req);
  if (!loggable) return;

  const promptPayload = getPromptForRequest(req);
  const promptFlattened = flattenMessages(promptPayload);
  const response = getCompletionFromBody(req, responseBody);
  const model = getModelFromBody(req, responseBody);

  logQueue.enqueue({
    endpoint: req.inboundApi,
    promptRaw: JSON.stringify(promptPayload),
    promptFlattened,
    model,
    response,
  });
};

type OaiMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

const getPromptForRequest = (req: Request): string | OaiMessage[] => {
  // Since the prompt logger only runs after the request has been proxied, we
  // can assume the body has already been transformed to the target API's
  // format.
  switch (req.outboundApi) {
    case "openai":
      return req.body.messages;
    case "openai-text":
    case "openai-image":
      return req.body.prompt;
    case "anthropic":
      return req.body.prompt;
    case "google-palm":
      return req.body.prompt.text;
    default:
      assertNever(req.outboundApi);
  }
};

const flattenMessages = (messages: string | OaiMessage[]): string => {
  if (typeof messages === "string") {
    return messages.trim();
  }
  return messages.map((m) => `${m.role}: ${m.content}`).join("\n");
};
