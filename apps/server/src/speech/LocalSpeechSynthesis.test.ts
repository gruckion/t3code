import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import type { SpeechSynthesisRequest } from "@t3tools/contracts";
import { AUDIO_CPP_ESPEAK_DATA, AUDIO_CPP_VERSION, audioCppRuntime } from "@t3tools/audio-cpp";
import { WORD_TIMING_MODEL_ID } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { expect, vi } from "vite-plus/test";
import * as ServerConfig from "../config.ts";
import * as LocalSpeechSynthesis from "./LocalSpeechSynthesis.ts";
import type { LocalSynthesisModel } from "./localSynthesisWorker.ts";
import * as ReadAloudCache from "./readAloudCache.ts";
import * as ReadAloudSpeechText from "./readAloudSpeechText.ts";
import * as SpeechModelStore from "./SpeechModelStore.ts";

// Two MPEG-1 Layer III frames at 64 kbps and 44.1 kHz.
const frame = Uint8Array.from({ length: 208 }, (_, index) =>
  index === 0 ? 0xff : index === 1 ? 0xfb : index === 2 ? 0x50 : 0,
);

/** A model that speaks each text as two MP3 frames and a tenth of a second of PCM. */
const worker = vi.hoisted(() => {
  const spoken: Array<string> = [];
  const model: LocalSynthesisModel = {
    backend: "cpu",
    languages: ["en"],
    alive: true,
    stream: async (request, onAudio, onPcm) => {
      const text = request.lines.map((line) => line.text).join(" ");
      spoken.push(text);
      onPcm?.(
        Int16Array.from({ length: 2_400 }, (_, index) => index),
        24_000,
        { start: 0, end: text.length },
      );
      onAudio(frame);
      onAudio(frame);
    },
    cancel: () => {},
    dispose: async () => {},
  };
  return { spoken, load: vi.fn(async () => model) };
});
vi.mock("./localSynthesisWorker.ts", () => ({ loadLocalSynthesisModel: worker.load }));

