import { fixRequestBody } from "http-proxy-middleware";
import type { HPMRequestCallback, ProxyReqMutator } from "../index";

/** Finalize the rewritten request body. Must be the last mutator. */
export const finalizeBody: ProxyReqMutator = (manager) => {
  const req = manager.request;

  if (["POST", "PUT", "PATCH"].includes(req.method ?? "") && req.body) {
    // For image generation requests, remove stream flag.
    if (req.outboundApi === "openai-image") {
      delete req.body.stream;
    }
    // For anthropic text to chat requests, remove undefined prompt.
    if (req.outboundApi === "anthropic-chat") {
      delete req.body.prompt;
    }

    const updatedBody = JSON.stringify(req.body);
    manager.setHeader("Content-Length", String(Buffer.byteLength(updatedBody)));
    manager.setBody(Buffer.from(updatedBody));
    (req as any).rawBody = Buffer.from(updatedBody);
  }
};
