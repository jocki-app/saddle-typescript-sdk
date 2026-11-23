import type * as A from "@automerge/automerge";
import { RecordFiles } from "./record-container.js";
import {
  documentId,
  filePath,
  type VaultFileSystem,
  type MaterializedFile,
} from "./contracts.js";
import { text, utf8, canonical } from "../crypto.js";
import { type FeatureOverrides } from "./scope-policy.js";

export const companionSuffix = ".saddle";
export const companionPath = (path: string) => {
  const parts = filePath(path).split("/");
  parts[parts.length - 1] = "." + parts.at(-1)! + companionSuffix;
  return parts.join("/");
};
export const companionOwner = (path: string) => {
  const parts = filePath(path).split("/");
  const name = parts.at(-1)!;
  if (!name.startsWith(".") || !name.endsWith(companionSuffix))
    throw Error("Invalid companion filename");
  parts[parts.length - 1] = name.slice(1, -companionSuffix.length);
  return filePath(parts.join("/"));
};
export const companionDescriptor = "descriptor.json";
export const resourceName = "resource.json";
export const contentName = "content.automerge";
export interface CompanionDescriptor {
  format: "saddle-companion/1";
  id: string;
  kind: "file" | "folder";
  features: FeatureOverrides;
  materialized?: MaterializedFile;
  shares?: Record<string, string>;
  deleted?: boolean;
  deletedPath?: string;
  namedKeys?: string[];
  /** Protect the archive until its known peers complete the retention barrier. */
  retention?: { document: string; control: string };
}
export function parseCompanion(bytes: Uint8Array): CompanionDescriptor {
  const value = JSON.parse(text.decode(bytes)) as CompanionDescriptor;
  if (
    value.format !== "saddle-companion/1" ||
    !["file", "folder"].includes(value.kind) ||
    !value.features ||
    typeof value.features !== "object" ||
    Array.isArray(value.features)
  )
    throw Error("Invalid SADDLE companion");
  documentId(value.id);
  if (
    value.retention &&
    [value.retention.document, value.retention.control].some(
      (url) => typeof url !== "string" || !url || url.length > 4096,
    )
  )
    throw Error("Invalid retention reference");
  for (const [key, flag] of Object.entries(value.features))
    if (!["history", "sync"].includes(key) || typeof flag !== "boolean")
      throw Error("Invalid companion feature override");
  if (value.deletedPath) filePath(value.deletedPath);
  if (
    value.namedKeys &&
    (!Array.isArray(value.namedKeys) ||
      value.namedKeys.some(
        (key) => typeof key !== "string" || !/^[a-z][a-z0-9.-]*$/.test(key),
      ) ||
      new Set(value.namedKeys).size !== value.namedKeys.length)
  )
    throw Error("Invalid unit named keys");
  if (value.materialized) {
    filePath(value.materialized.path);
    if (
      value.materialized.path.includes("/") ||
      (value.materialized.sidecar &&
        value.materialized.sidecar.path !== resourceName)
    )
      throw Error("A companion checkpoint must use file-local paths");
  }
  return value;
}
const hasSettings = (descriptor: CompanionDescriptor) =>
  Object.keys(descriptor.features).length ||
  descriptor.namedKeys?.length ||
  Object.keys(descriptor.shares ?? {}).length ||
  descriptor.deleted ||
  descriptor.retention;
