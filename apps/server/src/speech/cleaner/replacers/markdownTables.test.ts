import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { NarrationDisabled, NarrationFailed } from "../ai/Narration.ts";
import * as TableNarrator from "../ai/TableNarrator.ts";
import { createSpeechCleaner } from "../engine/Replacer.ts";
import { markdownTables } from "./markdownTables.ts";
import { urls } from "./urls.ts";

const table = "| Site | Cost |\n| --- | ---: |\n| A | -£12 |\n| B | £34 |";

// From a real reply. Its narration said "See the GitHub documentation at link to cli.github.com."
const linkedTable = [
  "| Service | How it works |",
  "|---|---|",
  "| Claude Code | Its CLI handles authentication using a local callback. |",
  "| GitHub | The bundled `gh` CLI handles browser/device-code authentication; no Mondash public URL is required. [GitHub documentation](https://cli.github.com/manual/gh_auth_login) |",
  "| Linear | Currently uses your personal API key, so there’s no callback URL. |",
  "| Notion / Slack | Need Mondash’s Mac-local OAuth flow. Slack also requires appropriate app registration; it supports localhost redirects under its documented rules. [Slack documentation](https://docs.slack.dev/authentication/using-pkce/) |",
].join("\n");

// From a real reply; the 4 s deadline it shipped with dropped it back to raw Markdown.
const scoreTable = [
  "| Approach | Correct | Missed links | Average input tokens |",
  "|---|---:|---:|---:|",
  "| Current digest + Noul | 60/70 | 10 | 1,192 |",
  "| **Adaptive digest → pairs + Score** | **70/70** | **0** | **1,057** |",
].join("\n");
const spokenScoreTable =
  "A table with 2 rows comparing Approach, Correct, Missed links and Average input tokens. " +
  "Row 1. Approach: Current digest + Noul. Correct: 60/70. Missed links: 10. Average input tokens: 1,192. " +
  "Row 2. Approach: **Adaptive digest → pairs + Score**. Correct: **70/70**. Missed links: **0**. Average input tokens: **1,057**.";

it.effect(
  "GFM parsing rewrites real tables, preserving all surrounding text and fenced examples",
  () =>
    Effect.gen(function* () {
      const seen: string[] = [];
      const input = `Before my_file.\n\n${table}\n\n\`\`\`md\n${table}\n\`\`\`\n\nAfter.`;
      const clean = yield* createSpeechCleaner([markdownTables]);
      const result = yield* clean(input).pipe(
        Effect.provideService(TableNarrator.TableNarrator, {
          narrate: (text) =>
            Effect.sync(() => {
              seen.push(text);
              return "Site A costs minus twelve pounds; site B costs thirty-four pounds.";
            }),
        }),
      );
      expect(seen).toEqual([table]);
      expect(result.text).toBe(
        `Before my_file.\n\nSite A costs minus twelve pounds; site B costs thirty-four pounds.\n\n\`\`\`md\n${table}\n\`\`\`\n\nAfter.`,
      );
      expect(result).toMatchObject({ changes: ["markdown-tables"], narrated: ["markdown-tables"] });
    }),
);

it.effect("the narrator sees links as their text, and a URL it says anyway is dropped", () =>
  Effect.gen(function* () {
    const seen: string[] = [];
    const clean = yield* createSpeechCleaner([markdownTables, urls]);
    const result = yield* clean(linkedTable).pipe(
      Effect.provideService(TableNarrator.TableNarrator, {
        narrate: (text) =>
          Effect.sync(() => {
            seen.push(text);
            return "For the service GitHub, no Mondash public URL is required. See the GitHub documentation at https://cli.github.com/manual/gh_auth_login. For Slack, see [Slack documentation](https://docs.slack.dev/authentication/using-pkce/).";
          }),
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("required. GitHub documentation |");
    expect(seen[0]).toContain("documented rules. Slack documentation |");
    expect(seen[0]).not.toMatch(/https?:|cli\.github\.com|docs\.slack\.dev/);
    expect(result.text).toBe(
      "For the service GitHub, no Mondash public URL is required. See the GitHub documentation. For Slack, see Slack documentation.",
    );
  }),
);

it.effect("a visible URL in a cell reaches the narrator as the host it links to", () =>
  Effect.gen(function* () {
    const seen: string[] = [];
    const clean = yield* createSpeechCleaner([markdownTables]);
    yield* clean("| Site | Where |\n|---|---|\n| Docs | https://example.com/a/b?c=d |").pipe(
      Effect.provideService(TableNarrator.TableNarrator, {
        narrate: (text) => Effect.sync(() => (seen.push(text), "Docs are at the example site.")),
      }),
    );
    expect(seen).toEqual(["| Site | Where |\n|---|---|\n| Docs | link to example.com |"]);
  }),
);

it.effect("a table the narrator fails is spoken row by row, and earlier narration is kept", () =>
  Effect.gen(function* () {
    let calls = 0;
    const input = `${table}\n\nBetween.\n\n${table}`;
    const clean = yield* createSpeechCleaner([markdownTables]);
    const result = yield* clean(input).pipe(
      Effect.provideService(TableNarrator.TableNarrator, {
        narrate: () =>
          ++calls === 1
            ? Effect.succeed("first")
            : Effect.fail(new NarrationFailed({ reason: "provider" })),
      }),
    );
    expect(result.text).toBe(
      "first\n\nBetween.\n\nA table with 2 rows comparing Site and Cost. Row 1. Site: A. Cost: -£12. Row 2. Site: B. Cost: £34.",
    );
    expect(result).toMatchObject({ skipped: [], narrated: ["markdown-tables"] });
  }),
);

it.effect("a table past its narration deadline, or with no narrator, is never read as pipes", () =>
  Effect.gen(function* () {
    const clean = yield* createSpeechCleaner([markdownTables]);
    const started = yield* Deferred.make<void>();
    const fiber = yield* clean(`Scores:\n\n${scoreTable}`).pipe(
      Effect.provideService(TableNarrator.TableNarrator, {
        narrate: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      }),
      Effect.forkChild(),
    );
    yield* Deferred.await(started);
    yield* TestClock.adjust(11_000);
    const timedOut = yield* Fiber.join(fiber);
    expect(timedOut).toEqual({
      text: `Scores:\n\n${spokenScoreTable}`,
      applied: true,
      changes: ["markdown-tables"],
      narrated: [],
      skipped: [],
    });

    const disabled = yield* clean(scoreTable).pipe(
      Effect.provideService(TableNarrator.TableNarrator, {
        narrate: () => Effect.fail(new NarrationDisabled()),
      }),
    );
    expect(disabled.text).toBe(spokenScoreTable);
  }),
);

it.effect("the spoken form names a # column, skips empty cells and drops hidden links", () =>
  Effect.gen(function* () {
    const clean = yield* createSpeechCleaner([markdownTables]);
    const result = yield* clean(
      "| # | PR | Note |\n|---|---|---|\n| 1 | [#14865](https://github.com/pingdotgg/t3code/pull/14865) Codex voice |  |",
    ).pipe(
      Effect.provideService(TableNarrator.TableNarrator, {
        narrate: () => Effect.fail(new NarrationDisabled()),
      }),
    );
    expect(result.text).toBe(
      "A table with 1 row comparing number, PR and Note. Row 1. number: 1. PR: #14865 Codex voice.",
    );
  }),
);
