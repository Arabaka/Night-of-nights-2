import { Request, Response } from "express";
import * as http from "http";
import { RawResponseBodyHandler, decodeResponseBody } from ".";
import { buildFakeSseMessage } from "../../queue";

type OpenAiChatCompletionResponse = {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    message: { role: string; content: string };
    finish_reason: string | null;
    index: number;
  }[];
};

type AnthropicCompletionResponse = {
  completion: string;
  stop_reason: string;
  truncated: boolean;
  stop: any;
  model: string;
  log_id: string;
  exception: null;
};

/**
 * Consume the SSE stream and forward events to the client. Once the stream is
 * stream is closed, resolve with the full response body so that subsequent
 * middleware can work with it.
 *
 * Typically we would only need of the raw response handlers to execute, but
 * in the event a streamed request results in a non-200 response, we need to
 * fall back to the non-streaming response handler so that the error handler
 * can inspect the error response.
 *
 * Currently most frontends don't support Anthropic streaming, so users can opt
 * to send requests for Claude models via an endpoint that accepts OpenAI-
 * compatible requests and translates the received Anthropic SSE events into
 * OpenAI ones, essentially pretending to be an OpenAI streaming API.
 */
export const handleStreamedResponse: RawResponseBodyHandler = async (
  proxyRes,
  req,
  res
) => {
  // If these differ, the user is using the OpenAI-compatibile endpoint, so
  // we need to translate the SSE events into OpenAI completion events for their
  // frontend.
  const fromApi = req.api;
  const toApi = req.key!.service;
  if (!req.isStreaming) {
    req.log.error(
      { api: req.api, key: req.key?.hash },
      `handleStreamedResponse called for non-streaming request, which isn't valid.`
    );
    throw new Error("handleStreamedResponse called for non-streaming request.");
  }

  if (proxyRes.statusCode !== 200) {
    // Ensure we use the non-streaming middleware stack since we won't be
    // getting any events.
    req.isStreaming = false;
    req.log.warn(
      `Streaming request to ${req.api} returned ${proxyRes.statusCode} status code. Falling back to non-streaming response handler.`
    );
    return decodeResponseBody(proxyRes, req, res);
  }

  return new Promise((resolve, reject) => {
    req.log.info(
      { api: req.api, key: req.key?.hash },
      `Starting to proxy SSE stream.`
    );

    // Queued streaming requests will already have a connection open and headers
    // sent due to the heartbeat handler.  In that case we can just start
    // streaming the response without sending headers.
    if (!res.headersSent) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      copyHeaders(proxyRes, res);
      res.flushHeaders();
    }

    const fullChunks: string[] = [];
    let chunkBuffer: string[] = [];
    let messageBuffer = "";
    let lastPosition = 0;
    proxyRes.on("data", (chunk) => {
      // We may receive multiple (or partial) SSE messages in a single chunk, so
      // we need to buffer and emit seperate stream events for full messages so
      // we can parse/transform them properly.
      const str = chunk.toString();
      chunkBuffer.push(str);

      const newMessages = (messageBuffer + chunkBuffer.join("")).split("\n\n");
      chunkBuffer = [];
      messageBuffer = newMessages.pop() || "";

      for (const message of newMessages) {
        proxyRes.emit("full-sse-event", message);
      }
    });

    proxyRes.on("full-sse-event", (data) => {
      req.log.debug(
        { data, fullChunks: fullChunks.length },
        "Received full SSE event, transforming and forwarding to client."
      );
      const { event, position } = transformEvent(
        data,
        fromApi,
        toApi,
        fullChunks.length
      );
      fullChunks.push(event);
      lastPosition = position;
      res.write(event + "\n\n");
    });

    proxyRes.on("end", () => {
      let finalBody = convertEventsToFinalResponse(chunkBuffer, req);
      req.log.info(
        { api: req.api, key: req.key?.hash },
        `Finished proxying SSE stream.`
      );
      res.end();
      resolve(finalBody);
    });

    proxyRes.on("error", (err) => {
      req.log.error(
        { error: err, api: req.api, key: req.key?.hash },
        `Error while streaming response.`
      );
      const fakeErrorEvent = buildFakeSseMessage(
        "mid-stream-error",
        err.message,
        req
      );
      res.write(`data: ${JSON.stringify(fakeErrorEvent)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      reject(err);
    });
  });
};

function transformEvent(
  data: string,
  fromApi: string,
  toApi: string,
  lastPosition: number
) {
  if (fromApi === toApi) {
    return { position: -1, event: data };
  }

  if (fromApi === "openai" && toApi === "anthropic") {
    throw new Error(`OpenAI -> Anthropic streaming not yet supported.`);
  }

  // Anthropic sends the full completion so far with each event whereas OpenAI
  // only sends the delta. To make the SSE events compatible, we remove
  // everything before `lastPosition` from the completion.
  if (!data.startsWith("data:")) {
    return { position: lastPosition, event: data };
  }

  if (data.startsWith("data: [DONE]")) {
    return { position: lastPosition, event: data };
  }

  const event = JSON.parse(data.slice("data: ".length));
  if (event.completion) {
    event.completion = event.completion.slice(lastPosition);
  }
  return {
    position: event.completion.length,
    event: `data: ${JSON.stringify(event)}\n\n`,
  };
}

/** Copy headers, excluding ones we're already setting for the SSE response. */
function copyHeaders(proxyRes: http.IncomingMessage, res: Response) {
  const toOmit = [
    "content-length",
    "content-encoding",
    "transfer-encoding",
    "content-type",
    "connection",
    "cache-control",
  ];
  for (const [key, value] of Object.entries(proxyRes.headers)) {
    if (!toOmit.includes(key) && value) {
      res.setHeader(key, value);
    }
  }
}

function convertEventsToFinalResponse(chunks: string[], req: Request) {
  if (req.key!.service === "openai") {
    let response: OpenAiChatCompletionResponse = {
      id: "",
      object: "",
      created: 0,
      model: "",
      choices: [],
    };
    const events = chunks
      .join("")
      .split("\n\n")
      .map((line) => line.trim());

    response = events.reduce((acc, chunk, i) => {
      if (!chunk.startsWith("data: ")) {
        return acc;
      }

      if (chunk === "data: [DONE]") {
        return acc;
      }

      const data = JSON.parse(chunk.slice("data: ".length));
      if (i === 0) {
        return {
          id: data.id,
          object: data.object,
          created: data.created,
          model: data.model,
          choices: [
            {
              message: { role: data.choices[0].delta.role, content: "" },
              index: 0,
              finish_reason: null,
            },
          ],
        };
      }

      if (data.choices[0].delta.content) {
        acc.choices[0].message.content += data.choices[0].delta.content;
      }
      acc.choices[0].finish_reason = data.choices[0].finish_reason;
      return acc;
    }, response);
    return response;
  }
  if (req.key!.service === "anthropic") {
    /*
     * Full complete responses from Anthropic are conveniently just the same as
     * the final SSE event before the "DONE" event, so we can reuse that
     */
    const lastEvent = chunks[chunks.length - 2].toString();
    const data = JSON.parse(lastEvent.slice("data: ".length));
    const response: AnthropicCompletionResponse = {
      ...data,
      log_id: req.id,
    };
    return response;
  }
  throw new Error("If you get this, something is fucked");
}
