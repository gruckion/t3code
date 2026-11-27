import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import type { SpeechSynthesisRequest } from "@t3tools/contracts";
import { readAloudSpeech } from "@t3tools/shared/read-aloud";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { expect, vi } from "vite-plus/test";

import * as ServerSettings from "../serverSettings.ts";
import type { ReplacementResult } from "./cleaner/engine/Replacer.ts";
import * as SpeechCleaner from "./cleaner/engine/SpeechCleaner.ts";
import * as CloudSpeech from "./CloudSpeech.ts";
import * as ReadAloudCache from "./readAloudCache.ts";
import * as ReadAloudSpeechText from "./readAloudSpeechText.ts";

const rewrite = (text: string, skipped: ReadonlyArray<string> = []): ReplacementResult => ({
  text,
  applied: true,
  changes: ["test"],
  narrated: [],
  skipped,
});

/** A cleaner that reads paths as words, as the real `filePaths` rule does. */
const pathsCleaner = (replace: (markdown: string) => Effect.Effect<ReplacementResult>) =>
  SpeechCleaner.SpeechCleaner.of({ replace });
const readPaths = (markdown: string) =>
  Effect.succeed(rewrite(markdown.replace(/`([^`]+)\/([^`]+)`/g, "`$1 $2`")));

const tempDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "t3-read-aloud-text-" });
}).pipe(Effect.provide(NodeServices.layer));

const cacheIn = (directory: string) =>
  Layer.effect(ReadAloudCache.ReadAloudCache, ReadAloudCache.make(directory)).pipe(
    Layer.provide(NodeServices.layer),
  );

const withCleaner = (directory: string, cleaner: SpeechCleaner.SpeechCleaner["Service"]) =>
  Layer.effect(
    ReadAloudSpeechText.ReadAloudSpeechText,
    ReadAloudSpeechText.makeWithCleaner(
      Effect.succeed({ service: cleaner, configuration: ["test"] }),
    ),
  ).pipe(Layer.provide(cacheIn(directory)));

const speak = (markdown: string, plain: string) =>
  ReadAloudSpeechText.ReadAloudSpeechText.use((service) => service.speak(markdown, plain)).pipe(
    Effect.map((block) => ({
      text: block.text,
      words: [...block.text.matchAll(/\S+/g)].map((match) => {
        const at = block.place(match.index, match.index + match[0].length);
        return at && plain.slice(at.start, at.end);
      }),
    })),
  );

