import { Request } from "express";
import { assertNever } from "../utils";
import {
  init as initClaude,
  getTokenCount as getClaudeTokenCount,
} from "./claude";
import {
  init as initOpenAi,
  getTokenCount as getOpenAITokenCount,
  OpenAIPromptMessage,
  getOpenAIImageCost,
} from "./openai";
import { APIFormat } from "../key-management";

export async function init() {
  initClaude();
  initOpenAi();
}

/** Tagged union via `service` field of the different types of requests that can
 * be made to the tokenization service, for both prompts and completions */
type TokenCountRequest = { req: Request } & (
  | { prompt: OpenAIPromptMessage[]; completion?: never; service: "openai" }
  | {
      prompt: string;
      completion?: never;
      service: "openai-text" | "anthropic" | "google-palm";
    }
  | { prompt?: never; completion: string; service: APIFormat }
);

type TokenCountResult = {
  token_count: number;
  tokenizer: string;
  tokenization_duration_ms: number;
};

export async function countTokens({
  req,
  service,
  prompt,
  completion,
}: TokenCountRequest): Promise<TokenCountResult> {
  const time = process.hrtime();
  switch (service) {
    case "anthropic":
      return {
        ...getClaudeTokenCount(prompt ?? completion, req.body.model),
        tokenization_duration_ms: getElapsedMs(time),
      };
    case "openai":
    case "openai-text":
      return {
        ...getOpenAITokenCount(prompt ?? completion, req.body.model),
        tokenization_duration_ms: getElapsedMs(time),
      };
    case "openai-image":
      return {
        ...getOpenAIImageCost({
          model: req.body.model,
          quality: req.body.quality,
          resolution: req.body.size,
        }),
        tokenization_duration_ms: getElapsedMs(time),
      };
    case "google-palm":
      // TODO: Can't find a tokenization library for PaLM. There is an API
      // endpoint for it but it adds significant latency to the request.
      return {
        ...getOpenAITokenCount(prompt ?? completion, req.body.model),
        tokenization_duration_ms: getElapsedMs(time),
      };
    default:
      assertNever(service);
  }
}

function getElapsedMs(time: [number, number]) {
  const diff = process.hrtime(time);
  return diff[0] * 1000 + diff[1] / 1e6;
}
