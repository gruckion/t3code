import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import type { CloudSpeechSynthesisProvider, SpeechSynthesisRequest } from "@t3tools/contracts";
import { readAloudSpeech } from "@t3tools/shared/read-aloud";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { expect, vi } from "vite-plus/test";

import * as ServerSettings from "../serverSettings.ts";
import * as CloudSpeech from "./CloudSpeech.ts";
import * as LocalSpeechSynthesis from "./LocalSpeechSynthesis.ts";
import * as ReadAloudCache from "./readAloudCache.ts";
import * as ReadAloudSpeechText from "./readAloudSpeechText.ts";
import * as SpeechAligner from "./SpeechAligner.ts";
import * as SpeechSynthesisStreams from "./synthesisStreams.ts";

// Two MPEG-1 Layer III frames at 64 kbps and 44.1 kHz.
const frame = Uint8Array.from({ length: 208 }, (_, index) =>
  index === 0 ? 0xff : index === 1 ? 0xfb : index === 2 ? 0x50 : 0,
);

/** ElevenLabs with character timings for the text it is sent, or xAI's PCM. */
const provider = () =>
  vi.fn<typeof fetch>(async (url, init) => {
    if (!String(url).includes("elevenlabs"))
      return new Response(Uint8Array.from([...frame, ...frame]), {
        headers: { "content-type": "audio/mpeg" },
      });
    const { text } = JSON.parse(String(init?.body)) as { text: string };
    const characters = Array.from(text);
    return new Response(
      [
        {
          audio_base64: null,
          alignment: {
            characters,
            character_start_times_seconds: characters.map((_, index) => index / 100),
            character_end_times_seconds: characters.map((_, index) => (index + 1) / 100),
          },
        },
        { audio_base64: Buffer.from([...frame, ...frame]).toString("base64"), alignment: null },
      ]
        .map((chunk) => JSON.stringify(chunk))
        .join("\n"),
    );
  });

const sentTexts = (upstream: ReturnType<typeof provider>) =>
  upstream.mock.calls.map(
    ([, init]) => (JSON.parse(String(init?.body)) as { text?: string; input?: string }).text,
  );

/** What a client sends to read `markdown` from block `from`, as the read-aloud controller does. */
function readFrom(markdown: string, from = 0): SpeechSynthesisRequest {
  const speech = readAloudSpeech(markdown, true);
  const start = speech.blocks[from]?.spokenStart ?? 0;
  return {
    text: speech.text.slice(start),
    model: "",
    voice: "",
    speed: 1,
    language: "en",
    blocks: speech.blocks.slice(from).map((block) => ({
      start: block.spokenStart - start,
      end: block.spokenEnd - start,
      markdown: block.markdown,
    })),
  };
}

const withCache = (directory: string) =>
  CloudSpeech.layer.pipe(
    Layer.provide(ReadAloudSpeechText.layerPlain),
    Layer.provide(Layer.effect(ReadAloudCache.ReadAloudCache, ReadAloudCache.make(directory))),
    Layer.provide(NodeServices.layer),
    Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
  );

/** Reads a request through a fresh service on `directory`, as after a server restart. */
const read = (
  directory: string,
  upstream: typeof fetch,
  request: SpeechSynthesisRequest,
  cloud: CloudSpeechSynthesisProvider = "elevenlabs",
) =>
  Effect.gen(function* () {
    const service = yield* CloudSpeech.CloudSpeech;
    yield* service.setKey(cloud, Redacted.make("speech-key"));
    const parts = yield* service.stream(cloud, request).pipe(Stream.runCollect);
    return {
      audio: parts.reduce((size, part) => size + (part instanceof Uint8Array ? part.length : 0), 0),
      pcm: parts.reduce((size, part) => size + ("pcm" in part ? part.pcm.length : 0), 0),
      words: parts
        .flatMap((part) => ("words" in part ? part.words : []))
        .map((word) => request.text.slice(word.start, word.end)),
    };
  }).pipe(
    Effect.provide(withCache(directory)),
    Effect.provideService(FetchHttpClient.Fetch, upstream),
  );

/** The loudness levels a client reads for a request, synthesized or replayed from the cache. */
const levels = (
  directory: string,
  upstream: typeof fetch,
  request: SpeechSynthesisRequest,
  cloud: CloudSpeechSynthesisProvider,
) =>
  Effect.gen(function* () {
    yield* (yield* CloudSpeech.CloudSpeech).setKey(cloud, Redacted.make("speech-key"));
    const streams = yield* SpeechSynthesisStreams.SpeechSynthesisStreams;
    const token = yield* streams.start(cloud, request);
    let words = 0;
    const values: number[] = [];
    for (;;) {
      const timings = yield* streams.timings(token, words, values.length);
      words += timings.words.length;
      if (timings.levels) values.push(...timings.levels.values);
      if (timings.done) return values;
    }
  }).pipe(
    Effect.provide(
      SpeechSynthesisStreams.layer.pipe(
        Layer.provideMerge(withCache(directory)),
        Layer.provide(Layer.mock(LocalSpeechSynthesis.LocalSpeechSynthesis)({})),
        Layer.provide(Layer.mock(SpeechAligner.SpeechAligner)({ session: () => Effect.undefined })),
        Layer.provide(SecureRandom.layerWebCrypto),
      ),
    ),
    Effect.provideService(FetchHttpClient.Fetch, upstream),
  );

const tempDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "t3-read-aloud-synthesis-" });
}).pipe(Effect.provide(NodeServices.layer));

