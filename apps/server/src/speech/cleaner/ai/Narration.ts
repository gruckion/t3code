import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class NarrationFailed extends Schema.TaggedError<NarrationFailed>()("NarrationFailed", {
  reason: Schema.Literals([
    "provider",
    "incomplete",
    "placeholder",
    "classification",
    "hash-classification",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Speech narration failed: ${this.reason}.`;
  }
}

/** No narration provider is configured; a rule that needs one keeps its input unchanged. */
export class NarrationDisabled extends Schema.TaggedError<NarrationDisabled>()(
  "NarrationDisabled",
  {},
) {
  override get message(): string {
    return "Speech narration is not configured.";
  }
}

/** An OpenAI-compatible chat model: `finished` when it stopped on its own, not at a limit. */
export class ChatModel extends Context.Service<
  ChatModel,
  {
    readonly complete: (
      instructions: string,
      source: string,
    ) => Effect.Effect<{ readonly text: string; readonly finished: boolean }, NarrationFailed>;
  }
>()("t3/speech/cleaner/ai/Narration/ChatModel") {}

/** Share completion/error handling; each narrator owns its instructions. */
export const makeNarrator = Effect.fnUntraced(function* (instructions: string) {
  const model = yield* ChatModel;
  return Effect.fn("Narration.generate")(function* (source: string) {
    const response = yield* model.complete(instructions, source);
    if (!response.finished || !response.text.trim())
      return yield* new NarrationFailed({ reason: "incomplete" });
    return response.text.trim();
  });
});
