import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

/** About 36 hours of 64 kbps speech. */
export const READ_ALOUD_CACHE_MAX_BYTES = 1024 ** 3;
/** An entry used this recently may still be read, such as by a stream that is starting. */
export const READ_ALOUD_CACHE_IN_USE_MS = 10 * 60 * 1000;

const ENTRY_FILE = /^([0-9a-f]{64})\.(?:mp3|json|text\.json)$/;

interface Entry {
  readonly files: Array<string>;
  bytes: number;
  usedAt: number;
}

/**
 * Removes the least recently used entries until the cache fits in `maxBytes`, and leftovers of
 * interrupted writes. An entry in use is never removed, even when the cache stays over the cap.
 */
export const makeReadAloudCachePruner = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const modifiedAt = (stat: FileSystem.File.Info) =>
    Option.match(stat.mtime, { onNone: () => 0, onSome: (date) => date.getTime() });
  return Effect.fn("readAloudCache.prune")(function* (input: {
    readonly directory: string;
    readonly now: number;
    readonly maxBytes: number;
  }) {
    const removed = { files: 0, bytes: 0 };
    if (!(yield* fs.exists(input.directory))) return removed;
    const entries = new Map<string, Entry>();
    const leftovers: Array<string> = [];
    for (const name of yield* fs.readDirectory(input.directory)) {
      const file = path.join(input.directory, name);
      const key = ENTRY_FILE.exec(name)?.[1];
      // A `.tmp` file is an interrupted atomic write.
      if (key === undefined) {
        if (name.endsWith(".tmp")) leftovers.push(file);
        continue;
      }
      // A file can go between the listing and the stat, when a write replaces it.
      const stat = yield* fs.stat(file).pipe(Effect.option);
      if (Option.isNone(stat) || stat.value.type !== "File") continue;
      // Speech text shares no key with audio, so its own suffix keeps it a separate entry.
      const id = name.endsWith(".text.json") ? `${key}.text` : key;
      const entry = entries.get(id) ?? { files: [], bytes: 0, usedAt: 0 };
      entry.files.push(file);
      entry.bytes += Number(stat.value.size);
      entry.usedAt = Math.max(entry.usedAt, modifiedAt(stat.value));
      entries.set(id, entry);
    }
    const inUse = (usedAt: number) => input.now - usedAt < READ_ALOUD_CACHE_IN_USE_MS;
    const remove = Effect.fnUntraced(function* (entry: Entry) {
      // A hit may have touched it since the scan.
      for (const file of entry.files) {
        const stat = yield* fs.stat(file).pipe(Effect.option);
        if (Option.isSome(stat) && inUse(modifiedAt(stat.value))) return false;
      }
      // The word timings first: a hit needs both files, so a half-removed entry reads as a miss.
      const timingsFirst = [...entry.files].sort(
        (a, b) => Number(b.endsWith(".json")) - Number(a.endsWith(".json")),
      );
      for (const file of timingsFirst) yield* fs.remove(file, { force: true });
      removed.files++;
      removed.bytes += entry.bytes;
      return true;
    });
    const sorted = [...entries.values()].sort((a, b) => a.usedAt - b.usedAt);
    let total = sorted.reduce((sum, entry) => sum + entry.bytes, 0);
    for (const entry of sorted) {
      if (total <= input.maxBytes) break;
      if (!inUse(entry.usedAt) && (yield* remove(entry))) total -= entry.bytes;
    }
    for (const file of leftovers) {
      const stat = yield* fs.stat(file).pipe(Effect.option);
      if (Option.isSome(stat) && !inUse(modifiedAt(stat.value)))
        yield* fs.remove(file, { force: true });
    }
    return removed;
  });
});
