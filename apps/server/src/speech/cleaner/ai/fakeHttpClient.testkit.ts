import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";

export interface FakeRequest {
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

/** Answers provider and classifier calls in-process, so no test opens a socket or pays for a call. */
export const fakeHttpClient = (handle: (request: FakeRequest) => Effect.Effect<Response>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      handle({
        path: url.pathname,
        authorization: request.headers.authorization,
        body:
          request.body._tag === "Uint8Array"
            ? JSON.parse(new TextDecoder().decode(request.body.body))
            : undefined,
      }).pipe(Effect.map((response) => HttpClientResponse.fromWeb(request, response))),
    ),
  );
