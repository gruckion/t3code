import * as Effect from "effect/Effect";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { RootContent } from "mdast";
import * as BlockClassifier from "../ai/BlockClassifier.ts";
import { readableBlock } from "./blockText.ts";
import { NarrationFailed } from "../ai/Narration.ts";
import * as CodeNarrator from "../ai/CodeNarrator.ts";
import { CleanerTimeouts } from "../engine/CleanerTimeouts.ts";
import { defineReplacer, narrated, type Narrated } from "../engine/Replacer.ts";

export const codeBlocks = defineReplacer({
  id: "code-blocks",
  description: "Explain code blocks for speech without reading or executing the code",
  replace: Effect.fn("codeBlocks.replace")(function* (text: string) {
    const tree = fromMarkdown(text);
    const blocks: Array<{ start: number; end: number }> = [];
    function visit(nodes: ReadonlyArray<RootContent>) {
      for (const node of nodes) {
        if (node.type === "code" && node.value.trim()) {
          const start = node.position?.start.offset;
          const end = node.position?.end.offset;
          if (start !== undefined && end !== undefined) blocks.push({ start, end });
        } else if ("children" in node) visit(node.children);
      }
    }
    visit(tree.children);
    if (!blocks.length) return text;
    const timeouts = yield* CleanerTimeouts;
    const classifier = yield* BlockClassifier.BlockClassifier;
    const narrator = yield* CodeNarrator.CodeNarrator;
    const sources = blocks.map((block) => text.slice(block.start, block.end));
    const originals = sources.map((source) => readableBlock(source));
    const replacements = yield* Effect.gen(function* () {
      const decisions = yield* classifier.classify(sources).pipe(
        Effect.timeout(timeouts.classifierMs),
        Effect.catchTags({
          TimeoutError: () => Effect.succeed(sources.map(() => "read" as const)),
          NarrationFailed: () => Effect.succeed(sources.map(() => "read" as const)),
        }),
      );
      return yield* Effect.forEach(
        sources,
        (source, index): Effect.Effect<string | Narrated> => {
          if (decisions[index] !== "summarize") return Effect.succeed(originals[index]!);
          return narrator.narrate(source).pipe(
            Effect.flatMap((summary) => {
              const spoken = readableBlock(summary)
                .trim()
                .replace(/^(?:code summary|code block)\s*:?\s*/i, "")
                .trim();
              const labelOnly = /^(?:codesummary|codeblock)$/i.test(
                spoken.replace(/[^\p{L}\p{N}]/gu, ""),
              );
              return /[\p{L}\p{N}]/u.test(spoken) && !labelOnly
                ? Effect.succeed(narrated(spoken))
                : Effect.fail(new NarrationFailed({ reason: "placeholder" }));
            }),
            Effect.orElseSucceed(() => originals[index]!),
          );
        },
        { concurrency: 2 },
      );
    }).pipe(
      Effect.timeout(timeouts.codeNarrationMs),
      // NarrationDisabled passes through, so the engine leaves the text unchanged.
      Effect.catchTags({ TimeoutError: () => Effect.succeed(originals) }),
    );
    let output = "";
    let cursor = 0;
    for (const [index, block] of blocks.entries()) {
      const replacement = replacements[index]!;
      output +=
        text.slice(cursor, block.start) +
        (typeof replacement === "string" ? replacement : replacement.text);
      cursor = block.end;
    }
    output += text.slice(cursor);
    return replacements.some((replacement) => typeof replacement !== "string")
      ? narrated(output)
      : output;
  }),
});