/** One binary container per ordinary file/folder; root access is a separate capability. */
export class Companions {
  private root?: VaultFileSystem;
  constructor(readonly fs: VaultFileSystem) {}
  private async target(path: string, name: string, create = false) {
    filePath(name);
    if (path)
      return { fs: new RecordFiles(this.fs, companionPath(path)), path: name };
    if (!this.fs.companionRoot)
      throw Error(
        "Access to the opened folder's sibling companion is unavailable. Open its parent to manage folder features.",
      );
    if (create || !this.root) {
      const granted = await this.fs.companionRoot(create);
      this.root ??= granted;
    }
    return this.root ? { fs: this.root, path: name } : undefined;
  }
  async read(path: string, name: string) {
    if (!path && !this.fs.companionRoot) return;
    const target = await this.target(path, name);
    return target?.fs.read(target.path);
  }
  async write(path: string, name: string, bytes: Uint8Array) {
    const target = await this.target(path, name, true);
    if (!target)
      throw Error(
        "Grant access to the opened folder’s parent to create its companion",
      );
    if (name.endsWith(".automerge")) {
      await target.fs.writeAtomic(target.path, bytes);
      return;
    }
    const previous = await target.fs.read(target.path);
    if (
      previous &&
      previous.length === bytes.length &&
      previous.every((b, i) => b === bytes[i])
    )
      return;
    await target.fs.writeAtomic(target.path, bytes);
  }
  async documentChanges(path: string, name: string) {
    const target = await this.target(path, name);
    if (!target) return 0;
    if (!(target.fs instanceof RecordFiles))
      throw Error("Binary named-record storage is required");
    return target.fs.documentChanges(name);
  }
  async saveDocument<T>(path: string, name: string, doc: A.Doc<T>) {
    const target = await this.target(path, name, true);
    if (!target)
      throw Error(
        "Grant access to the opened folder’s parent to create its companion",
      );
    if (!(target.fs instanceof RecordFiles))
      throw Error("Binary named-record storage is required");
    await target.fs.saveDocument(name, doc);
  }
  async stat(path: string, name: string) {
    const target = await this.target(path, name);
    return target?.fs.stat?.(name);
  }
  async remove(path: string, name: string) {
    if (!path && !this.fs.companionRoot) return;
    const target = await this.target(path, name);
    await target?.fs.remove(target.path);
  }
  async descriptor(path: string) {
    const bytes = await this.read(path, companionDescriptor);
    return bytes ? parseCompanion(bytes) : undefined;
  }
  async updateDescriptor(
    path: string,
    change: (value: CompanionDescriptor | undefined) => CompanionDescriptor,
  ) {
    const target = await this.target(path, companionDescriptor, true);
    if (!target || !(target.fs instanceof RecordFiles))
      throw Error("Named binary records are required for unit metadata");
    await target.fs.updateJSON<CompanionDescriptor>(
      companionDescriptor,
      (prior) => {
        if (prior) parseCompanion(utf8.encode(JSON.stringify(prior)));
        return parseCompanion(utf8.encode(JSON.stringify(change(prior))));
      },
    );
  }
  async describe(path: string, descriptor: CompanionDescriptor) {
    await this.updateDescriptor(path, () => descriptor);
  }
  async move(from: string, to: string) {
    if (from === to) return;
    const prior = await this.descriptor(from);
    if (!prior) return;
    const existing = await this.descriptor(to);
    if (existing) {
      if (existing.id !== prior.id || canonical(existing) !== canonical(prior))
        throw Error("Companion destination already exists");
      return;
    }
    if (!this.fs.move)
      throw Error(
        "Moving companion containers is unavailable on this platform",
      );
    await this.fs.move(companionPath(from), companionPath(to));
  }
  async cleanup(path: string) {
    const descriptor = await this.descriptor(path);
    if (!descriptor || hasSettings(descriptor)) return;
    for (const name of [resourceName, contentName, "scope.automerge"])
      if (await this.read(path, name)) return;
    // Unknown plugin records belong to the unit and must survive cleanup.
    const target = await this.target(path, companionDescriptor);
    if (!target) return;
    const members = await target.fs.list();
    if (
      members.some(
        (member) =>
          ![companionDescriptor, "baseline.bin", "membership.json"].includes(
            member,
          ),
      )
    )
      return;
    if (target.fs instanceof RecordFiles)
      await target.fs.removeIfOnly(
        [companionDescriptor, "baseline.bin", "membership.json"],
        async (read) => {
          const bytes = await read(companionDescriptor);
          return !!bytes && !hasSettings(parseCompanion(bytes));
        },
      );
  }
}