/** Runs `body` against the service, with an extracted runtime unless `runtime` is false. */
const withService = <A, E>(
  store: Partial<SpeechModelStore.SpeechModelStore["Service"]>,
  body: (
    service: LocalSpeechSynthesis.LocalSpeechSynthesis["Service"],
  ) => Effect.Effect<A, E, never>,
  options: {
    readonly runtime?: boolean;
    readonly cache?: Layer.Layer<ReadAloudCache.ReadAloudCache>;
    readonly speechText?: Layer.Layer<ReadAloudSpeechText.ReadAloudSpeechText>;
  } = {},
) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runtime = path.join(
      config.stateDir,
      "speech",
      "runtime",
      `audio-cpp-${AUDIO_CPP_VERSION}-darwin-arm64`,
    );
    if (options.runtime !== false) {
      yield* fs.makeDirectory(path.join(runtime, "libs"), { recursive: true });
      yield* fs.writeFileString(path.join(runtime, ".t3-complete"), AUDIO_CPP_VERSION);
      yield* fs.writeFileString(path.join(runtime, "libs", "libaudiocpp.0.1.0.dylib"), "");
    }
    return yield* body(yield* LocalSpeechSynthesis.LocalSpeechSynthesis);
  }).pipe(
    Effect.provide(
      LocalSpeechSynthesis.layer.pipe(
        Layer.provide(
          Layer.mock(SpeechModelStore.SpeechModelStore)({
            isReady: () => Effect.succeed(false),
            linkedFrom: () => Effect.undefined,
            ...store,
          }),
        ),
        Layer.provide(options.cache ?? ReadAloudCache.layerDisabled),
        Layer.provide(options.speechText ?? ReadAloudSpeechText.layerPlain),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-local-speech-" })),
        Layer.provide(SecureRandom.layerWebCrypto),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provideService(HostProcess.Architecture, "arm64"),
  );

it.effect("counts only the files an install still needs in its download size", () =>
  withService(
    {
      isReady: (file) =>
        Effect.succeed(
          file.id !== "pingdotgg/audio.cpp" && !file.filename.endsWith("-alba.safetensors"),
        ),
    },
    (service) =>
      Effect.gen(function* () {
        const runtime = audioCppRuntime("darwin", "arm64")!.size;
        const { models } = yield* service.catalog;
        expect(Object.fromEntries(models.map((model) => [model.id, model.install]))).toMatchObject({
          "kokoro-82m": { state: "downloadable", size: runtime + AUDIO_CPP_ESPEAK_DATA.size },
          "supertonic-3": { state: "downloadable", size: runtime },
          "pocket-tts-english": { state: "downloadable", size: runtime + 6_194_424 },
          // Each language has its own voice files.
          "pocket-tts-french": { state: "downloadable", size: runtime + 6_244_152 },
        });
      }),
    { runtime: false },
  ),
);

it.effect("links a model file already on this machine instead of downloading it", () =>
  Effect.gen(function* () {
    let linked = false;
    const download = vi.fn(() => Effect.succeed("/unused"));
    yield* withService(
      {
        download,
        link: (models, source) =>
          Effect.sync(() => {
            linked = source === "~/models";
            return linked ? models : [];
          }),
        isReady: () => Effect.sync(() => linked),
        linkedFrom: () => Effect.sync(() => (linked ? "/Users/me/models/model.gguf" : undefined)),
      },
      (service) =>
        Effect.gen(function* () {
          expect(yield* Effect.flip(service.link("~/elsewhere"))).toMatchObject({
            reason: "not-found",
          });
          const { models } = yield* service.link("~/models");
          expect(models[0]?.install).toMatchObject({
            state: "installed",
            linkedFrom: "/Users/me/models/model.gguf",
          });
          expect(download).not.toHaveBeenCalled();
        }),
    );
  }),
);

it.effect("completes the model a linked file belongs to, not another installed model", () =>
  Effect.gen(function* () {
    let linked: ReadonlyArray<SpeechModelStore.ModelFile> = [];
    const downloaded: Array<string> = [];
    yield* withService(
      {
        download: (file) => Effect.sync(() => (downloaded.push(file.filename), "/unused")),
        link: (files) =>
          Effect.sync(
            () => (linked = files.filter((file) => file.filename.endsWith("-alba.safetensors"))),
          ),
        isReady: (file) =>
          Effect.sync(() => file.filename.startsWith("supertonic") || linked.includes(file)),
      },
      (service) =>
        Effect.gen(function* () {
          yield* service.link("~/voices");
          expect(downloaded).toContain("PocketTTS-GGUF/english/pocket-tts-english-q8_0.gguf");
        }),
    );
  }),
);

it.effect("joins a second download of the same model instead of starting another install", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const download = vi.fn(() =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as("/unused"),
      ),
    );
    yield* withService({ download }, (service) =>
      Effect.gen(function* () {
        const first = yield* Effect.forkChild(service.download("supertonic-3"));
        const second = yield* Effect.forkChild(service.download("supertonic-3"));
        yield* Deferred.await(started);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        expect(download).toHaveBeenCalledTimes(1);
      }),
    );
  }),
);

it.effect("refuses a download or link while a removal deletes the shared runtime", () =>
  Effect.gen(function* () {
    const removing = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const download = vi.fn(() => Effect.succeed("/unused"));
    const linked = vi.fn();
    const link = () => Effect.sync(() => (linked(), []));
    yield* withService(
      {
        download,
        link,
        remove: () =>
          Deferred.succeed(removing, undefined).pipe(Effect.andThen(Deferred.await(release))),
      },
      (service) =>
        Effect.gen(function* () {
          const removal = yield* Effect.forkChild(service.remove("supertonic-3"));
          yield* Deferred.await(removing);
          expect(yield* Effect.flip(service.download("supertonic-3"))).toMatchObject({
            reason: "busy",
          });
          expect(yield* Effect.flip(service.link("~/models"))).toMatchObject({ reason: "busy" });
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(removal);
          expect(download).not.toHaveBeenCalled();
          expect(linked).not.toHaveBeenCalled();
        }),
    );
  }),
);

