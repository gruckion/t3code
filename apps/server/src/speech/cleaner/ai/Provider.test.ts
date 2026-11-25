import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as SpeechCleaner from "../engine/SpeechCleaner.ts";
import * as SpeechCleanerLive from "../SpeechCleanerLive.ts";
import { fakeHttpClient, type FakeRequest } from "./fakeHttpClient.testkit.ts";
import type { ProviderSettings } from "./Provider.ts";

const Body = Schema.Struct({
  messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.String })),
});
const decodeBody = Schema.decodeUnknownSync(Body);

it.effect("configured AI narrates only opted-in blocks and falls back on truncated output", () =>
  Effect.gen(function* () {
    const table = "| Site | Cost |\n| --- | ---: |\n| A | -£12 |";
    const code = "```ts\nconst total = price * quantity;\n```";
    const tableSpeech = "Site A costs minus twelve pounds.";
    const codeSpeech = "This calculates the total by multiplying price by quantity.";
    const input = `Private surrounding text.\n\n${table}\n\n${code}\n\nAfter.`;
    const requests: Array<{ url: string; authorization: string | undefined; body: unknown }> = [];
    let truncated = false;
    let prose = false;
    let malformed = false;
    let disagreement = false;
    let unavailable = false;
    const http = fakeHttpClient(({ path, authorization, body }: FakeRequest) =>
      Effect.sync(() => {
        requests.push({ url: path, authorization, body });
        if (path === "/classify" && unavailable)
          return new Response("Unavailable", { status: 503 });
        if (path === "/classify")
          return Response.json({
            answers: malformed
              ? {}
              : {
                  kind_0: {
                    type: "choice",
                    probabilities: {
                      prose: prose ? 1 : 0,
                      code: prose ? 0 : 1,
                      data: 0,
                      mixed: 0,
                    },
                  },
                  verbatim_0: { type: "noul", noul: prose || disagreement ? 1 : 0 },
                },
          });
        const isCode = decodeBody(body).messages.some(
          (message) => message.role === "user" && message.content === code,
        );
        return Response.json({
          id: "test",
          object: "chat.completion",
          created: 1,
          model: "test-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: isCode ? codeSpeech : tableSpeech },
              finish_reason: truncated ? "length" : "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        });
      }),
    );
    const settings: ProviderSettings = {
      enabled: true,
      codeEnabled: true,
      apiUrl: "http://provider.test/v1",
      apiKey: Redacted.make("synthetic-test-key"),
      model: "test-model",
      reasoningEffort: "none",
      classifier: {
        apiKey: Redacted.make("synthetic-classifier-key"),
        model: "test-jev",
        apiUrl: "http://provider.test/classify",
      },
    };
    const run = (source: string, config: ProviderSettings = settings) =>
      SpeechCleaner.SpeechCleaner.use((cleaner) => cleaner.replace(source)).pipe(
        Effect.provide(SpeechCleanerLive.layer(config).pipe(Layer.provide(http))),
      );
    expect((yield* run(input)).text).toBe(
      `Private surrounding text.\n\n${tableSpeech}\n\n${codeSpeech}\n\nAfter.`,
    );
    expect(requests).toHaveLength(3);
    expect(requests[0]).toMatchObject({
      url: "/classify",
      authorization: "Bearer synthetic-classifier-key",
      body: {
        model: "test-jev",
        state: { blocks: [code] },
        questions: { kind_0: { type: "choice" }, verbatim_0: { type: "noul" } },
      },
    });
    const narrationRequests = requests
      .filter((request) => request.url === "/v1/chat/completions")
      .reverse();
    for (const [index, source] of [table, code].entries()) {
      expect(narrationRequests[index]).toMatchObject({
        url: "/v1/chat/completions",
        authorization: "Bearer synthetic-test-key",
        body: {
          model: "test-model",
          reasoning_effort: "none",
          messages: [
            {
              role: "system",
              content: expect.stringContaining("untrusted data"),
            },
            { role: "user", content: source },
          ],
        },
      });
    }
    truncated = true;
    const spokenTable = "A table with 1 row comparing Site and Cost. Row 1. Site: A. Cost: -£12.";
    const fallback = yield* run(input);
    expect(fallback.text).toBe(
      `Private surrounding text.\n\n${spokenTable}\n\nconst total = price * quantity;\n\nAfter.`,
    );
    expect(fallback).toMatchObject({ skipped: [], narrated: [] });
    truncated = false;
    prose = true;
    const draft = "```rust\nPlease read this exact draft.\n```";
    const beforeProse = requests.length;
    expect((yield* run(draft)).text).toBe("Please read this exact draft.");
    expect(requests.length - beforeProse).toBe(1);
    prose = false;
    disagreement = true;
    expect((yield* run(draft)).text).toBe("Please read this exact draft.");
    disagreement = false;
    malformed = true;
    expect((yield* run(draft)).text).toBe("Please read this exact draft.");
    malformed = false;
    unavailable = true;
    expect((yield* run(draft)).text).toBe("Please read this exact draft.");
    const requestCount = requests.length;
    const { classifier: _classifier, ...withoutClassifier } = settings;
    expect((yield* run(draft, withoutClassifier)).text).toBe("Please read this exact draft.");
    expect((yield* run(code, { ...settings, codeEnabled: false })).text).toBe(code);
    expect((yield* run(input, { ...settings, enabled: false })).text).toBe(
      `Private surrounding text.\n\n${spokenTable}\n\n${code}\n\nAfter.`,
    );
    expect(requests).toHaveLength(requestCount);
  }),
);