const reply = [
  "First paragraph is short.",
  "Second one says a little more.",
  "Third paragraph, where the user jumps.",
  "Fourth paragraph keeps going.",
  "Fifth and last.",
].join("\n\n");

describe("read aloud synthesis cache", () => {
  it.effect("a jump after a full play makes no new provider requests", () =>
    Effect.gen(function* () {
      const directory = yield* tempDirectory;
      const upstream = provider();
      const full = yield* read(directory, upstream, readFrom(reply));
      // One request per block, so a jump to any block repeats requests already made.
      expect(sentTexts(upstream)).toEqual(reply.split("\n\n"));
      expect(full.words.join(" ")).toBe(reply.split("\n\n").join(" "));

      const jump = yield* read(directory, upstream, readFrom(reply, 2));
      expect(upstream).toHaveBeenCalledTimes(5);
      // Cached word timings still highlight the words of the jumped request.
      expect(jump.words.join(" ")).toBe(reply.split("\n\n").slice(2).join(" "));
      expect(jump.audio).toBe(3 * 2 * frame.length);

      // A replay after a restart reads the same audio from disk.
      yield* read(directory, upstream, readFrom(reply));
      expect(upstream).toHaveBeenCalledTimes(5);
    }).pipe(Effect.scoped),
  );

  it.effect("keys audio on what the provider is sent: voice, model, and speed it applies", () =>
    Effect.gen(function* () {
      const directory = yield* tempDirectory;
      const upstream = provider();
      const request = readFrom("Hello there.");
      yield* read(directory, upstream, request);
      yield* read(directory, upstream, { ...request, voice: "other" });
      yield* read(directory, upstream, { ...request, model: "eleven_v3" });
      expect(upstream).toHaveBeenCalledTimes(3);
      // ElevenLabs is not sent the speed; players apply it, so the audio is the same.
      yield* read(directory, upstream, { ...request, speed: 1.3 });
      expect(upstream).toHaveBeenCalledTimes(3);
      // xAI applies the speed itself, so each speed is its own audio.
      const sent = yield* read(directory, upstream, request, "xai");
      yield* read(directory, upstream, { ...request, speed: 1.3 }, "xai");
      const cached = yield* read(directory, upstream, request, "xai");
      expect(upstream).toHaveBeenCalledTimes(5);
      // The PCM comes back with cached audio, so words xAI does not time are timed again.
      expect(sent.pcm).toBeGreaterThan(0);
      expect(cached).toEqual(sent);
      // The same text sent to another provider is never shared.
      expect(sentTexts(upstream)).toEqual(Array.from({ length: 5 }, () => "Hello there."));
    }).pipe(Effect.scoped),
  );

  it.effect.each(["xai", "elevenlabs"] as const)(
    "replays %s from the cache with the levels its synthesis had",
    (cloud) =>
      Effect.gen(function* () {
        const directory = yield* tempDirectory;
        const upstream = provider();
        const request = readFrom(reply);
        const sent = yield* levels(directory, upstream, request, cloud);
        const cached = yield* levels(directory, upstream, request, cloud);
        expect(upstream).toHaveBeenCalledTimes(5);
        // xAI's cached PCM is measured again; ElevenLabs' MP3 is estimated again.
        expect(sent.length).toBeGreaterThan(0);
        expect(cached).toEqual(sent);
      }).pipe(Effect.scoped),
  );

  it.effect("does not cache a failed request", () =>
    Effect.gen(function* () {
      const directory = yield* tempDirectory;
      const upstream = provider();
      upstream.mockResolvedValueOnce(new Response("busy", { status: 503 }));
      const failure = yield* read(directory, upstream, readFrom("Hello there.")).pipe(Effect.flip);
      expect(failure).toMatchObject({ reason: "unavailable" });
      yield* read(directory, upstream, readFrom("Hello there."));
      yield* read(directory, upstream, readFrom("Hello there."));
      expect(upstream).toHaveBeenCalledTimes(2);
    }).pipe(Effect.scoped),
  );
});

describe("synthesisSegments", () => {
  const request = (text: string, blocks: SpeechSynthesisRequest["blocks"]) => ({
    text,
    model: "",
    voice: "",
    speed: 1,
    language: "en",
    ...(blocks ? { blocks } : {}),
  });

  it("splits at blocks and keeps text outside them", () => {
    const text = "One.\nTwo.\nloose text\nThree.";
    expect(
      CloudSpeech.synthesisSegments(
        request(text, [
          { start: 0, end: 4, markdown: "One." },
          { start: 5, end: 9, markdown: "Two." },
          { start: 21, end: 27, markdown: "Three." },
        ]),
      ).map((segment) => text.slice(segment.start, segment.end)),
    ).toEqual(["One.", "Two.", "\nloose text\n", "Three."]);
  });

  it("reads the whole text as before without blocks or with blocks that do not fit it", () => {
    const whole = [{ start: 0, end: 9, markdown: "" }];
    expect(CloudSpeech.synthesisSegments(request("One. Two.", undefined))).toEqual(whole);
    expect(
      CloudSpeech.synthesisSegments(
        request("One. Two.", [
          { start: 5, end: 9, markdown: "" },
          { start: 0, end: 4, markdown: "" },
        ]),
      ),
    ).toEqual(whole);
    expect(
      CloudSpeech.synthesisSegments(request("One. Two.", [{ start: 0, end: 40, markdown: "" }])),
    ).toEqual(whole);
  });
});
