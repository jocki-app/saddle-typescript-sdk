/** Explicit local API used by language bindings and the command-line client. */
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { NodeVaultFiles } from "./vault-files.js";
import { VaultWatcher } from "./vault-watch.js";
import { Libgit2RenameMatcher } from "./vault-renames.js";
import { openNodeRepository } from "./repository.js";
import { RecordFiles } from "../units/record-container.js";
import { FileVault } from "../units/vault.js";
import { WorkspaceStore } from "../units/workspace.js";
import { ProtectedFileSync } from "../units/protected-sync.js";
import { shareLink, parseShareLink } from "../units/share-invitation.js";
import { parseResource, serializeResource } from "../units/metadata.js";
import { companionPath } from "../units/companions.js";
import type { VaultFileSystem } from "../units/contracts.js";
import { utf8, text } from "../crypto.js";

export interface UnitRequest {
  method: string;
  target: string;
  value?: unknown;
  hash?: string;
  state?: "unset" | "disabled" | "enabled";
  profile?: string;
  endpoints?: string[];
  invitation?: string;
  contact?: string;
  role?: "read" | "edit";
  broadcast?: boolean;
  renameExecutable?: string;
  record?: string;
  bytes?: string;
}
const json = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value, (_key, item) =>
      item instanceof Uint8Array
        ? Buffer.from(item).toString("base64")
        : typeof item === "bigint"
          ? item.toString()
          : item,
    ),
  );
