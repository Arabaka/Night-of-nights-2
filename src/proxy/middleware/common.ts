import { Request, Response } from "express";
import httpProxy from "http-proxy";
import { ZodError } from "zod";
import { assertNever } from "../../shared/utils";
import { QuotaExceededError } from "./request/apply-quota-limits";

const OPENAI_CHAT_COMPLETION_ENDPOINT = "/v1/chat/completions";
const OPENAI_TEXT_COMPLETION_ENDPOINT = "/v1/completions";
const OPENAI_EMBEDDINGS_ENDPOINT = "/v1/embeddings";
const ANTHROPIC_COMPLETION_ENDPOINT = "/v1/complete";

/** Returns true if we're making a request to a completion endpoint. */
export function isCompletionRequest(req: Request) {
  // 99% sure this function is not needed anymore
  return (
    req.method === "POST" &&
    [
      OPENAI_CHAT_COMPLETION_ENDPOINT,
      OPENAI_TEXT_COMPLETION_ENDPOINT,
      ANTHROPIC_COMPLETION_ENDPOINT,
    ].some((endpoint) => req.path.startsWith(endpoint))
  );
}

export function isEmbeddingsRequest(req: Request) {
  return (
    req.method === "POST" && req.path.startsWith(OPENAI_EMBEDDINGS_ENDPOINT)
  );
}

export function writeErrorResponse(
  req: Request,
  res: Response,
  statusCode: number,
  errorPayload: Record<string, any>
) {
  const errorSource = errorPayload.error?.type?.startsWith("proxy")
    ? "proxy"
    : "upstream";

  // If we're mid-SSE stream, send a data event with the error payload and end
  // the stream. Otherwise just send a normal error response.
  if (
    res.headersSent ||
    res.getHeader("content-type") === "text/event-stream"
  ) {
    const errorContent =
      statusCode === 403
        ? JSON.stringify(errorPayload)
        : JSON.stringify(errorPayload, null, 2);

    const msg = buildFakeSseMessage(
      `${errorSource} error (${statusCode})`,
      errorContent,
      req
    );
    res.write(msg);
    res.write(`data: [DONE]\n\n`);
    res.end();
  } else {
    if (req.debug && errorPayload.error) {
      errorPayload.error.proxy_tokenizer_debug_info = req.debug;
    }
    res.status(statusCode).json(errorPayload);
  }
}

export const handleProxyError: httpProxy.ErrorCallback = (err, req, res) => {
  req.log.error({ err }, `Error during proxy request middleware`);
  handleInternalError(err, req as Request, res as Response);
};

export const handleInternalError = (
  err: Error,
  req: Request,
  res: Response
) => {
  try {
    if (err instanceof ZodError) {
      writeErrorResponse(req, res, 400, {
        error: {
          type: "proxy_validation_error",
          proxy_note: `Reverse proxy couldn't validate your request when trying to transform it. Your client may be sending invalid data.`,
          issues: err.issues,
          stack: err.stack,
          message: err.message,
        },
      });
    } else if (err.name === "ForbiddenError") {
      // Spoofs a vaguely threatening OpenAI error message. Only invoked by the
      // block-zoomers rewriter to scare off tiktokers.
      writeErrorResponse(req, res, 403, {
        error: {
          type: "organization_account_disabled",
          code: "policy_violation",
          param: null,
          message: err.message,
        },
      });
    } else if (err instanceof QuotaExceededError) {
      writeErrorResponse(req, res, 429, {
        error: {
          type: "proxy_quota_exceeded",
          code: "quota_exceeded",
          message: `You've exceeded your token quota for this model type.`,
          info: err.quotaInfo,
          stack: err.stack,
        },
      });
    } else {
      writeErrorResponse(req, res, 500, {
        error: {
          type: "proxy_internal_error",
          proxy_note: `Reverse proxy encountered an error before it could reach the upstream API.`,
          message: err.message,
          stack: err.stack,
        },
      });
    }
  } catch (e) {
    req.log.error(
      { error: e },
      `Error writing error response headers, giving up.`
    );
  }
};

export function buildFakeSseMessage(
  type: string,
  string: string,
  req: Request
) {
  let fakeEvent;
  const content = `\`\`\`\n[${type}: ${string}]\n\`\`\`\n`;

  switch (req.inboundApi) {
    case "openai":
      fakeEvent = {
        id: "chatcmpl-" + req.id,
        object: "chat.completion.chunk",
        created: Date.now(),
        model: req.body?.model,
        choices: [{ delta: { content }, index: 0, finish_reason: type }],
      };
      break;
    case "openai-text":
      fakeEvent = {
        id: "cmpl-" + req.id,
        object: "text_completion",
        created: Date.now(),
        choices: [
          { text: content, index: 0, logprobs: null, finish_reason: type },
        ],
        model: req.body?.model,
      };
      break;
    case "anthropic":
      fakeEvent = {
        completion: content,
        stop_reason: type,
        truncated: false, // I've never seen this be true
        stop: null,
        model: req.body?.model,
        log_id: "proxy-req-" + req.id,
      };
      break;
    case "google-palm":
      throw new Error("PaLM not supported as an inbound API format");
    default:
      assertNever(req.inboundApi);
  }
  return `data: ${JSON.stringify(fakeEvent)}\n\n`;
}

export function getCompletionFromBody(req: Request, body: Record<string, any>) {
  const format = req.outboundApi;
  switch (format) {
    case "openai":
      return body.choices[0].message.content;
    case "openai-text":
      return body.choices[0].text;
    case "anthropic":
      if (!body.completion) {
        req.log.error(
          { body: JSON.stringify(body) },
          "Received empty Anthropic completion"
        );
        return "";
      }
      return body.completion.trim();
    case "google-palm":
      return body.candidates[0].output;
    default:
      assertNever(format);
  }
}

export function getModelFromBody(req: Request, body: Record<string, any>) {
  const format = req.outboundApi;
  switch (format) {
    case "openai":
      return body.model;
    case "openai-text":
      return body.model;
    case "anthropic":
      return body.model;
    case "google-palm":
      // Google doesn't confirm the model in the response.
      return req.body.model;
    default:
      assertNever(format);
  }
}
