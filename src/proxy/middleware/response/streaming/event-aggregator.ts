import { APIFormat } from "../../../../shared/key-management";
import { assertNever } from "../../../../shared/utils";
import {
  anthropicV2ToOpenAI,
  mergeEventsForAnthropic,
  mergeEventsForOpenAIChat,
  mergeEventsForOpenAIText,
  OpenAIChatCompletionStreamEvent,
} from "./index";
import { AnthropicV2StreamEvent } from "./transformers/anthropic-chat-to-anthropic-v2";

/**
 * Collects SSE events containing incremental chat completion responses and
 * compiles them into a single finalized response for downstream middleware.
 */
export class EventAggregator {
  private readonly format: APIFormat;
  private readonly events: OpenAIChatCompletionStreamEvent[];

  constructor({ format }: { format: APIFormat }) {
    this.events = [];
    this.format = format;
  }

  addEvent(event: OpenAIChatCompletionStreamEvent | AnthropicV2StreamEvent) {
    if (eventIsOpenAIEvent(event)) {
      this.events.push(event);
    } else {
      // horrible special case. previously all transformers' target format was
      // openai, so the event aggregator could conveniently assume all incoming
      // events were in openai format.
      // now we have added anthropic-chat-to-text, so aggregator needs to know
      // how to collapse events from two formats.
      // because that is annoying, we will simply transform all anthropic-chat
      // events to openai (even if the client didn't ask for openai) so we don't
      // have to write aggregation logic for anthropic chat (which is also an
      // annoying format due to stateful deltas).
      const openAIEvent = anthropicV2ToOpenAI({
        data: JSON.stringify(event),
        lastPosition: -1,
        index: 0,
        fallbackId: event.log_id || "event-aggregator-fallback",
        fallbackModel: event.model || "claude-3-fallback",
      });
      if (openAIEvent.event) {
        this.events.push(openAIEvent.event);
      }
    }
  }

  getFinalResponse() {
    switch (this.format) {
      case "openai":
      case "google-ai":
      case "mistral-ai":
        return mergeEventsForOpenAIChat(this.events);
      case "openai-text":
        return mergeEventsForOpenAIText(this.events);
      case "anthropic-text":
        return mergeEventsForAnthropic(this.events);
      case "anthropic-chat":
      case "openai-image":
        throw new Error(`SSE aggregation not supported for ${this.format}`);
      default:
        assertNever(this.format);
    }
  }
}

function eventIsOpenAIEvent(
  event: any
): event is OpenAIChatCompletionStreamEvent {
  return event?.object === "chat.completion.chunk";
}
