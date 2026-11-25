import { readAloudSpeech } from "@t3tools/shared/read-aloud";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { HttpClient } from "effect/http";

import { JEV_DEFAULT_API_URL, JEV_DEFAULT_MODEL } from "./cleaner/ai/ClassifierSettings.ts";
import type { ProviderSettings } from "./cleaner/ai/Provider.ts";
import * as SpeechCleaner from "./cleaner/engine/SpeechCleaner.ts";
import * as SpeechCleanerLive from "./cleaner/SpeechCleanerLive.ts";
import * as ReadAloudCache from "./readAloudCache.ts";
import { spokenTextMap, type TextRange } from "./spokenTextMap.ts";

/** Change it when the cleaner's rules change, so cached rewrites are made again. */
const CLEANER_VERSION = "1";
const DEFAULT_LLM_BASE_URL = "https://api.openai.com/v1";
/** A block waits this long for its rewrite; a later one plays it, and its audio is cached then. */
const REWRITE_WAIT = "15 seconds";
/** Rewrites stay in memory for replays, including ones not cached on disk. */
const RECENT_REWRITES = 256;

/** What a block says: its text, and the range of the block's plain text a range of it reads. */
export interface SpokenBlock {
  readonly text: string;
  readonly place: (start: number, end: number) => TextRange | null;
}

export class ReadAloudSpeechText extends Context.Service<
  ReadAloudSpeechText,
  {
    /**
     * A block's markdown rewritten for speech, such as paths, hashes, and tables read as words,
     * or `plain` when there is no cleaner or it fails. A rewrite is cached on disk, so a block
     * always reads the same and its audio stays cached across restarts.
     */
    readonly speak: (markdown: string, plain: string) => Effect.Effect<SpokenBlock>;
    /** Starts rewriting a block that is read next. */
    readonly prepare: (markdown: string) => Effect.Effect<void>;
  }
>()("t3/speech/readAloudSpeechText") {}

const plainBlock = (plain: string): SpokenBlock => ({
  text: plain,
  place: (start, end) => ({ start, end }),
});

const plain = ReadAloudSpeechText.of({
  speak: Effect.fn("ReadAloudSpeechText.speak")((_markdown: string, text: string) =>
    Effect.succeed(plainBlock(text)),
  ),
  prepare: Effect.fn("ReadAloudSpeechText.prepare")(() => Effect.void),
});

const setting = (value: Option.Option<string>) =>
  Option.filter(
    Option.map(value, (text) => text.trim()),
    (text) => text !== "",
  );

/** Rewrites blocks with `cleaner`; `configuration` is what else changes its output. */
export const makeWithCleaner = Effect.fnUntraced(function* (
  cleaner: SpeechCleaner.SpeechCleaner["Service"],
  configuration: ReadonlyArray<string>,
) {
  const cache = yield* ReadAloudCache.ReadAloudCache;
  const scope = yield* Effect.scope;
  // Insertion order is recency order: a hit moves its entry to the end.
  const recent = new Map<string, Deferred.Deferred<ReadAloudCache.SpeechText | null>>();
  // Rewrites run in the background, so a reader that stops does not stop one others reuse.
  const start = Effect.fn("ReadAloudSpeechText.start")(function* (markdown: string) {
    const key = yield* cache.key("speech-text", [...configuration, markdown]);
    const existing = recent.get(key);
    if (existing) {
      recent.delete(key);
      recent.set(key, existing);
      return existing;
    }
    const rewrite = Deferred.makeUnsafe<ReadAloudCache.SpeechText | null>();
    recent.set(key, rewrite);
    for (const stale of recent.keys()) {
      if (recent.size <= RECENT_REWRITES) break;
      recent.delete(stale);
    }
    yield* Effect.gen(function* () {
      const cached = yield* cache.readSpeechText(key);
      if (Option.isSome(cached)) return cached.value;
      const result = yield* cleaner.replace(markdown);
      const entry = { text: result.text, narrated: result.narrated.length > 0 };
      // A rule that failed or timed out may succeed next time, so only a full rewrite is kept.
      if (result.skipped.length === 0) yield* cache.writeSpeechText(key, entry);
      return entry;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("read aloud could not rewrite a block for speech", { cause }).pipe(
          Effect.andThen(Effect.sync(() => recent.delete(key))),
          Effect.as(null),
        ),
      ),
      Effect.flatMap((entry) => Deferred.succeed(rewrite, entry)),
      Effect.forkIn(scope),
    );
    return rewrite;
  });

  return ReadAloudSpeechText.of({
    speak: Effect.fn("ReadAloudSpeechText.speak")(function* (markdown: string, text: string) {
      if (!markdown) return plainBlock(text);
      const rewrite = yield* Deferred.await(yield* start(markdown)).pipe(
        Effect.timeoutOption(REWRITE_WAIT),
        Effect.map(Option.flatMap(Option.fromNullishOr)),
      );
      if (Option.isNone(rewrite) || rewrite.value.text === markdown) return plainBlock(text);
      const spoken = readAloudSpeech(rewrite.value.text, false).text;
      if (!spoken.trim()) return plainBlock(text);
      return { text: spoken, place: spokenTextMap(text, spoken, rewrite.value.narrated) };
    }),
    prepare: Effect.fn("ReadAloudSpeechText.prepare")(function* (markdown: string) {
      if (markdown) yield* start(markdown);
    }),
  });
});

