import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as SpeechCleaner from "../engine/SpeechCleaner.ts";
import * as SpeechCleanerLive from "../SpeechCleanerLive.ts";
import { fakeHttpClient } from "./fakeHttpClient.testkit.ts";
import type { ProviderSettings } from "./Provider.ts";

const Body = Schema.Struct({
  state: Schema.Struct({
    candidates: Schema.Array(
      Schema.Struct({
        value: Schema.String,
        context: Schema.String,
        kind: Schema.optional(Schema.Literal("migration-file")),
      }),
    ),
  }),
  questions: Schema.Record(Schema.String, Schema.Unknown),
});
const decodeBody = Schema.decodeUnknownSync(Body);
const yes = { type: "noul", noul: 0.99 };

it.effect(
  "configured hash speech classifies visible candidates with bounded context and shortens only matches",
  () =>
    Effect.gen(function* () {
      const bodies: Array<typeof Body.Type> = [];
      const auth: Array<string | undefined> = [];
      let answers: unknown = {
        hash_0: yes,
        hash_1: yes,
        hash_2: { type: "noul", noul: 0.01 },
      };
      let status = 200;
      let slow = false;
      const stalled = yield* Queue.unbounded<void>();
      const http = fakeHttpClient(({ authorization, body }) =>
        Effect.gen(function* () {
          auth.push(authorization);
          bodies.push(decodeBody(body));
          if (slow) {
            yield* Queue.offer(stalled, undefined);
            return yield* Effect.never;
          }
          return Response.json({ answers }, { status });
        }),
      );
      const settings = {
        enabled: true,
        codeEnabled: false,
        hashEnabled: true,
        apiKey: Redacted.make("unused"),
        apiUrl: "http://127.0.0.1:1",
        model: "unused",
        classifier: {
          apiKey: Redacted.make("synthetic-jev-key"),
          model: "test-jev",
          apiUrl: "http://classifier.test",
        },
      };
      const run = (source: string, config: ProviderSettings = settings) =>
        SpeechCleaner.SpeechCleaner.use((cleaner) => cleaner.replace(source)).pipe(
          Effect.provide(SpeechCleanerLive.layer(config).pipe(Layer.provide(http))),
        );
      const runStalled = (source: string) =>
        Effect.gen(function* () {
          const fiber = yield* run(source).pipe(Effect.forkChild());
          yield* Queue.take(stalled);
          yield* TestClock.adjust(1500);
          return yield* Fiber.join(fiber);
        });
      const source =
        "Migration `2bde899ec541` follows [b310dd58c6da](https://example.com/secret/deadbeef1234). Invoice 12345678 is unrelated.";
      expect((yield* run(source)).text).toBe(
        "Migration `hash ending c541` follows [hash ending c6da](https://example.com/secret/deadbeef1234). Invoice 12345678 is unrelated.",
      );
      expect(auth).toEqual(["Bearer synthetic-jev-key"]);
      expect(bodies[0]?.state.candidates.map((item) => item.value)).toEqual([
        "2bde899ec541",
        "b310dd58c6da",
        "12345678",
      ]);
      expect(bodies[0]?.state.candidates[0]?.context).toContain("Migration");
      expect(JSON.stringify(bodies)).not.toContain("secret");
      expect(Object.keys(bodies[0]!.questions)).toEqual(["hash_0", "hash_1", "hash_2"]);

      const migration =
        "I re-pointed our migration and renamed it to `1791970000_b310dd58c6da.py`.";
      expect((yield* run(migration)).text).toBe(
        "I re-pointed our migration and renamed it to `migration ending c6da`.",
      );
      expect(bodies.at(-1)?.state.candidates).toEqual([
        {
          value: "1791970000_b310dd58c6da.py",
          kind: "migration-file",
          context: expect.stringContaining("re-pointed our migration"),
        },
      ]);
      expect(
        (yield* run(
          "Migration [1791970000_DEADBEEF.py](https://example.com/private/1791970000_DEADBEEF.py). Next migration 1791970001_b310dd58c6da.py.",
        )).text,
      ).toBe(
        "Migration [migration ending BEEF](https://example.com/private/1791970000_DEADBEEF.py). Next migration migration ending c6da.",
      );
      expect(JSON.stringify(bodies.at(-1))).not.toContain("private");
      const migrationFallback =
        "I re-pointed our migration and renamed it to `1791970000 b310dd58c6da.py`.";
      answers = { hash_0: { type: "noul", noul: 0.3 } };
      expect((yield* run(migration)).text).toBe(migrationFallback);
      expect((yield* run(migration, { ...settings, hashEnabled: false })).text).toBe(
        migrationFallback,
      );
      status = 503;
      expect((yield* run(migration)).text).toBe(migrationFallback);
      status = 200;
      answers = { hash_0: yes };
      const excludedFilenames =
        "[download](https://example.com/1791970000_b310dd58c6da.py) https://example.com/1791970000_b310dd58c6da.py\n\n```py\n1791970000_b310dd58c6da.py\n```\n\n`backup_1791970000_b310dd58c6da.py` `1791970000_b310dd58c6da.py.bak`";
      const excludedCalls = bodies.length;
      yield* run(excludedFilenames);
      expect(bodies).toHaveLength(excludedCalls);

      const before = bodies.length;
      const excluded =
        "[cancel](https://example.com/deadbeef1234) https://example.com/abcdef123456\n\n```sh\ngit checkout abcdef123456\n```\n\n`src/abcdef123456.py` abcdef123456_name";
      yield* run(excluded);
      expect(bodies).toHaveLength(before);
      yield* run(source, { ...settings, hashEnabled: false });
      expect((yield* run(source, { ...settings, classifier: undefined })).text).toBe(source);
      expect(bodies).toHaveLength(before);
      // Hash classification needs only the classifier, not a narration provider.
      yield* run(source, { ...settings, enabled: false });
      expect(bodies).toHaveLength(before + 1);

      for (answers of [
        {},
        { hash_0: { type: "noul", noul: 0.6 } },
        { hash_0: { type: "noul", noul: 1.5 } },
        { hash_0: { type: "choice", choice: "hash" } },
      ]) {
        expect((yield* run("Commit abcdef123456.")).text).toBe("Commit abcdef123456.");
      }
      status = 503;
      expect((yield* run("Commit abcdef123456.")).text).toBe("Commit abcdef123456.");
      status = 200;
      answers = { hash_0: yes };
      yield* run(
        "unrelated paragraph\n\n" +
          "Padding ".repeat(100) +
          "Commit abcdef123456. " +
          "After ".repeat(100),
      );
      const context = bodies.at(-1)!.state.candidates[0]!.context;
      expect(context).toContain("Commit abcdef123456");
      expect(context.length).toBeLessThanOrEqual(384);
      expect(context).not.toContain("unrelated paragraph");
      expect((yield* run("Commit DEADBEEF.")).text).toBe("Commit hash ending BEEF.");
      yield* run(Array.from({ length: 40 }, () => "Commit abcdef123456.").join("\n\n"));
      expect(bodies.at(-1)?.state.candidates).toHaveLength(32);
      slow = true;
      expect((yield* runStalled(migration)).text).toBe(migrationFallback);
      expect((yield* runStalled("Commit abcdef123456.")).text).toBe("Commit abcdef123456.");
    }),
);
