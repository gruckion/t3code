import { expect, it } from "@effect/vitest";
import { ReadAloudCleanerRule } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";

import { fakeHttpClient } from "./ai/fakeHttpClient.testkit.ts";
import * as SpeechCleaner from "./engine/SpeechCleaner.ts";
import * as SpeechCleanerLive from "./SpeechCleanerLive.ts";

const decodeMessages = Schema.decodeUnknownSync(
  Schema.Struct({
    messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.String })),
  }),
);

const offline = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.die("Disabled AI must not reach the network")),
);

const clean = (text: string) =>
  SpeechCleaner.SpeechCleaner.use((cleaner) => cleaner.replace(text)).pipe(
    Effect.provide(
      SpeechCleanerLive.layer({
        enabled: false,
        codeEnabled: false,
        apiKey: Redacted.make(""),
        apiUrl: "",
        model: "",
      }).pipe(Layer.provide(offline)),
    ),
  );

it.effect("speech reads file paths as words while preserving ratios and code", () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["`km/h` `x/y` `A/B`", "`km/h` `x/y` `A/B`"],
      ["`./src/components` `src/components/`", "`. src components` `src components`"],
      [
        "**Draft replies to Pedro** (not posted; full text in sol-4174-research/pedro-review-replies-draft.md)",
        "**Draft replies to Pedro** (not posted; full text in sol 4174 research pedro review replies draft.md)",
      ],
      [
        "Open `some/file-name.bob` and `src/main.ts`.",
        "Open `some file name.bob` and `src main.ts`.",
      ],
      [
        "See **src/my_file.ts**, ../docs/read-me.md; then ~/notes/draft.md.",
        "See **src my file.ts**, .. docs read me.md; then ~ notes draft.md.",
      ],
      [
        "[src/my_file.ts](https://example.com/src/my_file.ts)",
        "[src my file.ts](https://example.com/src/my_file.ts)",
      ],
      [
        "https://example.com/my_file.ts example.com/my_file.ts /api/v1 A/B 10/2 km/h",
        "link to example.com example.com/my_file.ts /api/v1 A/B 10/2 km/h",
      ],
      [
        "```sh\ncat src/my_file.ts\n```\n\n    src/my_file.ts",
        "```sh\ncat src/my_file.ts\n```\n\n    src/my_file.ts",
      ],
      [
        "`https://example.com/my_file.ts` `cat src/my_file.ts`",
        "`link to example.com` `cat src/my_file.ts`",
      ],
    ];
    for (const [source, expected] of cases) expect((yield* clean(source)).text).toBe(expected);
  }),
);

it.effect("speech reads owner/repo names without the slash", () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<readonly [string, string]> = [
      // From real replies: the slash used to stay and was spoken.
      [
        "For a simple 🔊 button on each reply, start from #2356. The code is in `EricsenSemedo/t3code-custom`.",
        "For a simple 🔊 button on each reply, start from #2356. The code is in `EricsenSemedo t3code custom`.",
      ],
      [
        "I forked T3 Code to [gruckion/t3code](https://github.com/gruckion/t3code) and cloned it to `~/gruckion-workdir/t3code`.",
        "I forked T3 Code to [gruckion t3code](https://github.com/gruckion/t3code) and cloned it to `~ gruckion workdir t3code`.",
      ],
      [
        "Clone `pingdotgg/t3code` and `feat/read-aloud`.",
        "Clone `pingdotgg t3code` and `feat read aloud`.",
      ],
      // Short pairs, links to other places and prose keep their slash.
      ["`km/h` `A/B` `in/out` and/or", "`km/h` `A/B` `in/out` and/or"],
      ["[docs/guide](https://example.com/help)", "[docs/guide](https://example.com/help)"],
    ];
    for (const [source, expected] of cases) expect((yield* clean(source)).text).toBe(expected);
  }),
);