describe("read aloud cache for local models", () => {
  const text = "First block.\n\nSecond block.\n\nThird block.";
  const request = (from = 0): SpeechSynthesisRequest => {
    const blocks = text.split("\n\n");
    const start = text.indexOf(blocks[from]!);
    return {
      text: text.slice(start),
      model: "kokoro-82m",
      voice: "af_heart",
      speed: 1,
      language: "en-US",
      blocks: blocks.slice(from).map((block) => ({
        start: text.indexOf(block) - start,
        end: text.indexOf(block) - start + block.length,
        markdown: block,
      })),
    };
  };
  const installed = { installedPath: () => Effect.succeed("/models/installed") };

  const cacheIn = (directory: string) =>
    Layer.effect(ReadAloudCache.ReadAloudCache, ReadAloudCache.make(directory)).pipe(
      Layer.provide(NodeServices.layer),
    );

  /** A cleaner that rewrites `from` as `to`; `version` stands for its configuration. */
  const cleaning = (directory: string, version: string, from: string, to: string) =>
    Layer.effect(
      ReadAloudSpeechText.ReadAloudSpeechText,
      ReadAloudSpeechText.makeWithCleaner(
        Effect.succeed({
          service: {
            replace: (markdown: string) =>
              Effect.succeed({
                text: markdown === from ? to : markdown,
                applied: markdown === from,
                changes: markdown === from ? ["rewrite"] : [],
                narrated: [],
                skipped: [],
              }),
          },
          configuration: [version],
        }),
      ),
    ).pipe(Layer.provide(cacheIn(directory)));

  /** Plays `input` through a fresh service on `directory`, as after a server restart. */
  const play = (
    directory: string,
    input: SpeechSynthesisRequest,
    speechText: Layer.Layer<ReadAloudSpeechText.ReadAloudSpeechText> = ReadAloudSpeechText.layerPlain,
  ) =>
    withService(
      installed,
      (service) =>
        service.stream(input).pipe(
          Stream.runCollect,
          Effect.map((parts) => ({
            audio: parts.filter((part) => part instanceof Uint8Array),
            pcm: parts.flatMap((part) => ("pcm" in part ? [part] : [])),
          })),
        ),
      { cache: cacheIn(directory), speechText },
    );

  const tempDirectory = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.makeTempDirectoryScoped({ prefix: "t3-read-aloud-local-" });
  });

  it.effect("synthesizes each block once, and replays its audio and PCM without the model", () =>
    Effect.gen(function* () {
      worker.load.mockClear();
      worker.spoken.length = 0;
      const directory = yield* tempDirectory;
      const fs = yield* FileSystem.FileSystem;

      const first = yield* play(directory, request());
      expect(worker.spoken).toEqual(["First block.", "Second block.", "Third block."]);
      expect(worker.load).toHaveBeenCalledTimes(1);
      // An MP3, a PCM, and a JSON file for each block.
      expect((yield* fs.readDirectory(directory)).length).toBe(9);
      // Each block's PCM starts where its audio does, so the aligner times it in place.
      expect(first.pcm.map((part) => part.startSeconds)).toEqual([
        0,
        (2 * 1152) / 44_100,
        (4 * 1152) / 44_100,
      ]);

      const replay = yield* play(directory, request());
      expect(worker.load).toHaveBeenCalledTimes(1);
      expect(worker.spoken).toHaveLength(3);
      expect(Buffer.concat(replay.audio)).toEqual(Buffer.concat(first.audio));
      expect(replay.pcm).toEqual(first.pcm);

      // Reading from a clicked block finds the blocks it reads cached too.
      const jump = yield* play(directory, request(1));
      expect(worker.load).toHaveBeenCalledTimes(1);
      expect(jump.pcm.map((part) => part.startSeconds)).toEqual([0, (2 * 1152) / 44_100]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keys audio on the voice and on the speed the model applies", () =>
    Effect.gen(function* () {
      worker.spoken.length = 0;
      const directory = yield* tempDirectory;
      yield* play(directory, request(2));
      yield* play(directory, { ...request(2), voice: "am_adam" });
      yield* play(directory, { ...request(2), speed: 1.3 });
      yield* play(directory, { ...request(2), speed: 1.3 });
      expect(worker.spoken).toEqual(["Third block.", "Third block.", "Third block."]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("speaks a block's cleaned text and caches the audio by that text", () =>
    Effect.gen(function* () {
      worker.load.mockClear();
      worker.spoken.length = 0;
      const directory = yield* tempDirectory;
      const cleaned = cleaning(directory, "v1", "Second block.", "The second block, cleaned.");
      yield* play(directory, request(1), cleaned);
      // Only the block the cleaner rewrites reads differently.
      expect(worker.spoken).toEqual(["The second block, cleaned.", "Third block."]);

      // A replay after a restart reads the cached rewrite and its cached audio.
      yield* play(directory, request(1), cleaning(directory, "v1", "Second block.", "unused"));
      expect(worker.spoken).toHaveLength(2);
      expect(worker.load).toHaveBeenCalledTimes(1);

      // Without the cleaner, or with a cleaner that rewrites it otherwise, the block is new audio.
      yield* play(directory, request(1));
      yield* play(directory, request(1), cleaning(directory, "v2", "Second block.", "Block two."));
      expect(worker.spoken.slice(2)).toEqual(["Second block.", "Block two."]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

it.effect("keeps eSpeak data and voice clips while another installed model reads them", () =>
  Effect.gen(function* () {
    const removed: Array<string> = [];
    const installed = ["kokoro-82m", "Qwen3-TTS-12Hz-1.7B-Base", "CosyVoice3"];
    yield* withService(
      {
        isReady: (file) =>
          Effect.succeed(
            !file.filename.startsWith("Piper") &&
              !file.filename.startsWith("Qwen3-TTS-12Hz-0.6B") &&
              (installed.some((name) => file.filename.toLowerCase().includes(name.toLowerCase())) ||
                file.id === "pingdotgg/audio.cpp"),
          ),
        remove: (file) => Effect.sync(() => void removed.push(file.filename)),
      },
      (service) =>
        Effect.gen(function* () {
          yield* service.remove("piper-lessac");
          yield* service.remove("qwen3-tts-0.6b");
          expect(removed).toEqual([
            "Piper-TTS-GGUF/piper-en-us-lessac-medium-orig.gguf",
            "Qwen3-TTS-12Hz-0.6B-Base-GGUF/qwen3-tts-12hz-0.6b-base-q8_0.gguf",
          ]);
        }),
    );
  }),
);

it.effect(
  "installs and removes the word timing model like a model, with the runtime it needs",
  () =>
    Effect.gen(function* () {
      const ready = new Set<string>();
      const removed: Array<string> = [];
      yield* withService(
        {
          isReady: (file) => Effect.sync(() => ready.has(file.filename)),
          installedPath: (file) =>
            Effect.sync(() => (ready.has(file.filename) ? `/models/${file.filename}` : undefined)),
          download: (file) => Effect.sync(() => (ready.add(file.filename), "/unused")),
          remove: (file) =>
            Effect.sync(() => {
              ready.delete(file.filename);
              removed.push(file.filename);
            }),
        },
        (service) =>
          Effect.gen(function* () {
            expect(yield* service.wordTiming).toEqual({ state: "downloadable", size: 205_171_744 });
            yield* service.download(WORD_TIMING_MODEL_ID);
            expect(yield* service.wordTiming).toEqual({ state: "installed", size: 205_171_744 });
            // No installed voice uses the runtime, so removing the model removes it too.
            yield* service.remove(WORD_TIMING_MODEL_ID);
            expect(removed).toEqual(["mms-forced-aligner-q4_k.gguf"]);
            expect(yield* service.wordTiming).toEqual({
              state: "downloadable",
              size: 205_171_744 + audioCppRuntime("darwin", "arm64")!.size,
            });
          }),
      );
    }),
);
