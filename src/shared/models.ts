import { logger } from "../logger";

export type OpenAIModelFamily = "turbo" | "gpt4" | "gpt4-32k" | "gpt4-turbo" | "dall-e";
export type AnthropicModelFamily = "claude";
export type GooglePalmModelFamily = "bison";
export type AwsBedrockModelFamily = "aws-claude";
export type ModelFamily =
  | OpenAIModelFamily
  | AnthropicModelFamily
  | GooglePalmModelFamily
  | AwsBedrockModelFamily;

export const MODEL_FAMILIES = (<A extends readonly ModelFamily[]>(
  arr: A & ([ModelFamily] extends [A[number]] ? unknown : never)
) => arr)([
  "turbo",
  "gpt4",
  "gpt4-32k",
  "gpt4-turbo",
  "dall-e",
  "claude",
  "bison",
  "aws-claude",
] as const);

export const OPENAI_MODEL_FAMILY_MAP: { [regex: string]: OpenAIModelFamily } = {
  "^gpt-4-1106(-preview)?$": "gpt4-turbo",
  "^gpt-4-32k-\\d{4}$": "gpt4-32k",
  "^gpt-4-32k$": "gpt4-32k",
  "^gpt-4-\\d{4}$": "gpt4",
  "^gpt-4$": "gpt4",
  "^gpt-3.5-turbo": "turbo",
  "^text-embedding-ada-002$": "turbo",
  "^dall-e-\\d{4}$": "dall-e",
};

export function getOpenAIModelFamily(
  model: string,
  defaultFamily: OpenAIModelFamily = "gpt4"
): OpenAIModelFamily {
  for (const [regex, family] of Object.entries(OPENAI_MODEL_FAMILY_MAP)) {
    if (model.match(regex)) return family;
  }
  return defaultFamily;
}

export function getClaudeModelFamily(_model: string): ModelFamily {
  return "claude";
}

export function getGooglePalmModelFamily(model: string): ModelFamily {
  if (model.match(/^\w+-bison-\d{3}$/)) return "bison";
  const stack = new Error().stack;
  logger.warn({ model, stack }, "Unmapped PaLM model family");
  return "bison";
}

export function getAwsBedrockModelFamily(_model: string): ModelFamily {
  return "aws-claude";
}

export function assertIsKnownModelFamily(
  modelFamily: string
): asserts modelFamily is ModelFamily {
  if (!MODEL_FAMILIES.includes(modelFamily as ModelFamily)) {
    throw new Error(`Unknown model family: ${modelFamily}`);
  }
}
