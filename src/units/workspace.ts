import {
  rewriteHistory,
  type HistoryRewrite,
  type RewriteShape,
} from "./history-rewrite.js";
import type { RetentionTarget } from "./retention.js";
import { hasDistinctConflicts } from "./history.js";
import * as A from "@automerge/automerge";
import { documentId, type VaultFileSystem } from "./contracts.js";
import { canonical, text, utf8 } from "../crypto.js";
import { z } from "zod";
import {
  noFeatures,
  type Features,
  type FeatureOverrides,
} from "./scope-policy.js";

export interface WorkspaceDefaults {
  vaults: Record<string, string>;
  rootNames: Record<string, string>;
  vim: boolean;
  hotkeys: Record<string, string>;
  layout: {
    tabs: string[];
    active: string | null;
    bookmarks: string[];
    split: boolean;
    pinned?: string[];
    stacked?: boolean;
    secondary?: string | null;
    dock?: unknown;
  };
  plugins: Record<string, unknown>;
}
export type SettingOverrides<T> = T extends unknown[]
  ? T | null
  : T extends object
    ? { [K in keyof T]?: SettingOverrides<T[K]> } | null
    : T | null;
export type ComputerOverrides = {
  [K in keyof WorkspaceDefaults]: SettingOverrides<WorkspaceDefaults[K]>;
};
export interface FileWorkspace extends Record<string, unknown> {
  format: "saddle-workspace/1";
  id: string;
  name: string;
  checkpoint?: { epoch: number; generation: string };
  defaults: WorkspaceDefaults;
  computers: Record<string, ComputerOverrides>;
  features: FeatureOverrides;
}
export const emptyOverrides = (): ComputerOverrides => ({
  vaults: null,
  rootNames: null,
  vim: null,
  hotkeys: null,
  layout: null,
  plugins: null,
});
export function resolveSettings(
  workspace: FileWorkspace,
  computer: string,
): WorkspaceDefaults {
  const local = workspace.computers[computer] ?? emptyOverrides();
  const resolved = inheritSettings(
    workspace.defaults,
    local,
  ) as WorkspaceDefaults;
  // A computer's set of mounted folders replaces the default set as a whole.
  if (local.vaults != null)
    resolved.vaults = Object.fromEntries(
      Object.entries(local.vaults).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  return resolved;
}
/** Null at any depth inherits; arrays are one setting, maps inherit per key. */
function inheritSettings(defaults: unknown, override: unknown): unknown {
  if (override == null) return structuredClone(defaults);
  if (typeof override !== "object" || Array.isArray(override))
    return structuredClone(override);
  const base =
    defaults && typeof defaults === "object" && !Array.isArray(defaults)
      ? (defaults as Record<string, unknown>)
      : {};
  return Object.fromEntries(
    [...new Set([...Object.keys(base), ...Object.keys(override)])]
      .map((key) => [
        key,
        inheritSettings(base[key], (override as Record<string, unknown>)[key]),
      ])
      .filter(([, value]) => value !== undefined),
  );
}
const layoutSchema = z
  .object({
    tabs: z.array(z.string()),
    active: z.string().nullable(),
    bookmarks: z.array(z.string()),
    split: z.boolean(),
    pinned: z.array(z.string()).optional(),
    stacked: z.boolean().optional(),
    secondary: z.string().nullable().optional(),
    dock: z.unknown().optional(),
  })
  .strict();
const defaultsSchema = z
  .object({
    vaults: z.record(z.string(), z.string()),
    rootNames: z.record(z.string(), z.string()),
    vim: z.boolean(),
    hotkeys: z.record(z.string(), z.string()),
    layout: layoutSchema,
    plugins: z.record(z.string(), z.unknown()),
  })
  .strict();
const overrideSchema = z
  .object({
    vaults: z.record(z.string(), z.string().nullable()).nullable(),
    rootNames: z.record(z.string(), z.string().nullable()).nullable(),
    vim: z.boolean().nullable(),
    hotkeys: z.record(z.string(), z.string().nullable()).nullable(),
    layout: layoutSchema
      .partial()
      .extend({
        tabs: z.array(z.string()).nullish(),
        active: z.string().nullish(),
        bookmarks: z.array(z.string()).nullish(),
        split: z.boolean().nullish(),
        pinned: z.array(z.string()).nullish(),
        stacked: z.boolean().nullish(),
        secondary: z.string().nullish(),
        dock: z.unknown().nullish(),
      })
      .nullable(),
    plugins: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();
export const workspaceSchema = z
  .object({
    format: z.literal("saddle-workspace/1"),
    id: z.string().min(1),
    name: z.string(),
    checkpoint: z
      .object({
        epoch: z.number().int().nonnegative(),
        generation: z.string().min(1),
      })
      .strict()
      .optional(),
    defaults: defaultsSchema,
    computers: z.record(z.string(), overrideSchema),
    features: z
      .object({ history: z.boolean().optional(), sync: z.boolean().optional() })
      .strict(),
  })
  .strict();
function validate(doc: A.Doc<FileWorkspace>) {
  workspaceSchema.parse(A.toJS(doc));
}
/** Preserve unchanged CRDT objects when updating inert JSON settings. */
export function patchSettings(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
) {
  for (const key of Object.keys(target))
    if (!Object.hasOwn(source, key)) delete target[key];
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) {
      delete target[key];
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (
        !target[key] ||
        typeof target[key] !== "object" ||
        Array.isArray(target[key])
      )
        target[key] = {};
      patchSettings(
        target[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else if (
      Array.isArray(value) &&
      Array.isArray(target[key]) &&
      value.length === (target[key] as unknown[]).length &&
      value.every(
        (item, index) =>
          item &&
          typeof item === "object" &&
          "id" in item &&
          item.id ===
            ((target[key] as unknown[])[index] as { id?: string })?.id,
      )
    ) {
      value.forEach((item, index) =>
        patchSettings(
          (target[key] as Record<string, unknown>[])[index],
          item as Record<string, unknown>,
        ),
      );
    } else if (canonical(target[key]) !== canonical(value))
      target[key] = structuredClone(value);
  }
}
export type WorkspaceFreeze = {
  token: string;
  heads: A.Heads;
  epoch: number;
  rewrite?: HistoryRewrite;
};
export const workspaceEpoch = (doc: FileWorkspace) =>
  doc.checkpoint?.epoch ?? 0;
export const workspaceGeneration = (doc: FileWorkspace) =>
  doc.checkpoint?.generation ?? doc.id;
const workspaceRewriteShape: RewriteShape<FileWorkspace> = {
  created: "Workspace created",
  empty: (current) => ({
    ...current,
    name: "Workspace",
    computers: {},
    defaults: {
      ...current.defaults,
      vaults: {},
      rootNames: {},
      vim: false,
      hotkeys: {},
      plugins: {},
      layout: { tabs: [], active: null, bookmarks: [], split: false },
    },
  }),
  envelope: (value, current, token) => ({
    ...value,
    format: current.format,
    id: current.id,
    features: current.features,
    checkpoint: { epoch: workspaceEpoch(current) + 1, generation: token },
  }),
};
/** Workspace storage is an app-level capability, never a vault capability. */
export class WorkspaceStore {
  private resolved = new Map<string, WorkspaceDefaults>();
  private frozen?: WorkspaceFreeze;
  get historyOperationPending() {
    return !!this.frozen?.rewrite;
  }
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private constructor(
    readonly storage: VaultFileSystem,
    private value: A.Doc<FileWorkspace>,
  ) {}
  static async open(
    storage: VaultFileSystem,
    computer: string,
    name = "Workspace",
    id: string = crypto.randomUUID(),
  ) {
    documentId(computer);
    const plain = await storage.read("workspace.json");
    const saved =
      plain && workspaceSchema.parse(JSON.parse(text.decode(plain)));
    const archive =
      saved && (saved.features.history || saved.features.sync)
        ? await storage.read("workspace.automerge")
        : undefined;
    let doc = saved
      ? archive
        ? A.load<FileWorkspace>(archive)
        : A.from<FileWorkspace>(saved)
      : A.from<FileWorkspace>({
          format: "saddle-workspace/1",
          id,
          name,
          defaults: {
            vaults: {},
            rootNames: {},
            vim: false,
            hotkeys: {},
            layout: { tabs: [], active: null, bookmarks: [], split: false },
            plugins: {},
          },
          computers: {},
          features: {},
        });
    validate(doc);
    if (!doc.computers[computer])
      doc = A.change(doc, (d) => {
        d.computers[computer] = emptyOverrides();
      });
    const store = new WorkspaceStore(storage, doc);
    await store.persist(doc, true);
    return store;
  }
  get current(): FileWorkspace {
    return this.value;
  }
  settings(computer: string) {
    let value = this.resolved.get(computer);
    if (!value) {
      value = resolveSettings(this.value, computer);
      const freeze = (value: unknown): void => {
        if (value && typeof value === "object") {
          Object.values(value).forEach(freeze);
          Object.freeze(value);
        }
      };
      freeze(value);
      this.resolved.set(computer, value);
    }
    return value;
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private async persist(doc: A.Doc<FileWorkspace>, force = false) {
    const changed =
      A.getHeads(this.value).sort().join() !== A.getHeads(doc).sort().join();
    if (!changed && !force) return;
    validate(doc);
    if (doc.features.history || doc.features.sync)
      await this.storage.writeAtomic("workspace.automerge", A.save(doc));
    else await this.storage.remove("workspace.automerge");
    await this.storage.writeAtomic(
      "workspace.json",
      utf8.encode(JSON.stringify(A.toJS(doc), null, 2) + "\n"),
    );
    this.value = doc;
    this.resolved.clear();
    if (changed) this.listeners.forEach((listener) => listener());
  }
  update(change: (workspace: FileWorkspace) => void) {
    const work = this.queue.then(() => {
      if (this.frozen)
        throw Error(
          "Workspace history is being rewritten; retry the settings change when it completes",
        );
      return this.persist(A.change(A.clone(this.value), change));
    });
    this.queue = work.catch(() => {});
    return work;
  }
  get features(): Features {
    return { ...noFeatures, ...this.value.features };
  }
  configure(features: FeatureOverrides) {
    return this.update((doc) => {
      for (const [key, value] of Object.entries(features)) {
        const feature = key as keyof Features;
        if (value === undefined) delete doc.features[feature];
        else doc.features[feature] = value;
      }
    });
  }
  merge(bytes: Uint8Array) {
    const incoming = A.load<FileWorkspace>(bytes);
    validate(incoming);
    if (workspaceGeneration(incoming) !== workspaceGeneration(this.value))
      throw Error(
        "Workspace history requires authenticated checkpoint agreement",
      );
    if (incoming.id !== this.value.id || incoming.format !== this.value.format)
      throw Error("Different workspace");
    const work = this.queue.then(() =>
      this.persist(A.merge(A.clone(this.value), incoming)),
    );
    this.queue = work.catch(() => {});
    return work;
  }
  /** Explicitly joining a workspace replaces its settings, never local capabilities. */
  adopt(bytes: Uint8Array, computer: string, vaults: Record<string, string>) {
    documentId(computer);
    const incoming = A.load<FileWorkspace>(bytes);
    validate(incoming);
    const work = this.queue.then(() =>
      this.persist(
        A.change(A.clone(incoming), (d) => {
          d.computers[computer] ??= emptyOverrides();
          d.computers[computer].vaults = vaults;
        }),
      ),
    );
    this.queue = work.catch(() => {});
    return work;
  }
  document() {
    return this.value;
  }
  rewriteHistory(operation: HistoryRewrite) {
    const work = this.queue.then(async () => {
      if (!this.features.history) throw Error("Workspace history is disabled");
      if (this.frozen)
        throw Error("A workspace history operation is in progress");
      await this.persist(
        rewriteHistory(
          this.value,
          operation,
          crypto.randomUUID(),
          workspaceRewriteShape,
        ),
      );
    });
    this.queue = work.catch(() => {});
    return work;
  }
  retentionTarget(
    persist: (freeze?: WorkspaceFreeze) => Promise<void>,
    restored?: WorkspaceFreeze,
  ): RetentionTarget<FileWorkspace> {
    this.frozen = restored;
    return {
      doc: () => this.value,
      historyEnabled: () => this.features.history,
      retainsHistory: () => this.features.history,
      hasDirtyDraft: () => false,
      getFreeze: () => this.frozen,
      epoch: workspaceEpoch,
      generation: workspaceGeneration,
      validateHistoryRewrite: (_, operation) =>
        validate(
          rewriteHistory(
            this.value,
            operation,
            crypto.randomUUID(),
            workspaceRewriteShape,
          ),
        ),
      freezeHistory: async (id, token, heads, rewrite) => {
        const work = this.queue.then(async () => {
          if (
            id !== this.value.id ||
            (!rewrite && this.features.history) ||
            hasDistinctConflicts(this.value) ||
            A.getHeads(this.value).sort().join() !== [...heads].sort().join() ||
            (this.frozen && this.frozen.token !== token)
          )
            return false;
          const freeze = {
            token,
            heads,
            epoch: workspaceEpoch(this.value),
            ...(rewrite ? { rewrite } : {}),
          };
          await persist(freeze);
          this.frozen = freeze;
          this.listeners.forEach((listener) => listener());
          return true;
        });
        this.queue = work.catch(() => {});
        return work;
      },
      unfreezeHistory: async (_, token) => {
        if (this.frozen?.token !== token) return;
        await persist();
        this.frozen = undefined;
        this.listeners.forEach((listener) => listener());
      },
      acceptCheckpoint: async (id, bytes, token) => {
        const work = this.queue.then(async () => {
          const incoming = A.load<FileWorkspace>(bytes);
          validate(incoming);
          if (workspaceGeneration(incoming) === workspaceGeneration(this.value))
            return;
          const freeze = this.frozen;
          if (
            id !== this.value.id ||
            incoming.id !== id ||
            !freeze ||
            freeze.token !== token ||
            workspaceEpoch(incoming) !== workspaceEpoch(this.value) + 1 ||
            !freeze.rewrite
          )
            throw Error("Workspace checkpoint requires an agreed freeze");
          const expected = rewriteHistory(
            A.view(this.value, freeze.heads),
            freeze.rewrite,
            token,
            workspaceRewriteShape,
          );
          if (!A.hasHeads(incoming, A.getHeads(expected)))
            throw Error(
              "Workspace history does not match the agreed operation",
            );
          await this.persist(incoming);
          await persist();
          this.frozen = undefined;
        });
        this.queue = work.catch(() => {});
        await work;
      },
    };
  }
  checkpointHistory(heads: A.Heads, token: string, operation?: HistoryRewrite) {
    const work = this.queue.then(async () => {
      if (
        !operation ||
        this.frozen?.token !== token ||
        A.getHeads(this.value).sort().join() !== [...heads].sort().join()
      )
        throw Error("Workspace history requires an agreed freeze");
      await this.persist(
        rewriteHistory(this.value, operation, token, workspaceRewriteShape),
      );
      return this.value;
    });
    this.queue = work.catch(() => {});
    return work;
  }
  historyVersionCount() {
    return this.value.features.history ? A.stats(this.value).numChanges : 0;
  }
  history() {
    if (!this.value.features.history)
      throw Error("Workspace history is disabled");
    return A.getHistory(this.value).map(({ change }) => ({
      hash: change.hash,
      time: change.time,
      message: change.message,
    }));
  }
  historySnapshot(hash: string): FileWorkspace {
    if (!this.value.features.history)
      throw Error("Workspace history is disabled");
    return A.toJS(A.view(this.value, [hash]));
  }
  export() {
    return A.save(this.value);
  }
  flush() {
    return this.queue.then(() => {});
  }
  /** JSON is a readable projection. Import is explicit, and never runs commands. */
  static parseJSON(bytes: Uint8Array): unknown {
    return JSON.parse(text.decode(bytes));
  }
}
