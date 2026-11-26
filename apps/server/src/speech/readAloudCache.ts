import { SpeechSynthesisWord } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import type { SpeechSynthesisPart } from "./CloudSpeech.ts";

/** Change it when cached audio or text must no longer be read, such as a new word format. */
const CACHE_VERSION = 2;

export const readAloudCacheDirectory = (path: Path.Path, stateDir: string) =>
  path.join(stateDir, "caches", "read-aloud");

const CachedWords = Schema.fromJsonString(
  Schema.Struct({
    words: Schema.Array(SpeechSynthesisWord),
    /** The sample rate of the entry's PCM file, when it has one. */
    pcmRate: Schema.optionalKey(Schema.Number),
  }),
);
/** A block's markdown rewritten for speech; `narrated` when a model summarized it. */
export const SpeechText = Schema.Struct({ text: Schema.String, narrated: Schema.Boolean });
export type SpeechText = typeof SpeechText.Type;
const CachedSpeechText = Schema.fromJsonString(SpeechText);
const decodeWords = Schema.decodeUnknownOption(CachedWords);
const encodeWords = Schema.encodeSync(CachedWords);
const decodeSpeechText = Schema.decodeUnknownOption(CachedSpeechText);
const encodeSpeechText = Schema.encodeSync(CachedSpeechText);

export interface CachedAudio {
  readonly audio: Uint8Array;
  /** Words with offsets in the text that was synthesized and seconds into `audio`. */
  readonly words: ReadonlyArray<SpeechSynthesisWord>;
  /** Mono PCM the MP3 was encoded from, so words the provider did not time are timed again. */
  readonly pcm?: { readonly samples: Int16Array; readonly rate: number };
}

/**
 * Synthesized speech and speech text on disk, so a replay or a jump does not pay a provider again.
 * Reads and writes never fail: a broken entry is a miss. Storage cleanup caps the size.
 */
export class ReadAloudCache extends Context.Service<
  ReadAloudCache,
  {
    /** A sha256 hex key over everything that changes the cached result. */
    readonly key: (
      kind: "audio" | "speech-text",
      parts: ReadonlyArray<string>,
    ) => Effect.Effect<string>;
    readonly readAudio: (key: string) => Effect.Effect<Option.Option<CachedAudio>>;
    readonly writeAudio: (key: string, entry: CachedAudio) => Effect.Effect<void>;
    readonly readSpeechText: (key: string) => Effect.Effect<Option.Option<SpeechText>>;
    readonly writeSpeechText: (key: string, entry: SpeechText) => Effect.Effect<void>;
  }
>()("t3/speech/readAloudCache") {}

const KEY = /^[0-9a-f]{64}$/;

export const make = Effect.fnUntraced(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const digest = yield* Effect.service(Digest.Digest).pipe(Effect.provide(Digest.layerWebCrypto));
  const random = yield* Effect.service(SecureRandom.SecureRandom).pipe(
    Effect.provide(SecureRandom.layerWebCrypto),
  );
  const key = (kind: "audio" | "speech-text", parts: ReadonlyArray<string>) =>
    digest.digestHex(
      Digest.sha256,
      new TextEncoder().encode([kind, String(CACHE_VERSION), ...parts].join("\u0000")),
    );
  const files = (key: string) =>
    KEY.test(key)
      ? {
          audio: path.join(directory, `${key}.mp3`),
          words: path.join(directory, `${key}.json`),
          pcm: path.join(directory, `${key}.pcm`),
          speechText: path.join(directory, `${key}.text.json`),
        }
      : null;
  // Touching marks an entry used, so the size cap removes the least recently used first.
  const touch = Effect.fnUntraced(function* (paths: ReadonlyArray<string>) {
    const now = DateTime.toDateUtc(yield* DateTime.now);
    return yield* Effect.forEach(paths, (file) => fs.utimes(file, now, now)).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  });
  const writeAtomically = Effect.fnUntraced(function* (target: string, bytes: Uint8Array) {
    const temporary = `${target}.${yield* random.uuidV4()}.tmp`;
    yield* fs.writeFile(temporary, bytes);
    yield* fs.rename(temporary, target);
  });
  const ignoreFailure = (what: string) =>
    Effect.catch((cause: unknown) =>
      Effect.logWarning(`read aloud could not cache ${what}`, { cause }),
    );

  const readAudio = Effect.fn("ReadAloudCache.readAudio")(function* (key: string) {
    const paths = files(key);
    if (!paths || !(yield* touch([paths.audio, paths.words]))) return Option.none<CachedAudio>();
    const words = Option.flatMap(
      yield* fs.readFileString(paths.words).pipe(Effect.option),
      decodeWords,
    );
    const audio = yield* fs.readFile(paths.audio).pipe(Effect.option);
    if (Option.isNone(words) || Option.isNone(audio) || audio.value.byteLength === 0)
      return Option.none<CachedAudio>();
    const rate = words.value.pcmRate;
    if (rate === undefined) return Option.some({ audio: audio.value, words: words.value.words });
    const pcm = yield* fs.readFile(paths.pcm).pipe(Effect.option);
    if (Option.isNone(pcm) || !(yield* touch([paths.pcm])) || pcm.value.byteLength % 2 !== 0)
      return Option.none<CachedAudio>();
    // Copied, so the samples start on a boundary an Int16Array can view.
    const samples = new Int16Array(pcm.value.slice().buffer);
    return Option.some({ audio: audio.value, words: words.value.words, pcm: { samples, rate } });
  });

  const writeAudio = Effect.fn("ReadAloudCache.writeAudio")(function* (
    key: string,
    entry: CachedAudio,
  ) {
    const paths = files(key);
    if (!paths) return;
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* writeAtomically(paths.audio, entry.audio);
    if (entry.pcm)
      yield* writeAtomically(
        paths.pcm,
        new Uint8Array(
          entry.pcm.samples.buffer,
          entry.pcm.samples.byteOffset,
          entry.pcm.samples.byteLength,
        ),
      );
    // Written last: a hit needs every file, so a crash in between reads as a miss.
    yield* writeAtomically(
      paths.words,
      new TextEncoder().encode(
        encodeWords({
          words: entry.words,
          ...(entry.pcm ? { pcmRate: entry.pcm.rate } : {}),
        }),
      ),
    );
  }, ignoreFailure("speech audio"));

  const readSpeechText = Effect.fn("ReadAloudCache.readSpeechText")(function* (key: string) {
    const paths = files(key);
    if (!paths || !(yield* touch([paths.speechText]))) return Option.none<SpeechText>();
    return Option.flatMap(
      yield* fs.readFileString(paths.speechText).pipe(Effect.option),
      decodeSpeechText,
    );
  });

  const writeSpeechText = Effect.fn("ReadAloudCache.writeSpeechText")(function* (
    key: string,
    entry: SpeechText,
  ) {
    const paths = files(key);
    if (!paths) return;
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* writeAtomically(paths.speechText, new TextEncoder().encode(encodeSpeechText(entry)));
  }, ignoreFailure("speech text"));

  return ReadAloudCache.of({ key, readAudio, writeAudio, readSpeechText, writeSpeechText });
});

