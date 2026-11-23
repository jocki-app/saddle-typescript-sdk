import * as A from "@automerge/automerge";
import { canonical } from "../crypto.js";

export interface HistoryChangeSize {
  added: number;
  removed: number;
}

export function historyMessage(event: string, description = "") {
  if (typeof description !== "string" || description.length > 2000)
    throw Error("Version descriptions must be 2,000 characters or fewer");
  return description.trim() ? `${event}\n\n${description.trim()}` : event;
}

export function historyLabel(message: string | null, fallback = "Update file") {
  const [event, ...description] = (message || fallback).split("\n");
  return { event, description: description.join("\n").trim() };
}

/** Count actual text edits with Automerge's text diff, including replacements of equal length. */
export function textChangeSize(
  before: string,
  after: string,
): HistoryChangeSize {
  if (before === after) return { added: 0, removed: 0 };
  let text = before;
  const count = { added: 0, removed: 0 };
  const original = A.from({ text: before });
  const next = A.change(
    original,
    {
      patchCallback: (patches) => {
        for (const patch of patches) {
          if (patch.path[0] !== "text") continue;
          const index = Number(patch.path[1] ?? 0);
          if (patch.action === "splice") {
            count.added += Array.from(patch.value).length;
            text = text.slice(0, index) + patch.value + text.slice(index);
          } else if (patch.action === "del") {
            const length = patch.length ?? 1;
            count.removed += Array.from(
              text.slice(index, index + length),
            ).length;
            text = text.slice(0, index) + text.slice(index + length);
          }
        }
      },
    },
    (doc) => A.updateText(doc, ["text"], after),
  );
  A.free(next);
  return count;
}

/** Equal concurrent assignments contain no alternative data to retain. */
const conflictCache = new WeakMap<object, boolean>();
export function hasDistinctConflicts(value: object): boolean {
  const cached = conflictCache.get(value);
  if (cached !== undefined) return cached;
  const result = Object.keys(value).some((key) => {
    const registers = Object.values(
      A.getConflicts(value, Array.isArray(value) ? Number(key) : key) ?? {},
    );
    if (registers.length > 1 && new Set(registers.map(canonical)).size > 1)
      return true;
    const candidates = registers.length
      ? registers
      : [(value as Record<string, unknown>)[key]];
    return candidates.some(
      (item) =>
        !!item &&
        typeof item === "object" &&
        !(item instanceof Uint8Array) &&
        hasDistinctConflicts(item),
    );
  });
  conflictCache.set(value, result);
  return result;
}