/** Opening a single file never grants its parent folder's sidecar or its siblings. */
function fileBoundary(fs: NodeVaultFiles, name: string): VaultFileSystem {
  const allowed = new Set([name, companionPath(name)]);
  const check = (value: string) => {
    if (!allowed.has(value))
      throw Error("Path is outside the selected file capability");
    return value;
  };
  return {
    read: (p) => fs.read(check(p)),
    writeAtomic: (p, v) => fs.writeAtomic(check(p), v),
    remove: (p) => fs.remove(check(p)),
    readRange: (p, o, n) => fs.readRange(check(p), o, n),
    writeAt: (p, o, v) => fs.writeAt(check(p), o, v),
    list: async () => (await fs.list()).filter((p) => allowed.has(p)),
    scan: async () => (await fs.scan()).filter((p) => allowed.has(p.path)),
    stat: (p) => fs.stat(check(p)),
    directories: async () => [],
  };
}
export async function operate(
  request: UnitRequest,
  options: { signal?: AbortSignal } = {},
): Promise<unknown> {
  if (
    !request ||
    typeof request.method !== "string" ||
    typeof request.target !== "string"
  )
    throw Error("A method and explicit target path are required");
  const absolute = path.resolve(request.target);
  if (request.method.startsWith("archive.")) {
    const archive = absolute.endsWith(".saddle")
      ? absolute
      : path.join(
          path.dirname(absolute),
          "." + path.basename(absolute) + ".saddle",
        );
    const fs = await NodeVaultFiles.open(path.dirname(archive), {
        create: false,
      }),
      unlock = await fs.acquireWriter();
    try {
      const records = new RecordFiles(fs, path.basename(archive));
      if (request.method === "archive.list")
        return Promise.all(
          (await records.list()).map(async (name) => ({
            name,
            ...(await records.stat(name)),
          })),
        );
      if (request.method === "archive.verify") {
        for (const name of await records.list()) await records.read(name);
        return { valid: true, records: await records.list() };
      }
      if (request.method === "archive.get") {
        if (!request.record) throw Error("Choose a record");
        const bytes = await records.read(request.record);
        return bytes ? { bytes: Buffer.from(bytes).toString("base64") } : null;
      }
      if (request.method === "archive.put") {
        if (!request.record || typeof request.bytes !== "string")
          throw Error("A record and base64 payload are required");
        if (request.record.endsWith(".automerge"))
          throw Error("Use history operations for retained documents");
        await records.writeAtomic(
          request.record,
          Buffer.from(request.bytes, "base64"),
        );
        return { saved: true };
      }
      throw Error("Unknown archive operation");
    } finally {
      await unlock();
    }
  }
  const info = await lstat(absolute);
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
    throw Error("Select a regular file or folder");
  const folder = info.isDirectory(),
    root = folder ? absolute : path.dirname(absolute),
    name = folder ? "" : path.basename(absolute);
  const profile = path.resolve(
    request.profile ??
      path.join(
        process.env.XDG_DATA_HOME ?? path.join(homedir(), ".local/share"),
        "saddle",
        "cli",
      ),
  );
  if (profile === absolute)
    throw Error("The private profile directory cannot be the selected unit");
  const relativeProfile = path
    .relative(root, profile)
    .split(path.sep)
    .join("/");
  const excluded =
    relativeProfile &&
    !relativeProfile.startsWith("../") &&
    !path.isAbsolute(relativeProfile)
      ? [relativeProfile]
      : [];
  const fs = await NodeVaultFiles.open(root, {
      create: false,
      exclude: excluded,
    }),
    unlock = await fs.acquireWriter();
  const errors: unknown[] = [];
  let repository: Awaited<ReturnType<typeof openNodeRepository>> | undefined;
  let sync: ProtectedFileSync | undefined;
  try {
    const id = createHash("sha256").update(absolute).digest("hex");
    const local = await NodeVaultFiles.open(path.join(profile, "units", id));
    const capability = folder ? fs : fileBoundary(fs, name);
    const vault = await FileVault.open(capability, "cli", {
      local,
      renames: request.renameExecutable
        ? new Libgit2RenameMatcher(path.resolve(request.renameExecutable))
        : undefined,
    });
    const file = folder ? undefined : vault.find(name);
    if (!folder && !file) throw Error("The selected file is unavailable");
    if (file) await vault.load(file.id);
    const needsSync =
      request.method.startsWith("sharing.") ||
      (request.method.startsWith("history.") &&
        !!(await vault.companions.descriptor(name))?.retention);
    // A real persisted identity and the same retention coordinator are used for shared operations.
    if (needsSync) {
      repository = await openNodeRepository(path.join(profile, "identity"), {
        endpoints: request.endpoints ?? [],
      });
      const workspace = await WorkspaceStore.open(local, "cli", "SADDLE");
      sync = await ProtectedFileSync.open(
        repository,
        local,
        workspace,
        (error) => errors.push(error),
      );
      await sync.attach(vault);
    }
    let result: unknown;
    const versions = () =>
      file
        ? vault.historyEnabled(file.id)
          ? vault.history(file.id)
          : []
        : vault.folderFeatures("").history
          ? vault.folderHistory("")
          : [];
    if (request.method === "unit.inspect")
      result = {
        id: file?.id ?? vault.id,
        kind: folder ? "folder" : "file",
        features: file ? vault.features(file.id) : vault.folderFeatures(""),
        metadata: file ? vault.metadata(file.id) : null,
      };
    else if (request.method === "metadata.get")
      result = file
        ? vault.metadata(file.id)
        : (await vault.companions.read("", "resource.json"))
          ? JSON.parse(
              text.decode((await vault.companions.read("", "resource.json"))!),
            )
          : null;
    else if (request.method === "metadata.set") {
      const resource =
        request.value === null
          ? null
          : parseResource(JSON.stringify(request.value));
      if (file) {
        const draft = vault.draft(file.id);
        draft.resource = resource;
        vault.release(await vault.save(draft));
        vault.release(draft);
      } else await vault.setFolderResource("", resource);
      result = { saved: true };
    } else if (request.method === "history.list")
      result = versions().map(({ bytes, ...row }) => row);
    else if (
      request.method === "history.configure" ||
      request.method === "sharing.configure"
    ) {
      if (!["unset", "disabled", "enabled"].includes(request.state ?? ""))
        throw Error("State must be unset, disabled or enabled");
      await vault.configureScope(folder ? "vault" : "file", file?.id ?? "", {
        [request.method.startsWith("history") ? "history" : "sync"]:
          request.state === "unset" ? undefined : request.state === "enabled",
      });
      result = { configured: true };
    } else if (
      request.method === "history.reset" ||
      request.method === "history.delete"
    ) {
      if (request.method === "history.delete" && !request.hash)
        throw Error("Choose a version hash");
      const operation =
        request.method === "history.reset"
          ? { kind: "reset" as const, time: Math.floor(Date.now() / 1000) }
          : { kind: "drop" as const, hash: request.hash! };
      if (sync)
        await sync.rewriteHistory(
          vault,
          file ? { id: file.id } : { path: "" },
          operation,
        );
      else if (file) await vault.rewriteFileHistory(file.id, operation);
      else await vault.rewriteFolderHistory("", operation);
      result = { rewritten: true };
    } else if (request.method === "sharing.list")
      result = await sync!.listShares();
    else if (request.method === "sharing.invite")
      result = {
        invitation: shareLink(
          await sync!.create(vault, folder ? "vault" : "file", name),
        ),
        contact: repository!.contactCard,
      };
    else if (request.method === "sharing.join") {
      if (!request.invitation) throw Error("An invitation is required");
      result = await sync!.join(request.invitation, vault);
    } else if (request.method === "sharing.grant") {
      if (!request.invitation || !request.contact)
        throw Error("An invitation and approved contact card are required");
      await sync!.grant(
        parseShareLink(request.invitation),
        request.contact,
        request.role ?? "read",
      );
      result = { granted: true };
    } else if (request.method === "sharing.broadcast") {
      if (!request.invitation || typeof request.broadcast !== "boolean")
        throw Error("An invitation and broadcast flag are required");
      await sync!.setBroadcast(
        parseShareLink(request.invitation),
        request.broadcast,
      );
      result = { broadcast: request.broadcast };
    } else throw Error("Unknown unit operation");
    await vault.flush();
    if (sync) await sync.flush();
    if (errors.length) throw errors[0];
    return result === undefined ? null : json(result);
  } finally {
    try {
      if (sync) await sync.close();
      if (repository) await repository.close();
    } finally {
      await unlock();
    }
  }
}
