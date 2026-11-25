import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as BlockClassifier from "./BlockClassifier.ts";
import { ClassifierSettings } from "./ClassifierSettings.ts";
import * as CodeNarrator from "./CodeNarrator.ts";
import * as HashClassifier from "./HashClassifier.ts";
import { ChatModel, NarrationDisabled, NarrationFailed } from "./Narration.ts";
import * as TableNarrator from "./TableNarrator.ts";

export const ProviderSettings = Schema.Struct({
  classifier: Schema.optional(ClassifierSettings),
  enabled: Schema.Boolean,
  codeEnabled: Schema.Boolean,
  hashEnabled: Schema.optional(Schema.Boolean),
  apiKey: Schema.Redacted(Schema.String),
  apiUrl: Schema.String,
  model: Schema.String,
  reasoningEffort: Schema.optional(
    Schema.Literals(["none", "minimal", "low", "medium", "high", "xhigh", "max"]),
  ),
});
export type ProviderSettings = typeof ProviderSettings.Type;

const disabledNarration = {
  narrate: Effect.fn("Narration.generate")(function* () {
    return yield* new NarrationDisabled();
  }),
};
const disabledCode = Layer.succeed(
  CodeNarrator.CodeNarrator,
  CodeNarrator.CodeNarrator.of(disabledNarration),
);

const ChatCompletion = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      message: Schema.Struct({ content: Schema.NullOr(Schema.String) }),
      finish_reason: Schema.NullOr(Schema.String),
    }),
  ),
});

/** Chat completions from any OpenAI-compatible endpoint at `apiUrl`. */
const chatModelLayer = (settings: ProviderSettings) =>
  Layer.effect(
    ChatModel,
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
      return ChatModel.of({
        complete: Effect.fn("ChatModel.complete")(function* (instructions, source) {
          const response = yield* HttpClientRequest.post(
            `${settings.apiUrl.replace(/\/+$/, "")}/chat/completions`,
          ).pipe(
            HttpClientRequest.bearerToken(settings.apiKey),
            HttpClientRequest.bodyJsonUnsafe({
              model: settings.model,
              messages: [
                { role: "system", content: instructions },
                { role: "user", content: source },
              ],
              ...(settings.reasoningEffort === undefined
                ? {}
                : { reasoning_effort: settings.reasoningEffort }),
            }),
            client.execute,
            Effect.flatMap(HttpClientResponse.schemaBodyJson(ChatCompletion)),
            Effect.mapError((cause) => new NarrationFailed({ reason: "provider", cause })),
          );
          const choice = response.choices[0];
          if (!choice || choice.message.content === null) return { text: "", finished: false };
          return { text: choice.message.content, finished: choice.finish_reason === "stop" };
        }),
      });
    }),
  );

/**
 * Both narrators share a provider, but code transmission requires its own opt-in. Hash
 * classification needs only the classifier, so it runs without a narration provider.
 */
export const narratorLayer = (settings: ProviderSettings) => {
  const hashClassifier =
    settings.hashEnabled && settings.classifier
      ? HashClassifier.layer(settings.classifier)
      : HashClassifier.disabled;
  if (!settings.enabled)
    return Layer.mergeAll(
      Layer.succeed(TableNarrator.TableNarrator, TableNarrator.TableNarrator.of(disabledNarration)),
      disabledCode,
      BlockClassifier.disabled,
      hashClassifier,
    );
  return Layer.mergeAll(
    TableNarrator.layer,
    settings.codeEnabled ? CodeNarrator.layer : disabledCode,
    hashClassifier,
    !settings.codeEnabled
      ? BlockClassifier.disabled
      : settings.classifier
        ? BlockClassifier.layer(settings.classifier)
        : BlockClassifier.verbatim,
  ).pipe(Layer.provide(chatModelLayer(settings)));
};
