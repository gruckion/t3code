import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { makeReadAloudCachePruner, READ_ALOUD_CACHE_IN_USE_MS } from "./readAloudCacheCleanup.ts";

const DAY_MS = 86_400_000;
const NOW = 100 * DAY_MS;

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-read-aloud-cache-" });
  const prune = yield* makeReadAloudCachePruner;
  const write = Effect.fnUntraced(function* (file: string, size: number, usedAt: number) {
    const target = path.join(directory, file);
    yield* fs.writeFile(target, new Uint8Array(size));
    // utimes takes seconds.
    yield* fs.utimes(target, usedAt / 1000, usedAt / 1000);
  });
  /** Audio of `bytes` bytes and its word timings, last used at `usedAt`. */
  const entry = Effect.fnUntraced(function* (name: string, bytes: number, usedAt: number) {
    const key = name.repeat(64);
    yield* write(`${key}.mp3`, bytes, usedAt);
    yield* write(`${key}.json`, 0, usedAt);
    return key;
  });
  const names = fs.readDirectory(directory).pipe(Effect.map((files) => [...files].sort()));
  return { fs, path, directory, prune, write, entry, names };
});

describe("read aloud cache cleanup", () => {
  it.effect("over the size cap, removes the least recently used entries until it fits", () =>
    Effect.gen(function* () {
      const { fs, path, directory, prune, write, entry, names } = yield* fixture;
      yield* entry("a", 40, NOW - 9 * DAY_MS);
      yield* write(`${"b".repeat(64)}.text.json`, 40, NOW - 8 * DAY_MS);
      const newer = yield* entry("c", 40, NOW - 2 * DAY_MS);
      const newest = yield* entry("d", 40, NOW - DAY_MS);
      const crashedWrite = path.join(directory, `${newer}.mp3.1234.tmp`);
      yield* fs.writeFileString(crashedWrite, "partial");
      yield* fs.utimes(crashedWrite, 1, 1);
      expect(yield* prune({ directory, now: NOW, maxBytes: 100 })).toEqual({
        files: 2,
        bytes: 80,
      });
      expect(yield* names).toEqual([newer, newest].flatMap((key) => [`${key}.json`, `${key}.mp3`]));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("never removes an entry that may be in use, even over the size cap", () =>
    Effect.gen(function* () {
      const { directory, prune, entry, names } = yield* fixture;
      const playing = yield* entry("a", 500, NOW - READ_ALOUD_CACHE_IN_USE_MS + 60_000);
      yield* entry("b", 500, NOW - READ_ALOUD_CACHE_IN_USE_MS - 60_000);
      expect(yield* prune({ directory, now: NOW, maxBytes: 100 })).toEqual({
        files: 1,
        bytes: 500,
      });
      expect(yield* names).toEqual([`${playing}.json`, `${playing}.mp3`]);
      expect(yield* prune({ directory, now: NOW, maxBytes: 0 })).toEqual({ files: 0, bytes: 0 });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("a missing cache directory is nothing to clean", () =>
    Effect.gen(function* () {
      const { path, directory, prune } = yield* fixture;
      expect(
        yield* prune({ directory: path.join(directory, "missing"), now: NOW, maxBytes: 0 }),
      ).toEqual({ files: 0, bytes: 0 });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