export const layer = Layer.effect(
  ReadAloudCache,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return yield* make(readAloudCacheDirectory(path, config.stateDir));
  }),
);

function joinBytes(chunks: ReadonlyArray<Uint8Array>) {
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function joinSamples(chunks: ReadonlyArray<Int16Array>) {
  const samples = new Int16Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }
  return samples;
}

/** A cached piece as synthesis parts. The PCM goes first, so words it lacks are timed again. */
export const replayAudio = ({ audio, words, pcm }: CachedAudio) =>
  Stream.fromIterable<SpeechSynthesisPart>([
    ...(pcm ? [{ pcm: pcm.samples, rate: pcm.rate, startSeconds: 0 }] : []),
    ...(words.length ? [{ words }] : []),
    audio,
  ]);

/** Caches a piece once its parts stream to their end; a stopped piece is synthesized again. */
export const recordAudio = <E, R>(
  cache: ReadAloudCache["Service"],
  key: string,
  parts: Stream.Stream<SpeechSynthesisPart, E, R>,
) =>
  Stream.suspend(() => {
    const recorded = {
      audio: new Array<Uint8Array>(),
      words: new Array<SpeechSynthesisWord>(),
      pcm: new Array<Int16Array>(),
      rate: 0,
    };
    return parts.pipe(
      Stream.tap((part) =>
        Effect.sync(() => {
          if (part instanceof Uint8Array) recorded.audio.push(part);
          else if ("pcm" in part) {
            // A piece's PCM arrives in order from its start, at one rate.
            recorded.pcm.push(part.pcm);
            recorded.rate = part.rate;
          } else recorded.words.push(...part.words);
        }),
      ),
      Stream.onEnd(
        Effect.suspend(() =>
          recorded.audio.length
            ? cache.writeAudio(key, {
                audio: joinBytes(recorded.audio),
                words: recorded.words,
                ...(recorded.pcm.length
                  ? { pcm: { samples: joinSamples(recorded.pcm), rate: recorded.rate } }
                  : {}),
              })
            : Effect.void,
        ),
      ),
    );
  });

/** Caches nothing, for tests of the uncached paths. */
export const layerDisabled = Layer.succeed(
  ReadAloudCache,
  ReadAloudCache.of({
    key: Effect.fn("ReadAloudCache.key")((kind) => Effect.succeed(kind)),
    readAudio: Effect.fn("ReadAloudCache.readAudio")(() => Effect.succeedNone),
    writeAudio: Effect.fn("ReadAloudCache.writeAudio")(() => Effect.void),
    readSpeechText: Effect.fn("ReadAloudCache.readSpeechText")(() => Effect.succeedNone),
    writeSpeechText: Effect.fn("ReadAloudCache.writeSpeechText")(() => Effect.void),
  }),
);
