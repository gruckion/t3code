import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { separators } from "../replacers/separators.ts";
import { createSpeechCleaner, defineReplacer, narrated } from "./Replacer.ts";
import * as SpeechCleaner from "./SpeechCleaner.ts";

const pullRequests = defineReplacer({
  id: "pull-requests",
  description: "Expand PR numbers for speech",
  matches: (text) => /\bPR #\d+\b/.test(text),
  replace: (text) => Effect.succeed(text.replace(/\bPR #(\d+)\b/g, "pull request $1")),
});

it.effect(
  "separator cleanup targets only inline code containing a file reference or identifier",
  () =>
    Effect.gen(function* () {
      const clean = yield* createSpeechCleaner([separators]);
      const cases: ReadonlyArray<readonly [string, string]> = [
        [
          "Call `enqueue_route_optimizations_after_commit` and `submit_route_optimization`.",
          "Call `enqueue route optimizations after commit` and `submit route optimization`.",
        ],
        [
          "Use `address_id`, `user_ID`, `id_lookup`, and `get_id()`.",
          "Use `address I D`, `user I D`, `I D lookup`, and `get I D()`.",
        ],
        [
          "`identity` `identity_key` `valid_id2` `id` and plain address_id.",
          "`identity` `identity key` `valid id2` `id` and plain address_id.",
        ],
        [
          "`address_id.ts` `echo address_id`\n\n```ts\nconst address_id = 1;\n```",
          "`address id.ts` `echo address_id`\n\n```ts\nconst address_id = 1;\n```",
        ],
        ["Open `some/file-name.bob`.", "Open `some/file name.bob`."],
        [
          "Use `my_file-name.ts` and `~/café_notes/version-2/`.",
          "Use `my file name.ts` and `~/café notes/version 2/`.",
        ],
        [
          "See **`./my_project/read-me.md`** and ``other_file.md``.",
          "See **`./my project/read me.md`** and ``other file.md``.",
        ],
        [
          "Plain my_project/release-notes.md and follow-up.",
          "Plain my_project/release-notes.md and follow-up.",
        ],
        [
          "`-12` `-£12` `-.5` `3-5` `1e-3` `some_variable` `--dry-run`",
          "`-12` `-£12` `-.5` `3-5` `1e-3` `some variable` `--dry-run`",
        ],
        [
          "`git diff --stat file-name.ts` and `https://example.com/my_file`",
          "`git diff --stat file-name.ts` and `https://example.com/my_file`",
        ],
        [
          "```md\n`some/file-name.bob`\n```\n\n    `other_file.md`",
          "```md\n`some/file-name.bob`\n```\n\n    `other_file.md`",
        ],
        [
          "\\`some/file-name.bob\\` and `unclosed_file.md",
          "\\`some/file-name.bob\\` and `unclosed_file.md",
        ],
      ];
      for (const [input, expected] of cases) {
        expect((yield* clean(input)).text).toBe(expected);
      }
    }),
);

it.effect("registered rules compose in order with dependencies and scoped matching", () =>
  Effect.gen(function* () {
    class Vocabulary extends Context.Service<Vocabulary, { readonly name: string }>()(
      "t3/speech/cleaner/engine/SpeechCleaner.test/Vocabulary",
    ) {}
    const custom = defineReplacer({
      id: "vocabulary",
      description: "Name the product",
      matches: (text) => text.includes("pull request"),
      replace: Effect.fn(function* (text: string) {
        return text + (yield* Vocabulary).name;
      }),
    });
    const input = "PR #42 in `my_project/`";
    const result = yield* SpeechCleaner.SpeechCleaner.use((cleaner) => cleaner.replace(input)).pipe(
      Effect.provide(
        SpeechCleaner.layer([pullRequests, separators, custom]).pipe(
          Layer.provide(Layer.succeed(Vocabulary, { name: " for Claude" })),
        ),
      ),
    );
    expect(result).toEqual({
      text: "pull request 42 in `my project/` for Claude",
      applied: true,
      changes: ["pull-requests", "separators", "vocabulary"],
      narrated: [],
      skipped: [],
    });
    expect(input).toBe("PR #42 in `my_project/`");
  }),
);

it.effect("rules that return model-written text are listed as narrated, not just changed", () =>
  Effect.gen(function* () {
    const summary = defineReplacer({
      id: "summary",
      description: "Replace the block with a model summary",
      replace: (text) => Effect.succeed(narrated(text.includes("code") ? "A summary." : text)),
    });
    const clean = yield* createSpeechCleaner([summary, pullRequests]);
    expect(yield* clean("PR #7 adds code.")).toMatchObject({
      text: "A summary.",
      changes: ["summary"],
      narrated: ["summary"],
    });
    // Narrated output that equals its input changed nothing, so it is in neither list.
    expect(yield* clean("PR #7 is merged.")).toMatchObject({
      text: "pull request 7 is merged.",
      changes: ["pull-requests"],
      narrated: [],
    });
  }),
);

it.effect(
  "failed, throwing, and timed-out replacers preserve prior text and let later rules run",
  () =>
    Effect.gen(function* () {
      const slowStarted = yield* Deferred.make<void>();
      const clean = yield* createSpeechCleaner(
        [
          defineReplacer({
            id: "failure",
            description: "Unavailable",
            replace: () => Effect.fail("offline"),
          }),
          defineReplacer({
            id: "defect",
            description: "Broken matcher",
            matches: () => {
              throw new Error("oops");
            },
            replace: () => Effect.succeed("lost"),
          }),
          defineReplacer({
            id: "slow",
            description: "Never completes",
            replace: () =>
              Deferred.succeed(slowStarted, undefined).pipe(Effect.andThen(Effect.never)),
          }),
          separators,
        ],
        { timeoutMs: 10 },
      );
      const fiber = yield* clean("`my_file-name.md`").pipe(Effect.forkChild());
      yield* Deferred.await(slowStarted);
      yield* TestClock.adjust(10);
      const result = yield* Fiber.join(fiber);
      expect(result.text).toBe("`my file name.md`");
      expect(result.skipped).toEqual(["failure", "defect", "slow"]);
      expect(result.changes).toEqual(["separators"]);
    }),
);

it.effect("registry rejects duplicate IDs and unchanged input reports no changes", () =>
  Effect.gen(function* () {
    const invalid = yield* createSpeechCleaner([separators, separators]).pipe(Effect.flip);
    expect(invalid).toMatchObject({
      _tag: "InvalidRegistry",
      problem: "duplicate-id",
      id: "separators",
    });
    const clean = yield* createSpeechCleaner([separators]);
    expect(yield* clean("Hello there.")).toEqual({
      text: "Hello there.",
      applied: false,
      changes: [],
      narrated: [],
      skipped: [],
    });
  }),
);
