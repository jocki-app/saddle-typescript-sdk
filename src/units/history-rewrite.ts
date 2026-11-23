import * as A from "@automerge/automerge";
import { canonical } from "../crypto.js";
import { hasDistinctConflicts } from "./history.js";
import type { FileDocument } from "./contracts.js";
import { folderEpoch, type FolderDocument } from "./folder-document.js";

export type HistoryRewrite =
  { kind: "reset"; time: number } | { kind: "drop"; hash: string };
export function validateRewrite(value: HistoryRewrite) {
  if (
    !value ||
    (value.kind !== "reset" && value.kind !== "drop") ||
    (value.kind === "drop"
      ? !/^[a-f0-9]{64}$/.test(value.hash)
      : !Number.isSafeInteger(value.time) || value.time < 0)
  )
    throw Error("Invalid history operation");
}

/** Replay a text edit against a changed baseline using Automerge's character identities. */
function replayText(before: string, after: string, current: string) {
  if (before === current) return after;
  const base = A.from({ text: before }, { actor: "01" });
  const local = A.change(A.clone(base, { actor: "02" }), (d) =>
    A.updateText(d, ["text"], current),
  );
  const edit = A.change(A.clone(base, { actor: "03" }), (d) =>
    A.updateText(d, ["text"], after),
  );
  const result = A.merge(local, edit).text;
  return result;
}
function object(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array)
  );
}
/** Apply only this version's delta, rather than restoring its entire old snapshot. */
export function replayHistoryDelta(
  before: unknown,
  after: unknown,
  current: unknown,
  path: string[] = [],
): unknown {
  if (canonical(before) === canonical(after)) return structuredClone(current);
  if (
    path.length === 1 &&
    path[0] === "text" &&
    typeof before === "string" &&
    typeof after === "string" &&
    typeof current === "string"
  )
    return replayText(before, after, current);
  if (object(before) && object(after)) {
    const result = object(current) ? structuredClone(current) : {};
    for (const key of new Set([
      ...Object.keys(before),
      ...Object.keys(after),
    ])) {
      if (!Object.hasOwn(after, key)) delete result[key];
      else if (!Object.hasOwn(before, key))
        result[key] = structuredClone(after[key]);
      else if (canonical(before[key]) !== canonical(after[key]))
        result[key] = replayHistoryDelta(before[key], after[key], result[key], [
          ...path,
          key,
        ]);
    }
    return result;
  }
  if (Array.isArray(before) && Array.isArray(after) && Array.isArray(current)) {
    const codes = new Map<string, string>(),
      values = new Map<string, unknown>();
    const encode = (items: unknown[]) =>
      items
        .map((value) => {
          const key = canonical(value);
          let code = codes.get(key);
          if (!code) {
            if (codes.size >= 1000000)
              throw Error("This list is too large to replay safely");
            code = String.fromCodePoint(0xe000 + codes.size);
            codes.set(key, code);
            values.set(code, value);
          }
          return code;
        })
        .join("");
    return Array.from(
      replayText(encode(before), encode(after), encode(current)),
      (code) => structuredClone(values.get(code)),
    );
  }
  // Arrays and binary replacements are explicit assignments, as in the normal save contract.
  return structuredClone(after);
}

export interface RewriteShape<T> {
  empty(current: T): T;
  envelope(value: T, current: T, token: string): T;
  created: string;
}
/** A deterministic new DAG. No encoded change from the retired generation is retained. */
export function rewriteHistory<T extends Record<string, unknown>>(
  doc: A.Doc<T>,
  operation: HistoryRewrite,
  token: string,
  shape: RewriteShape<T>,
): A.Doc<T> {
  validateRewrite(operation);
  if (hasDistinctConflicts(doc))
    throw Error("Resolve current data conflicts before editing history");
  const current = A.toJS(doc),
    actor = token.replaceAll("-", "");
  if (!/^[a-f0-9]{32}$/.test(actor))
    throw Error("Invalid history generation token");
  let next = A.init<T>({ actor });
  const append = (value: T, message: string | null, time: number) => {
    const state = shape.envelope(value, current, token);
    const prior = A.getHeads(next).join();
    next = A.change(next, { message: message ?? "", time }, (draft) =>
      patch(draft, state),
    );
    // Keep named versions even when their replay is now empty.
    if (A.getHeads(next).join() === prior)
      next = A.emptyChange(next, { message: message ?? "", time });
  };
  if (operation.kind === "reset") {
    append(current, shape.created, operation.time);
    return next;
  }
  const changes = A.getAllChanges(doc);
  if (!changes.some((bytes) => A.decodeChange(bytes).hash === operation.hash))
    throw Error("Unknown history version");
  let before = shape.empty(current),
    rebased = structuredClone(before);
  const heads = new Set<string>();
  for (const bytes of changes) {
    const change = A.decodeChange(bytes);
    for (const parent of change.deps) heads.delete(parent);
    heads.add(change.hash);
    const after = A.toJS(A.view(doc, [...heads]));
    if (change.hash !== operation.hash) {
      rebased = replayHistoryDelta(before, after, rebased) as T;
      append(rebased, change.message, change.time);
    }
    before = after;
  }
  if (!A.getHeads(next).length)
    append(rebased, shape.created, A.decodeChange(changes[0]).time);
  return next;
}

export const fileRewriteShape: RewriteShape<FileDocument> = {
  created: "File created",
  empty: (current) => ({
    ...current,
    text: "",
    bytes: new Uint8Array(),
    csdb: null,
    resource: null,
    invalidResource: null,
    template: null,
  }),
  envelope: (value, current, token) => ({
    ...value,
    format: current.format,
    id: current.id,
    kind: current.kind,
    mime: value.mime || current.mime,
    retainHistory: current.retainHistory ?? true,
    epoch: current.epoch + 1,
    generation: token,
  }),
};
export const folderRewriteShape: RewriteShape<FolderDocument> = {
  created: "Folder created",
  empty: (current) => ({ ...current, namedKeys: [], resource: null }),
  // Folder history edits declarations; child content and access policy have their own controls.
  envelope: (value, current, token) => ({
    ...value,
    format: current.format,
    id: current.id,
    features: current.features,
    children: current.children,
    retainHistory: current.retainHistory ?? true,
    checkpoint: { epoch: folderEpoch(current) + 1, generation: token },
  }),
};
/** Preserve unchanged CRDT objects while replaying snapshots into the new DAG. */
function patch(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
) {
  for (const key of Object.keys(target))
    if (!Object.hasOwn(source, key)) delete target[key];
  for (const [key, value] of Object.entries(source)) {
    if (canonical(target[key]) === canonical(value)) continue;
    if (object(value) && object(target[key])) patch(target[key], value);
    else if (typeof value === "string" && typeof target[key] === "string")
      A.updateText(target, [key], value);
    else target[key] = structuredClone(value);
  }
}
