import type { SettingsSecretValue } from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import { readAloudSpeech } from "@t3tools/shared/read-aloud";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { HttpClient } from "effect/http";

import * as ServerSettings from "../serverSettings.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import { JEV_DEFAULT_API_URL, JEV_DEFAULT_MODEL } from "./cleaner/ai/ClassifierSettings.ts";
import type { ProviderSettings } from "./cleaner/ai/Provider.ts";
import * as SpeechCleaner from "./cleaner/engine/SpeechCleaner.ts";
import * as SpeechCleanerLive from "./cleaner/SpeechCleanerLive.ts";
import * as ReadAloudCache from "./readAloudCache.ts";
import { spokenTextMap, type TextRange } from "./spokenTextMap.ts";

/** Change it when the cleaner's rules change, so cached rewrites are made again. */
const CLEANER_VERSION = "3";
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

/** A built cleaner and what, besides a block's markdown, changes its rewrites. */
export interface Cleaner {
  readonly service: SpeechCleaner.SpeechCleaner["Service"];
  readonly configuration: ReadonlyArray<string>;
}

/** Rewrites blocks with the cleaner `current` gives for each block, or reads them plain. */
export const makeWithCleaner = Effect.fnUntraced(function* (
  current: Effect.Effect<Cleaner | null>,
) {
  const cache = yield* ReadAloudCache.ReadAloudCache;
  const scope = yield* Effect.scope;
  // Insertion order is recency order: a hit moves its entry to the end.
  const recent = new Map<string, Deferred.Deferred<ReadAloudCache.SpeechText | null>>();
  // Rewrites run in the background, so a reader that stops does not stop one others reuse.
  const start = Effect.fn("ReadAloudSpeechText.start")(function* (
    markdown: string,
    cleaner: Cleaner,
  ) {
    const key = yield* cache.key("speech-text", [...cleaner.configuration, markdown]);
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
      const result = yield* cleaner.service.replace(markdown);
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
      const cleaner = yield* current;
      if (!cleaner) return plainBlock(text);
      const rewrite = yield* Deferred.await(yield* start(markdown, cleaner)).pipe(
        Effect.timeoutOption(REWRITE_WAIT),
        Effect.map(Option.flatMap(Option.fromNullishOr)),
      );
      if (Option.isNone(rewrite) || rewrite.value.text === markdown) return plainBlock(text);
      const spoken = readAloudSpeech(rewrite.value.text, false).text;
      if (!spoken.trim()) return plainBlock(text);
      return { text: spoken, place: spokenTextMap(text, spoken, rewrite.value.narrated) };
    }),
    prepare: Effect.fn("ReadAloudSpeechText.prepare")(function* (markdown: string) {
      if (!markdown) return;
      const cleaner = yield* current;
      if (cleaner) yield* start(markdown, cleaner);
    }),
  });
});

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const resolver = yield* SecretResolver.SecretResolver;
  const http = yield* HttpClient.HttpClient;
  const layerScope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  let built: {
    readonly fingerprint: string;
    readonly cleaner: Cleaner;
    scope: Scope.Closeable;
  } | null = null;
  const secret = (value: SettingsSecretValue) =>
    value === ""
      ? Effect.succeedNone
      : requireSettingsSecret(resolver, value).pipe(
          Effect.asSome,
          Effect.orElseSucceed(Option.none),
        );
  // Settings first, then the environment, read for each block so a change needs no restart.
  const current = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(Effect.option);
    if (Option.isNone(settings)) return null;
    const saved = settings.value.readAloudCleaner;
    const env = yield* Config.all({
      jevApiKey: Config.String("TYPESAFE_API_KEY").pipe(Config.option),
      llmApiKey: Config.String("READ_ALOUD_LLM_API_KEY").pipe(Config.option),
      openAiApiKey: Config.String("OPENAI_API_KEY").pipe(Config.option),
      llmModel: Config.String("READ_ALOUD_LLM_MODEL").pipe(Config.option),
      llmBaseUrl: Config.String("READ_ALOUD_LLM_BASE_URL").pipe(Config.option),
    }).pipe(Effect.orDie);
    const jevApiKey = Option.orElse(setting(yield* secret(saved.jevApiKey)), () =>
      setting(env.jevApiKey),
    );
    // Without Jev only hash recognition is off: the other rules run on this machine.
    const jev = Option.getOrNull(jevApiKey);
    const llmApiKey = Option.orElse(setting(yield* secret(saved.narrationApiKey)), () =>
      Option.orElse(setting(env.llmApiKey), () => setting(env.openAiApiKey)),
    );
    const llmModel = Option.orElse(setting(Option.some(saved.narrationModel)), () =>
      setting(env.llmModel),
    );
    const llmBaseUrl = Option.getOrElse(
      Option.orElse(setting(Option.some(saved.narrationBaseUrl)), () => setting(env.llmBaseUrl)),
      () => DEFAULT_LLM_BASE_URL,
    );
    const narrator =
      Option.isSome(llmApiKey) && Option.isSome(llmModel)
        ? { apiKey: llmApiKey.value, model: llmModel.value }
        : null;
    const disabledRules = [...saved.disabledRules].sort();
    // What changes a rewrite, without the keys, so a new key keeps the cached rewrites.
    const configuration = [
      CLEANER_VERSION,
      narrator ? `${llmBaseUrl} ${narrator.model}` : "",
      jev === null ? "no hash classifier" : `${JEV_DEFAULT_API_URL} ${JEV_DEFAULT_MODEL}`,
      `off: ${disabledRules.join(",")}`,
    ];
    const fingerprint = [
      ...configuration,
      jev === null ? "" : jev,
      narrator ? narrator.apiKey : "",
    ].join("\u0000");
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        if (built?.fingerprint === fingerprint) return built.cleaner;
        const settings: ProviderSettings = {
          enabled: narrator !== null,
          codeEnabled: narrator !== null,
          hashEnabled: jev !== null,
          apiKey: Redacted.make(narrator ? narrator.apiKey : ""),
          apiUrl: llmBaseUrl,
          model: narrator ? narrator.model : "",
          ...(jev === null
            ? {}
            : {
                classifier: {
                  apiKey: Redacted.make(jev),
                  model: JEV_DEFAULT_MODEL,
                  apiUrl: JEV_DEFAULT_API_URL,
                },
              }),
        };
        const scope = yield* Scope.fork(layerScope);
        const context = yield* Layer.buildWithScope(
          SpeechCleanerLive.layer(settings, undefined, disabledRules).pipe(
            Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
          ),
          scope,
        ).pipe(Effect.option);
        if (Option.isNone(context)) {
          yield* Scope.close(scope, Exit.void);
          yield* Effect.logWarning("read aloud could not build the speech cleaner");
          return null;
        }
        const previous = built;
        built = {
          fingerprint,
          cleaner: {
            service: Context.get(context.value, SpeechCleaner.SpeechCleaner),
            configuration,
          },
          scope,
        };
        if (previous) yield* Scope.close(previous.scope, Exit.void);
        return built.cleaner;
      }),
    );
  });
  return yield* makeWithCleaner(current);
});

export const layer = Layer.effect(ReadAloudSpeechText, make);

/** Reads every block as its plain text. */
export const layerPlain = Layer.succeed(ReadAloudSpeechText, plain);