it.effect("speech shortens visible raw URLs and preserves meaningful link labels and code", () =>
  Effect.gen(function* () {
    const attachment =
      "https://github.com/user-attachments/assets/ffdad1a6-fb67-4bd8-a7dc-45fb013acaf0";
    const cases: ReadonlyArray<readonly [string, string]> = [
      [
        `SOL-3972 is ready. 3 min video: [${attachment}](${attachment})`,
        `SOL-3972 is ready. 3 min video: [GitHub attachment](${attachment})`,
      ],
      [`Video: ${attachment}`, "Video: GitHub attachment"],
      [`<${attachment}>`, "GitHub attachment"],
      [`[Watch the **demo**](${attachment})`, `[Watch the **demo**](${attachment})`],
      [
        "See https://example.com/private/token?key=secret#hash, then www.example.org/video.",
        "See link to example.com, then link to www.example.org.",
      ],
      ["(https://example.com/a_(b)). Next.", "(link to example.com). Next."],
      [
        "https://github.com.evil.example/user-attachments/assets/abc https://github.com/owner/repo/commit/abcdef12345",
        "link to github.com.evil.example link to github.com",
      ],
      [
        `\`${attachment}\` and \`curl ${attachment}\``,
        `\`GitHub attachment\` and \`curl ${attachment}\``,
      ],
      [
        `[${attachment}][video]\n\n[video]: ${attachment}`,
        `[GitHub attachment][video]\n\n[video]: ${attachment}`,
      ],
      [
        `\`\`\`sh\ncurl ${attachment}\n\`\`\`\n\n    ${attachment}`,
        `\`\`\`sh\ncurl ${attachment}\n\`\`\`\n\n    ${attachment}`,
      ],
      ["Broken https:// and email me@example.com.", "Broken https:// and email me@example.com."],
    ];
    for (const [source, expected] of cases) expect((yield* clean(source)).text).toBe(expected);
  }),
);

it.effect("speech reads comparison operators as words", () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["The check passes when x > 3.", "The check passes when x is greater than 3."],
      ["Fails when x < 3.", "Fails when x is less than 3."],
      [
        "Use x >= 3 or x <= 10.",
        "Use x is greater than or equal to 3 or x is less than or equal to 10.",
      ],
      [
        "Use x ≥ 3 or x ≤ 10.",
        "Use x is greater than or equal to 3 or x is less than or equal to 10.",
      ],
      ["count>=5 and x>3", "count is greater than or equal to 5 and x is greater than 3"],
      [
        "Keep 1 < x < 5 and x > y.",
        "Keep x is greater than 1 and less than 5 and x is greater than y.",
      ],
      [
        "Stop when count > limit or size < maxSize.",
        "Stop when count is greater than limit or size is less than maxSize.",
      ],
      [
        "Reject values > 3 and retries >= limit.",
        "Reject values are greater than 3 and retries are greater than or equal to limit.",
      ],
      [
        "The status > 3 and x is > 3 and fails when > 3.",
        "The status is greater than 3 and x is greater than 3 and fails when greater than 3.",
      ],
      [
        "Allow 1 <= x < 5, then 5 > y > 1.",
        "Allow x is greater than or equal to 1 and less than 5, then y is less than 5 and greater than 1.",
      ],
      [
        "Check `x > 3 && y < 5` or `a >= b || c <= d`.",
        "Check `x is greater than 3 and y is less than 5` or `a is greater than or equal to b or c is less than or equal to d`.",
      ],
      [
        "Check `count > limit` and `1 < x < 5`.",
        "Check `count is greater than limit` and `x is greater than 1 and less than 5`.",
      ],
      ["When x > 3 && y < 5.", "When x is greater than 3 and y is less than 5."],
      ["Latency >200ms (<5%).", "Latency is greater than 200ms (less than 5%)."],
      [
        "Check `x.length > 0` and a >= b.",
        "Check `x.length is greater than 0` and a is greater than or equal to b.",
      ],
      ["**Rule:** > 3 retries", "**Rule:** greater than 3 retries"],
      ["When `x` > 3 or **y** < 2.", "When `x` is greater than 3 or **y** is less than 2."],
    ];
    for (const [source, expected] of cases) expect((yield* clean(source)).text).toBe(expected);
  }),
);

it.effect("speech keeps arrows, menus, generics and shell redirects as they are", () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<string> = [
      "Open Settings > General > Privacy.",
      "Step 1 > Step 2",
      "Return `Array<string>` and `Map<K, V>` from T<U>.",
      "Use `(a) => a + 1`, `items >> 1`, `a <> b`, `value |> f` and a -> b.",
      "Run `echo 3 > out.txt` and `cmd 2>/dev/null` and `cmd 2>&1`.",
      "Write 3 > out.txt",
      "Print `echo $$` and `$&` as they are.",
      "Run `ls > out.txt` and `cat a > b` and `x > 3 && cat y`.",
      "Write ls > out.txt and open File > Save.",
      "```txt\nx > 5\n```",
    ];
    for (const source of cases) expect((yield* clean(source)).text).toBe(source);
  }),
);