describe("read aloud speech text", () => {
  it.effect(
    "turns on from settings without a restart, and a rule toggled off reads as written",
    () =>
      Effect.gen(function* () {
        const directory = yield* tempDirectory;
        const upstream = vi.fn<typeof fetch>(async () => new Response("offline", { status: 503 }));
        const program = Effect.gen(function* () {
          const settings = yield* ServerSettings.ServerSettingsService;
          // No Jev key in settings or the environment: the rules that need no model still run.
          expect((yield* speak("Open `src/main.ts`.", "Open src/main.ts.")).text).toBe(
            "Open src main.ts.",
          );
          yield* settings.updateSettings({ readAloudCleaner: { jevApiKey: "jev-key" } });
          expect((yield* speak("Open `src/fourth.ts`.", "Open src/fourth.ts.")).text).toBe(
            "Open src fourth.ts.",
          );
          yield* settings.updateSettings({ readAloudCleaner: { disabledRules: ["file-paths"] } });
          expect((yield* speak("Open `src/other.ts`.", "Open src/other.ts.")).text).toBe(
            "Open src/other.ts.",
          );
          yield* settings.updateSettings({ readAloudCleaner: { jevApiKey: "" } });
          expect((yield* speak("Open `src/third.ts`.", "Open src/third.ts.")).text).toBe(
            "Open src/third.ts.",
          );
          yield* settings.updateSettings({ readAloudCleaner: { disabledRules: [] } });
          expect((yield* speak("At 4,064,078 rows.", "At 4,064,078 rows.")).text).toBe(
            "At four million sixty-four thousand seventy-eight rows.",
          );
        });
        yield* program.pipe(
          Effect.provide(
            ReadAloudSpeechText.layer.pipe(
              Layer.provideMerge(ServerSettings.ServerSettingsService.layerTest()),
              Layer.provide(cacheIn(directory)),
              Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
              Layer.provide(FetchHttpClient.layer),
              Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
            ),
          ),
          Effect.provideService(FetchHttpClient.Fetch, upstream),
        );
        // Paths need no classifier, so nothing left this machine.
        expect(upstream).not.toHaveBeenCalled();
      }).pipe(Effect.scoped),
  );

  it.effect("rewrites a block once and reads the cached rewrite after a restart", () =>
    Effect.gen(function* () {
      const directory = yield* tempDirectory;
      const replace = vi.fn(readPaths);
      const first = yield* speak("Open `src/main.ts`.", "Open src/main.ts.").pipe(
        Effect.provide(withCleaner(directory, pathsCleaner(replace))),
      );
      expect(first).toEqual({
        text: "Open src main.ts.",
        words: ["Open", "src/main.ts.", "src/main.ts."],
      });
      // A cleaner that would now answer differently is not asked: the block reads the same.
      const changed = vi.fn(() => Effect.succeed(rewrite("Something else.")));
      const again = yield* speak("Open `src/main.ts`.", "Open src/main.ts.").pipe(
        Effect.provide(withCleaner(directory, pathsCleaner(changed))),
      );
      expect(again).toEqual(first);
      expect(replace).toHaveBeenCalledTimes(1);
      expect(changed).not.toHaveBeenCalled();
    }).pipe(Effect.scoped),
  );

  it.effect("falls back to plain text when the cleaner fails, and keeps no partial rewrite", () =>
    Effect.gen(function* () {
      const directory = yield* tempDirectory;
      const failing = pathsCleaner(() => Effect.die(new Error("cleaner down")));
      expect(
        yield* speak("Open `src/main.ts`.", "Open src/main.ts.").pipe(
          Effect.provide(withCleaner(directory, failing)),
        ),
      ).toMatchObject({ text: "Open src/main.ts." });
      const skipped = vi.fn((markdown: string) =>
        readPaths(markdown).pipe(Effect.map((result) => ({ ...result, skipped: ["hashes"] }))),
      );
      yield* speak("Open `src/main.ts`.", "Open src/main.ts.").pipe(
        Effect.provide(withCleaner(directory, pathsCleaner(skipped))),
      );
      yield* speak("Open `src/main.ts`.", "Open src/main.ts.").pipe(
        Effect.provide(withCleaner(directory, pathsCleaner(skipped))),
      );
      expect(skipped).toHaveBeenCalledTimes(2);
    }).pipe(Effect.scoped),
  );

  it.effect("speaks the rewrite and highlights the words of the request it replaced", () =>
    Effect.gen(function* () {
      const directory = yield* tempDirectory;
      const markdown = "Intro here.\n\nOpen `src/main.ts` now.\n\nThe end.";
      const speech = readAloudSpeech(markdown, true);
      const request: SpeechSynthesisRequest = {
        text: speech.text,
        model: "",
        voice: "",
        speed: 1,
        language: "en",
        blocks: speech.blocks.map((block) => ({
          start: block.spokenStart,
          end: block.spokenEnd,
          markdown: block.markdown,
        })),
      };
      const upstream = vi.fn<typeof fetch>(async (_url, init) => {
        const { text } = JSON.parse(String(init?.body)) as { text: string };
        const characters = Array.from(text);
        return new Response(
          JSON.stringify({
            audio_base64: Buffer.from([0xff, 0xfb, 0x50, 0]).toString("base64"),
            alignment: {
              characters,
              character_start_times_seconds: characters.map((_, index) => index / 100),
              character_end_times_seconds: characters.map((_, index) => (index + 1) / 100),
            },
          }),
        );
      });
      const read = Effect.gen(function* () {
        const service = yield* CloudSpeech.CloudSpeech;
        yield* service.setKey("elevenlabs", Redacted.make("speech-key"));
        return yield* service.stream("elevenlabs", request).pipe(
          Stream.runCollect,
          Effect.map((parts) =>
            parts
              .flatMap((part) => ("words" in part ? part.words : []))
              .map((word) => request.text.slice(word.start, word.end)),
          ),
        );
      }).pipe(
        Effect.provide(
          CloudSpeech.layer.pipe(
            Layer.provide(withCleaner(directory, pathsCleaner(readPaths))),
            Layer.provide(cacheIn(directory)),
            Layer.provide(NodeServices.layer),
            Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
          ),
        ),
        Effect.provideService(FetchHttpClient.Fetch, upstream),
      );
      const words = yield* read;
      expect(
        upstream.mock.calls.map(
          ([, init]) => (JSON.parse(String(init?.body)) as { text: string }).text,
        ),
      ).toEqual(["Intro here.", "Open src main.ts now.", "The end."]);
      expect(words).toEqual([
        "Intro",
        "here.",
        "Open",
        "src/main.ts",
        "src/main.ts",
        "now.",
        "The",
        "end.",
      ]);
      // The rewrite and its audio are cached, so reading again sends nothing.
      expect(yield* read).toEqual(words);
      expect(upstream).toHaveBeenCalledTimes(3);
    }).pipe(Effect.scoped),
  );
});