const make = Effect.gen(function* () {
  // The cleaner's classifier is Jev, as in the read-aloud prototype; narration needs a chat model.
  const env = yield* Config.all({
    jevApiKey: Config.String("TYPESAFE_API_KEY").pipe(Config.option),
    llmApiKey: Config.String("READ_ALOUD_LLM_API_KEY").pipe(Config.option),
    openAiApiKey: Config.String("OPENAI_API_KEY").pipe(Config.option),
    llmModel: Config.String("READ_ALOUD_LLM_MODEL").pipe(Config.option),
    llmBaseUrl: Config.String("READ_ALOUD_LLM_BASE_URL").pipe(Config.option),
  }).pipe(Effect.orDie);
  const jevApiKey = setting(env.jevApiKey);
  if (Option.isNone(jevApiKey)) return plain;
  const llmApiKey = Option.orElse(setting(env.llmApiKey), () => setting(env.openAiApiKey));
  const llmModel = setting(env.llmModel);
  const llmBaseUrl = Option.getOrElse(setting(env.llmBaseUrl), () => DEFAULT_LLM_BASE_URL);
  const narrator =
    Option.isSome(llmApiKey) && Option.isSome(llmModel)
      ? { apiKey: llmApiKey.value, model: llmModel.value }
      : null;
  const settings: ProviderSettings = {
    enabled: narrator !== null,
    codeEnabled: narrator !== null,
    hashEnabled: true,
    apiKey: Redacted.make(narrator ? narrator.apiKey : ""),
    apiUrl: llmBaseUrl,
    model: narrator ? narrator.model : "",
    classifier: {
      apiKey: Redacted.make(jevApiKey.value),
      model: JEV_DEFAULT_MODEL,
      apiUrl: JEV_DEFAULT_API_URL,
    },
  };
  // What changes a rewrite, without the keys, so a new key keeps the cached rewrites.
  const configuration = [
    CLEANER_VERSION,
    narrator ? `${settings.apiUrl} ${settings.model}` : "",
    `${JEV_DEFAULT_API_URL} ${JEV_DEFAULT_MODEL}`,
  ];
  const http = yield* HttpClient.HttpClient;
  const scope = yield* Effect.scope;
  const built = yield* Layer.buildWithScope(
    SpeechCleanerLive.layer(settings).pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
    ),
    scope,
  ).pipe(Effect.option);
  if (Option.isNone(built)) {
    yield* Effect.logWarning("read aloud could not build the speech cleaner");
    return plain;
  }
  return yield* makeWithCleaner(
    Context.get(built.value, SpeechCleaner.SpeechCleaner),
    configuration,
  );
});

export const layer = Layer.effect(ReadAloudSpeechText, make);

/** Reads every block as its plain text. */
export const layerPlain = Layer.succeed(ReadAloudSpeechText, plain);