it.effect("speech removes parsed blockquote markers while retaining comparison operators", () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<readonly [string, string]> = [
      [
        "> What about a visit that grows into the next stop?",
        "What about a visit that grows into the next stop?",
      ],
      [
        "> Call `enqueue_route_optimizations_after_commit`; count > 5.\n> Then review.",
        "Call `enqueue route optimizations after commit`; count is greater than 5.\nThen review.",
      ],
      ["> Outer\n>> Inner\n>\n> End", "Outer\nInner\n\nEnd"],
      ["- > Quoted\n  > reply", "- Quoted\n  reply"],
      ["> First\nlazy continuation\n\nAfter", "First\nlazy continuation\n\nAfter"],
      [
        "Compare count > 5, `x >= 3`, and `items >> 1`.",
        "Compare count is greater than 5, `x is greater than or equal to 3`, and `items >> 1`.",
      ],
      [
        "\\> literal\n\n```txt\n> literal\n```\n\n    > literal",
        "\\> literal\n\n```txt\n> literal\n```\n\n    > literal",
      ],
      ["> ```txt\n> x > 5\n> ```", "```txt\nx > 5\n```"],
    ];
    for (const [source, expected] of cases) expect((yield* clean(source)).text).toBe(expected);
  }),
);

it.effect("table cells reach the narrator with paths cleaned and links as their text", () =>
  Effect.gen(function* () {
    // From a real reply. The narrator then wrote the path without backticks, so its slashes
    // were spoken, and it read the hidden link as "link to cli.github.com".
    const table = [
      "| # | Experiment |",
      "|---|---|",
      "| 1 | Copy the AI code into `apps/server/src/speech/` and see [GitHub documentation](https://cli.github.com/manual/gh_auth_login) |",
    ].join("\n");
    const seen: Array<string> = [];
    const http = fakeHttpClient(({ body }) =>
      Effect.sync(() => {
        const source = decodeMessages(body).messages.find((message) => message.role === "user");
        if (source !== undefined) seen.push(source.content);
        return Response.json({
          id: "test",
          object: "chat.completion",
          created: 1,
          model: "test-model",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content:
                  "Number 1. Experiment: Copy the AI code into apps server src speech and see GitHub documentation.",
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        });
      }),
    );
    const result = yield* SpeechCleaner.SpeechCleaner.use((cleaner) => cleaner.replace(table)).pipe(
      Effect.provide(
        SpeechCleanerLive.layer({
          enabled: true,
          codeEnabled: false,
          apiKey: Redacted.make("synthetic-test-key"),
          apiUrl: "http://provider.test/v1",
          model: "test-model",
        }).pipe(Layer.provide(http)),
      ),
    );
    expect(seen).toEqual([
      "| # | Experiment |\n|---|---|\n| 1 | Copy the AI code into `apps server src speech` and see GitHub documentation |",
    ]);
    expect(result).toMatchObject({
      changes: ["file-paths", "markdown-tables"],
      narrated: ["markdown-tables"],
    });
  }),
);

it("settings can turn off every rule the cleaner runs", () => {
  expect(SpeechCleanerLive.ruleIds).toEqual(ReadAloudCleanerRule.literals);
});

it.effect("speech spells out numbers with thousands separators", () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<readonly [string, string]> = [
      [
        "The backfill is at 4,064,078 of 4,735,297 events.",
        "The backfill is at four million sixty-four thousand seventy-eight of four million seven hundred thirty-five thousand two hundred ninety-seven events.",
      ],
      [
        "It costs $1,200.50 a year.",
        "It costs one thousand two hundred point five zero dollars a year.",
      ],
      [
        "About 1,000,000 rows, and 2,000 > 1,500.",
        "About one million rows, and two thousand is greater than one thousand five hundred.",
      ],
      ["Run `seq 1,000`, then pick 1,2,3.", "Run `seq 1,000`, then pick 1,2,3."],
      ["Small numbers like 42 and 2026 stay.", "Small numbers like 42 and 2026 stay."],
    ];
    for (const [input, expected] of cases) {
      const result = yield* clean(input);
      expect(result.text).toBe(expected);
    }
  }),
);
