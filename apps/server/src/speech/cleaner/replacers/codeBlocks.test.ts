import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import * as BlockClassifier from "../ai/BlockClassifier.ts";
import * as CodeNarrator from "../ai/CodeNarrator.ts";
import { NarrationFailed } from "../ai/Narration.ts";
import { createSpeechCleaner } from "../engine/Replacer.ts";
import { codeBlocks } from "./codeBlocks.ts";
import { separators } from "./separators.ts";

const summarizeAll = Effect.provideService(BlockClassifier.BlockClassifier, {
  classify: (blocks) => Effect.succeed(blocks.map(() => "summarize" as const)),
});

it.effect(
  "code narration replaces fenced, tilde and indented blocks while retaining inline code and surrounding Markdown",
  () =>
    Effect.gen(function* () {
      const blocks = ["```ts\nconst x = 1;\n```", "~~~sh\necho hello\n~~~", "    print('hello')"];
      const seen: string[] = [];
      const input = `Before **bold** and \`my_file.ts\`.\n\n${blocks.join("\n\nBetween.\n\n")}\n\nAfter.`;
      const clean = yield* createSpeechCleaner([codeBlocks]);
      const result = yield* clean(input).pipe(
        summarizeAll,
        Effect.provideService(CodeNarrator.CodeNarrator, {
          narrate: (source) =>
            Effect.sync(() => {
              seen.push(source);
              return `Explanation ${seen.length}.`;
            }),
        }),
      );
      expect(seen).toEqual(blocks);
      expect(result.text).toBe(
        "Before **bold** and `my_file.ts`.\n\nExplanation 1.\n\nBetween.\n\nExplanation 2.\n\nBetween.\n\nExplanation 3.\n\nAfter.",
      );
      expect(result.narrated).toEqual(["code-blocks"]);
    }),
);

it.effect(
  "a later narration failure reads that block and retains earlier summaries and inline cleanup",
  () =>
    Effect.gen(function* () {
      const block = "```ts\nconst file = 'my_file.ts';\n```";
      const input = `See \`my_file.ts\`.\n\n${block}\n\n${block}`;
      let calls = 0;
      const clean = yield* createSpeechCleaner([codeBlocks, separators]);
      const result = yield* clean(input).pipe(
        summarizeAll,
        Effect.provideService(CodeNarrator.CodeNarrator, {
          narrate: () =>
            ++calls === 1
              ? Effect.succeed("First explanation.")
              : Effect.fail(new NarrationFailed({ reason: "provider" })),
        }),
      );
      expect(result.text).toBe(
        "See `my file.ts`.\n\nFirst explanation.\n\nconst file = 'my_file.ts';",
      );
      expect(result.skipped).toEqual([]);
      expect(result.changes).toEqual(["code-blocks", "separators"]);
    }),
);

it.effect("fenced prose remains audible when narration returns only a placeholder", () =>
  Effect.gen(function* () {
    const input =
      "Before.\n\n```rust\nProposed:\n- Give reviewers read-only access.\n- Run the app to reproduce the issue.\n```\n\nAfter.";
    const clean = yield* createSpeechCleaner([codeBlocks]);
    for (const placeholder of [
      "Code summary",
      "```text\n**Code summary**\n```",
      "(code block)",
      "(Code summary)",
    ]) {
      const result = yield* clean(input).pipe(
        summarizeAll,
        Effect.provideService(CodeNarrator.CodeNarrator, {
          narrate: () => Effect.succeed(placeholder),
        }),
      );
      expect(result.text).toBe(
        "Before.\n\nProposed:\n- Give reviewers read-only access.\n- Run the app to reproduce the issue.\n\nAfter.",
      );
    }
  }),
);

it.effect(
  "prose is unwrapped recursively without a narrator call, even with misleading fence labels",
  () =>
    Effect.gen(function* () {
      const input =
        "Before.\n\n````rust\nHere is the draft:\n\n```\nCall `enqueue_route_optimizations_after_commit`.\n```\n````\n\nAfter.";
      const clean = yield* createSpeechCleaner([codeBlocks, separators]);
      const result = yield* clean(input).pipe(
        Effect.provide(BlockClassifier.verbatim),
        Effect.provideService(CodeNarrator.CodeNarrator, {
          narrate: () => Effect.die("Prose must not be summarized"),
        }),
      );
      expect(result.text).toBe(
        "Before.\n\nHere is the draft:\n\nCall `enqueue route optimizations after commit`.\n\nAfter.",
      );
      // Unwrapped prose keeps its words, so callers can still highlight it word by word.
      expect(result).toMatchObject({ changes: ["code-blocks", "separators"], narrated: [] });
    }),
);

it.effect("classifier and narrator deadlines preserve audible contents", () =>
  Effect.gen(function* () {
    const input = "```ts\nconst value = 1;\n```";
    const clean = yield* createSpeechCleaner([codeBlocks]);
    for (const [stalled, deadline] of [
      ["classifier", 1500],
      ["narrator", 3500],
    ] as const) {
      const started = yield* Deferred.make<void>();
      const hang = Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
      const fiber = yield* clean(input).pipe(
        Effect.provideService(BlockClassifier.BlockClassifier, {
          classify: () =>
            stalled === "classifier" ? hang : Effect.succeed(["summarize" as const]),
        }),
        Effect.provideService(CodeNarrator.CodeNarrator, { narrate: () => hang }),
        Effect.forkChild(),
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust(deadline);
      expect((yield* Fiber.join(fiber)).text).toBe("const value = 1;");
    }
  }),
);
