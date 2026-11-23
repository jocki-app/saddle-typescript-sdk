import type { HistoryRewrite } from "./history-rewrite.js";
import {
  folderEpoch,
  folderGeneration,
  folderName,
  type FolderDocument,
} from "./folder-document.js";
import * as A from "@automerge/automerge";
import {
  isValidAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
} from "@automerge/automerge-repo";
import type { Repository } from "../repository.js";
import { text, utf8, base64, unbase64, canonical, fromHex } from "../crypto.js";
import { Signed } from "@automerge/automerge-repo-keyhive";
import {
  filePath,
  documentId,
  type FileDocument,
  type VaultFileSystem,
} from "./contracts.js";
import { effectiveFeatures } from "./scope-policy.js";
import { hasDistinctConflicts } from "./history.js";
import type { FileVault } from "./vault.js";
import {
  workspaceGeneration,
  type WorkspaceFreeze,
  type FileWorkspace,
  type WorkspaceStore,
} from "./workspace.js";
import { parseShareLink } from "./share-invitation.js";
import { HistoryRetention, type RetentionDocument } from "./retention.js";

export type ShareKind = "file" | "folder" | "vault" | "workspace";
export interface SharedFile {
  id: string;
  path: string;
  url: AutomergeUrl;
  deleted: boolean;
  epoch: number;
  retention: AutomergeUrl;
}
export interface ShareDocument extends Record<string, unknown> {
  format: "saddle-share/1";
  id: string;
  name: string;
  kind: ShareKind;
  unit: { id: string; kind: "file" | "folder" } | null;
  rootFile: string | null;
  contract: string;
  group: string;
  files: Record<string, SharedFile>;
  folders: Record<
    string,
    { id: string; path: string; url: AutomergeUrl; retention: AutomergeUrl }
  >;
  workspace: AutomergeUrl | null;
  workspaceRetention?: AutomergeUrl;
  vaults: Record<string, { name: string; url: AutomergeUrl }>;
}
export interface ShareInvitation {
  format: "saddle-share-invitation/1";
  url: AutomergeUrl;
  name: string;
  kind: ShareKind;
}
export interface LocalScope {
  unit?: { id: string; kind: "file" | "folder" };
  broadcast?: boolean;
  url: AutomergeUrl;
  vault: string | null;
  prefix: string;
  owner: boolean;
  role: "read" | "edit";
  contract: string;
  admitted: Record<string, true>;
  routes: Record<string, { path: string; deleted: boolean }>;
  members?: Record<string, "read" | "edit">;
  workspaceId?: string;
}
export interface ShareSummary {
  rootFile: string | null;
  invitation: ShareInvitation;
  vault: string | null;
  prefix: string;
  owner: boolean;
  role: "read" | "edit";
  members: Array<{
    id: string;
    self: boolean;
    access: "admin" | "read" | "edit";
  }>;
  broadcast: boolean;
  inherited?: boolean;
}
interface SyncCatalog {
  folders: Record<
    string,
    {
      url: AutomergeUrl;
      retired: AutomergeUrl[];
      audiences: string[];
      retention?: AutomergeUrl;
    }
  >;
  files: Record<
    string,
    {
      url: AutomergeUrl;
      epoch: number;
      retention: AutomergeUrl;
      retired: AutomergeUrl[];
    }
  >;
  scopes: LocalScope[];
  workspace: AutomergeUrl | null;
  workspaces?: Record<string, AutomergeUrl>;
  workspaceControls?: Record<string, AutomergeUrl>;
  workspaceFreezes?: Record<string, WorkspaceFreeze>;
}
const sameHeads = (a: A.Doc<unknown>, b: A.Doc<unknown>) =>
  A.getHeads(a).sort().join() === A.getHeads(b).sort().join();
const fileKey = (vault: FileVault, id: string) => `${vault.id}/${id}`;
const under = (path: string, prefix: string) =>
  !prefix || path.startsWith(prefix + "/");
const sameRoute = (
  a: { path: string; deleted: boolean } | undefined,
  b: { path: string; deleted: boolean },
) => a?.path === b.path && a.deleted === b.deleted;

function shareContract(scope: DocHandle<ShareDocument>, value = scope.doc()) {
  return canonical({
    format: "saddle-share-contract/1",
    url: scope.url,
    id: value.id,
    kind: value.kind,
    unit: value.unit,
    rootFile: value.rootFile,
    group: value.group,
    workspace: value.workspace,
  });
}
async function validateShareScope(
  repository: Repository,
  scope: DocHandle<ShareDocument>,
  local?: LocalScope,
  value = scope.doc(),
) {
  if (
    value.format !== "saddle-share/1" ||
    typeof value.contract !== "string" ||
    value.contract.length > 8192 ||
    !["file", "folder", "vault", "workspace"].includes(value.kind) ||
    !/^[a-f0-9]{64}$/.test(value.group) ||
    typeof value.name !== "string" ||
    value.name.length > 4096
  )
    throw Error("Invalid share contract");
  if (
    value.kind === "workspace"
      ? value.unit !== null
      : !value.unit ||
        !["file", "folder"].includes(value.unit.kind) ||
        value.unit.kind !== (value.kind === "file" ? "file" : "folder")
  )
    throw Error("Invalid share contract unit identity");
  if (value.unit) documentId(value.unit.id);
  const signed = Signed.fromBytes(unbase64(value.contract));
  const contract = shareContract(scope, value);
  if (
    !signed.verify() ||
    text.decode(signed.payload()) !== contract ||
    !(await repository.isDocumentAdmin(signed.verifyingKey, scope.url)) ||
    !(await repository.groupCanRead(value.group, scope.url))
  )
    throw Error("Share contract is not signed by its administrator");
  if (local && local.contract !== contract)
    throw Error("Share permissions changed; open a new invitation explicitly");
  return contract;
}
/** Keyhive authenticates each document. Share manifests disclose only their own scope. */
export class ProtectedFileSync {
  private catalog: SyncCatalog = {
    folders: {},
    files: {},
    scopes: [],
    workspace: null,
  };
  private scopes = new Map<AutomergeUrl, DocHandle<ShareDocument>>();
  private documents = new Map<AutomergeUrl, DocHandle<FileDocument>>();
  private folderHandles = new Map<string, DocHandle<FolderDocument>>();
  private fileSubscriptions = new Map<AutomergeUrl, Set<FileVault>>();
  private granted = new Set<string>();
  private pendingGrants = new Set<string>();
  private applying = new Set<string>();
  private deferred = new Set<string>();
  private retention = new Map<
    string,
    HistoryRetention<FileDocument> | HistoryRetention<FolderDocument>
  >();
  private pendingRetention = new Map<
    string,
    Promise<HistoryRetention<FileDocument> | HistoryRetention<FolderDocument>>
  >();
  private vaults = new Map<string, FileVault>();
  private vaultSubscriptions = new Map<string, () => void>();
  private unsubscribers: (() => void)[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private workspaceHandle?: DocHandle<FileWorkspace>;
  private constructor(
    readonly repository: Repository,
    readonly local: VaultFileSystem,
    readonly workspace: WorkspaceStore,
    readonly error: (error: unknown) => void,
  ) {}
  static async open(
    repository: Repository,
    local: VaultFileSystem,
    workspace: WorkspaceStore,
    error: (error: unknown) => void = console.error,
  ) {
    const manager = new ProtectedFileSync(repository, local, workspace, error);
    const saved = await local.read("sync-catalog.json");
    if (saved) manager.catalog = JSON.parse(text.decode(saved));
    manager.catalog.workspaces ??= {};
    if (
      manager.catalog.workspace &&
      !Object.values(manager.catalog.workspaces).includes(
        manager.catalog.workspace,
      ) &&
      (await repository.documentAccess(manager.catalog.workspace))
    ) {
      const settings = await repository.load<FileWorkspace>(
        manager.catalog.workspace,
      );
      manager.catalog.workspaces[settings.doc().id] = settings.url;
    }
    for (const scope of manager.catalog.scopes.filter(
      (s) => s.vault === null && !s.workspaceId,
    )) {
      if (!(await repository.documentAccess(scope.url))) continue;
      const handle = await repository.load<ShareDocument>(scope.url);
      scope.workspaceId = Object.entries(manager.catalog.workspaces).find(
        ([, url]) => url === handle.doc().workspace,
      )?.[0];
    }
    manager.catalog.scopes = manager.catalog.scopes.filter(
      (s) => s.vault !== null || !!s.workspaceId,
    );
    manager.catalog.workspace =
      manager.catalog.workspaces[workspace.current.id] ?? null;
    if (
      manager.catalog.workspace &&
      !(await repository.documentAccess(manager.catalog.workspace))
    ) {
      delete manager.catalog.workspaces[workspace.current.id];
      manager.catalog.workspace = null;
    }
    await manager.persist();
    manager.unsubscribers.push(
      workspace.subscribe(() => {
        if (manager.catalog.workspaces?.[workspace.current.id])
          void manager.enqueue(() => manager.flushWorkspace());
      }),
    );
    if (manager.catalog.workspace)
      await manager.watchWorkspace(manager.catalog.workspace);
    for (const scope of manager.catalog.scopes.filter(
      (scope) =>
        scope.vault === null && scope.workspaceId === workspace.current.id,
    )) {
      if (!scope.owner && !(await repository.documentAccess(scope.url)))
        await manager.disconnectLocal(scope);
      else await manager.watchScope(scope);
    }
    return manager;
  }
  private catalogWrites: Promise<void> = Promise.resolve();
  private companionRevisions = new Map<string, string>();
  private async persist() {
    // Portable scope manifests live beside the scope, independently of device credentials.
    for (const local of this.catalog.scopes) {
      const vault = local.vault && this.vaults.get(local.vault),
        scope = this.scopes.get(local.url);
      if (!vault || !scope) continue;
      const value = scope.doc();
      if (value.kind === "folder" || value.kind === "vault")
        local.prefix = vault.scopePath(value.id, local.prefix);
      const path =
        value.kind === "file" && value.rootFile
          ? vault.archivePath(value.rootFile)
          : local.prefix;
      vault.rememberScope(value.id, path);
      const prior = await vault.companions.descriptor(path);
      const unit = value.unit!;
      if (
        (prior && (prior.kind !== unit.kind || prior.id !== unit.id)) ||
        (local.unit && canonical(local.unit) !== canonical(unit))
      )
        throw Error("Share companion identity changed");
      local.unit = unit;
      await vault.companions.updateDescriptor(path, (latest) => ({
        ...latest,
        format: "saddle-companion/1",
        ...unit,
        features: { ...(latest?.features ?? {}) },
        shares: { ...latest?.shares, [value.id]: local.url },
      }));
      const key = vault.id + "/" + value.id,
        revision = path + ":" + A.getHeads(value).sort().join();
      if (this.companionRevisions.get(key) !== revision) {
        await vault.companions.saveDocument(
          path,
          `shares/${value.id}.automerge`,
          value,
        );
        this.companionRevisions.set(key, revision);
      }
    }
    const saved = this.catalogWrites.then(() =>
      this.local.writeAtomic(
        "sync-catalog.json",
        utf8.encode(JSON.stringify(this.catalog)),
      ),
    );
    this.catalogWrites = saved.catch(() => {});
    await saved;
  }
  private contract(scope: DocHandle<ShareDocument>, value = scope.doc()) {
    return shareContract(scope, value);
  }
  private async signScope(scope: DocHandle<ShareDocument>) {
    const signature = base64(
      (
        await this.repository.hive.keyhive.trySign(
          utf8.encode(this.contract(scope)),
        )
      ).toBytes(),
    );
    scope.change((d) => {
      d.contract = signature;
    });
    await this.repository.flush();
  }
  private validateScope(
    scope: DocHandle<ShareDocument>,
    local?: LocalScope,
    value = scope.doc(),
  ) {
    return validateShareScope(this.repository, scope, local, value);
  }
  private enqueue(work: () => Promise<void>) {
    const next = this.queue.then(work);
    this.queue = next.catch(this.error);
    return next;
  }
  private finishedApplying(id: string) {
    this.applying.delete(id);
    if (this.deferred.delete(id)) {
      const vault = this.vaults.get(id);
      if (vault?.syncActive) void this.enqueue(() => this.publish(vault));
    }
  }
  get invitations(): ShareInvitation[] {
    return this.catalog.scopes
      .filter((local) => this.mounted(local))
      .flatMap((local) => {
        const h = this.scopes.get(local.url);
        return h
          ? [
              {
                format: "saddle-share-invitation/1",
                url: h.url,
                name: h.doc().name,
                kind: h.doc().kind,
              },
            ]
          : [];
      });
  }
  private mounted(local: LocalScope) {
    return local.vault
      ? this.vaults.has(local.vault)
      : local.workspaceId === this.workspace.current.id;
  }
  private inheritedScope(local: LocalScope) {
    return (
      this.workspace.features.sync &&
      this.catalog.scopes.some(
        (parent) =>
          parent.vault === null &&
          parent.workspaceId === this.workspace.current.id &&
          parent.broadcast !== false &&
          Object.values(this.scopes.get(parent.url)?.doc().vaults ?? {}).some(
            (child) => child.url === local.url,
          ),
      )
    );
  }
  private definitionEnabled(local: LocalScope, value?: ShareDocument) {
    if (!value) return false;
    if (value.kind === "workspace")
      return this.workspace.current.features.sync === true;
    const vault = local.vault && this.vaults.get(local.vault);
    if (!vault) return false;
    const own =
      value.kind === "file"
        ? vault.scopePolicies.files[value.rootFile!]?.sync
        : local.prefix
          ? vault.scopePolicies.folders[local.prefix]?.sync
          : vault.scopePolicies.vault.sync;
    return own === true || this.inheritedScope(local);
  }
  async listShares(): Promise<ShareSummary[]> {
    const result: ShareSummary[] = [];
    for (const local of this.catalog.scopes) {
      if (!this.mounted(local)) continue;
      const handle = this.scopes.get(local.url);
      if (!handle) continue;
      const doc = handle.doc();
      result.push({
        rootFile: doc.rootFile,
        broadcast: local.broadcast !== false,
        inherited: this.inheritedScope(local),
        invitation: {
          format: "saddle-share-invitation/1",
          url: local.url,
          name: doc.name,
          kind: doc.kind,
        },
        vault: local.vault,
        prefix: local.prefix,
        owner: local.owner,
        role: local.role,
        members: await this.repository.shareMembers(local.url),
      });
    }
    return result;
  }
  /** A device-local pause preserves grants, routes and retained history. */
  setBroadcast(invitation: ShareInvitation, enabled: boolean) {
    return this.enqueue(async () => {
      const local = this.catalog.scopes.find(
        (scope) => scope.url === invitation.url,
      );
      if (!local) throw Error("Unknown share");
      const previous = local.broadcast;
      local.broadcast = enabled;
      try {
        await this.persist();
      } catch (error) {
        local.broadcast = previous;
        throw error;
      }
      if (enabled) {
        await this.watchScope(local);
        const vault = local.vault ? this.vaults.get(local.vault) : undefined;
        if (vault) await this.publish(vault);
        else await this.flushWorkspace();
      }
    });
  }
  private broadcastsWorkspace() {
    return (
      this.workspace.current.features.sync &&
      this.catalog.scopes.some(
        (scope) =>
          scope.vault === null &&
          scope.workspaceId === this.workspace.current.id &&
          scope.broadcast !== false,
      )
    );
  }
  /** Disconnect routes and retire old transports. Materialized files and their histories stay local. */
  disconnect(invitation: ShareInvitation) {
    return this.enqueue(async () => {
      const local = this.catalog.scopes.find((s) => s.url === invitation.url);
      if (!local) throw Error("Unknown share");
      const scope =
        this.scopes.get(local.url) ??
        (local.owner
          ? await this.repository.load<ShareDocument>(local.url)
          : undefined);
      if (scope) this.scopes.set(local.url, scope);
      if (local.owner && scope) {
        for (const member of await this.repository.shareMembers(scope.url))
          if (!member.self && member.access !== "admin")
            await this.repository.revokeGroup(scope.doc().group, member.id);
      }
      await this.disconnectLocal(local);
      for (const vault of this.vaults.values()) await this.publish(vault);
    });
  }
  private async disconnectLocal(local: LocalScope) {
    const scope = this.scopes.get(local.url),
      doc = scope?.doc();
    const removed = new Set([
      local.url,
      ...(doc?.kind === "workspace"
        ? Object.values(doc.vaults).map((v) => v.url)
        : []),
    ]);
    const affected = this.catalog.scopes.filter((s) => removed.has(s.url));
    this.catalog.scopes = this.catalog.scopes.filter(
      (s) => !removed.has(s.url),
    );
    for (const url of removed) this.scopes.delete(url);
    if (doc?.kind === "workspace" || local.vault === null) {
      const settingsURL =
        doc?.workspace ??
        (local.workspaceId
          ? this.catalog.workspaces?.[local.workspaceId]
          : undefined);
      if (this.catalog.workspaces)
        for (const [id, url] of Object.entries(this.catalog.workspaces))
          if (url === settingsURL) delete this.catalog.workspaces[id];
      if (this.catalog.workspace === settingsURL) {
        this.catalog.workspace = null;
        this.workspaceHandle = undefined;
      }
    }
    for (const item of affected) {
      const vault = item.vault ? this.vaults.get(item.vault) : undefined;
      if (!vault) continue;
      const value = item.url === local.url ? doc : undefined;
      for (const folder of Object.values(value?.folders ?? {})) {
        const saved = this.catalog.folders[folder.id];
        if (!saved || saved.url !== folder.url) continue;
        const covered = this.catalog.scopes.some(
          (other) =>
            other.vault === vault.id &&
            this.scopes.get(other.url)?.doc().folders[folder.id]?.url ===
              saved.url,
        );
        if (covered) continue;
        const freeze = vault.getFreeze(folder.id);
        if (freeze) await vault.unfreezeHistory(folder.id, freeze.token);
        if (saved.retention) {
          this.retention.get(`${vault.id}/${saved.retention}`)?.close();
          this.retention.delete(`${vault.id}/${saved.retention}`);
        }
        await vault.releaseHistoryProtection(folder.id);
        const archive =
          this.folderHandles.get(folder.id) ??
          (await this.repository.load<FolderDocument>(saved.url));
        const current = vault.folderDocument(
          vault.unitPath(folder.id) ??
            [local.prefix, folder.path].filter(Boolean).join("/"),
        );
        const doc =
          current ??
          (vault.folderFeatures(
            [local.prefix, folder.path].filter(Boolean).join("/"),
          ).history
            ? archive.doc()
            : A.from<FolderDocument>({
                ...A.toJS(archive.doc()),
                retainHistory: false,
                checkpoint: {
                  epoch: folderEpoch(archive.doc()) + 1,
                  generation: crypto.randomUUID(),
                },
              }));
        const handle = await this.repository.importProtected<FolderDocument>(
          A.save(doc),
        );
        this.catalog.folders[folder.id] = {
          url: handle.url,
          retired: [...saved.retired, saved.url],
          audiences: [],
        };
        this.folderHandles.set(folder.id, handle);
      }
      for (const id of Object.keys(item.admitted)) {
        const key = fileKey(vault, id),
          saved = this.catalog.files[key];
        if (!saved) continue;
        // Keep a live overlapping route on its established protected document.
        // Reissuing it on both peers can race the remaining manifest's grants.
        const covered = this.catalog.scopes.some(
          (other) =>
            other.vault === vault.id &&
            other.admitted[id] &&
            this.scopes.get(other.url)?.doc().files[id]?.url === saved.url &&
            !this.scopes.get(other.url)?.doc().files[id]?.deleted,
        );
        if (covered) continue;
        await vault.load(id);
        this.retention.get(`${vault.id}/${saved.retention}`)?.close();
        this.retention.delete(`${vault.id}/${saved.retention}`);
        const priorFreeze = vault.getFreeze(id);
        if (priorFreeze) await vault.unfreezeHistory(id, priorFreeze.token);
        await vault.releaseHistoryProtection(id);
        const handle = await this.repository.importProtected<FileDocument>(
          vault.exportDocument(id),
        );
        const control = await this.repository.create<RetentionDocument>({
          format: "saddle-retention/1",
          file: id,
          owner: this.repository.identityId,
          proposal: null,
        });
        this.catalog.files[key] = {
          url: handle.url,
          epoch: handle.doc().epoch,
          retention: control.url,
          retired: [...saved.retired, saved.url],
        };
        this.retention.get(`${vault.id}/${saved.retention}`)?.close();
        this.retention.delete(`${vault.id}/${saved.retention}`);
        const frozen = vault.getFreeze(id);
        if (frozen) await vault.unfreezeHistory(id, frozen.token);
        this.watchFile(handle, vault);
      }
    }
    await this.persist();
    await this.repository.flush();
  }
  async attach(vault: FileVault) {
    if (this.vaults.has(vault.id)) return;
    // A companion is a location hint, never an invitation or an authority grant.
    // Only rebind scopes already pinned to this unit in the device's catalog.
    const locals = new Map(
      this.catalog.scopes.map((local) => [local.url as string, local]),
    );
    const files = new Map(vault.list().map((file) => [file.id, file]));
    for (const reference of await vault.scopeCompanions()) {
      const local = locals.get(reference.url);
      if (!local?.unit) continue;
      if (!(await this.repository.documentAccess(local.url))) continue;
      if (canonical(local.unit) !== canonical(reference.unit))
        throw Error("Share companion identity changed");
      if (
        local.vault !== vault.id &&
        local.vault &&
        this.vaults.has(local.vault)
      )
        throw Error("This shared unit is already open in another folder");
      const scope =
        this.scopes.get(local.url) ??
        (await this.repository.load<ShareDocument>(local.url));
      await this.validateScope(scope, local);
      if (
        scope.doc().id !== reference.id ||
        canonical(scope.doc().unit) !== canonical(reference.unit) ||
        (scope.doc().kind === "file") !== (reference.unit.kind === "file")
      )
        throw Error("Share companion does not match its signed scope");
      const oldVault = local.vault;
      const oldPrefix = local.prefix;
      local.vault = vault.id;
      local.prefix =
        scope.doc().kind === "file" && !local.owner
          ? reference.path.split("/").slice(0, -1).join("/")
          : reference.path;
      for (const file of Object.values(scope.doc().files)) {
        const entry = files.get(file.id);
        if (!entry) continue;
        const prior = local.routes[file.id];
        const relative =
          scope.doc().kind === "file" && local.owner
            ? file.path
            : prior && under(prior.path, oldPrefix)
              ? prior.path.slice(oldPrefix ? oldPrefix.length + 1 : 0)
              : file.path;
        const directory =
          scope.doc().kind === "file" && local.owner
            ? local.prefix.split("/").slice(0, -1).join("/")
            : local.prefix;
        local.routes[file.id] = {
          path: directory ? directory + "/" + relative : relative,
          deleted: prior?.deleted ?? file.deleted,
        };
        const saved = oldVault && this.catalog.files[`${oldVault}/${file.id}`];
        if (saved && !this.catalog.files[fileKey(vault, file.id)])
          this.catalog.files[fileKey(vault, file.id)] = {
            ...saved,
            retired: [...saved.retired],
          };
      }
    }
    this.vaults.set(vault.id, vault);
    this.vaultSubscriptions.set(
      vault.id,
      vault.subscribe(() => {
        if (vault.syncActive || vault.hasProtectedHistory) {
          if (this.applying.has(vault.id)) this.deferred.add(vault.id);
          else void this.enqueue(() => this.publish(vault));
        }
      }),
    );
    for (const scope of this.catalog.scopes.filter(
      (s) => s.vault === vault.id,
    )) {
      if (!scope.owner && !(await this.repository.documentAccess(scope.url)))
        await this.disconnectLocal(scope);
      else await this.watchScope(scope);
    }
    await this.cleanUnsharedTransports(vault);
    if (
      (vault.syncActive || vault.hasProtectedHistory) &&
      !this.applying.has(vault.id)
    )
      await this.enqueue(() => this.publish(vault));
    await this.persist();
  }
  detach(id: string) {
    this.vaultSubscriptions.get(id)?.();
    this.vaultSubscriptions.delete(id);
    this.vaults.delete(id);
    for (const [key, control] of this.retention)
      if (key.startsWith(id + "/")) {
        control.close();
        this.retention.delete(key);
      }
  }
  private async document(vault: FileVault, id: string) {
    await vault.load(id);
    let saved = this.catalog.files[fileKey(vault, id)];
    let handle = saved
      ? (this.documents.get(saved.url) ??
        (await this.repository.load<FileDocument>(saved.url)))
      : undefined;
    if (handle && saved && vault.doc(id).generation !== handle.doc().generation)
      await vault.resumeFileSharing(id, handle.doc());
    const doc = vault.doc(id);
    if (handle && handle.doc().generation !== doc.generation)
      handle = undefined;
    if (!handle) {
      handle = await this.repository.importProtected<FileDocument>(
        vault.exportDocument(id),
      );
      const control = saved
        ? await this.repository.load<RetentionDocument>(saved.retention)
        : await this.repository.create<RetentionDocument>({
            format: "saddle-retention/1",
            file: id,
            owner: this.repository.identityId,
            proposal: null,
          });
      saved = this.catalog.files[fileKey(vault, id)] = {
        url: handle.url,
        epoch: doc.epoch,
        retention: control.url,
        retired: saved ? [...saved.retired, saved.url] : [],
      };
      if (vault.historyProtection(id))
        await vault.protectHistory(vault.archivePath(id), "file", id, {
          document: handle.url,
          control: control.url,
        });
      await this.persist();
    }
    this.watchFile(handle, vault);
    if (!sameHeads(handle.doc(), doc)) {
      if ((await this.repository.documentAccess(handle.url)) !== "edit")
        throw Error(
          "This shared file is read-only; save an independent copy to publish local edits",
        );
      handle.update((prior) => A.merge(A.clone(prior), A.clone(doc)));
      await this.repository.flush();
      await vault.receiveDocument(id, A.save(handle.doc()));
    }
    return handle;
  }
  private sharedRetention(
    key: string,
    open: () => Promise<
      HistoryRetention<FileDocument> | HistoryRetention<FolderDocument>
    >,
  ) {
    const active = this.retention.get(key);
    if (active) return Promise.resolve(active);
    const pending = this.pendingRetention.get(key);
    if (pending) return pending;
    const created = open();
    this.pendingRetention.set(key, created);
    void created
      .finally(() => {
        if (this.pendingRetention.get(key) === created)
          this.pendingRetention.delete(key);
      })
      .catch(() => {});
    return created;
  }
  /** Queue an authenticated, durable history edit; the shared barrier applies it atomically. */
  async rewriteHistory(
    vault: FileVault,
    target: { id?: string; path?: string },
    operation: HistoryRewrite,
  ) {
    await this.flush();
    const doc = target.id ? undefined : vault.folderDocument(target.path ?? "");
    const id = target.id ?? doc?.id;
    if (!id) throw Error("No retained history for this item");
    const reference = vault.historyProtection(id);
    if (!reference)
      return target.id
        ? vault.rewriteFileHistory(id, operation)
        : vault.rewriteFolderHistory(target.path ?? "", operation);
    const control = target.id
      ? await this.watchRetention(
          vault,
          await this.repository.load<FileDocument>(
            reference.reference.document as AutomergeUrl,
          ),
          reference.reference.control as AutomergeUrl,
        )
      : await this.watchFolderRetention(
          vault,
          await this.repository.load<FolderDocument>(
            reference.reference.document as AutomergeUrl,
          ),
          reference.reference.control as AutomergeUrl,
          target.path ?? "",
        );
    await control.rewrite(operation);
  }
  private watchRetention(
    vault: FileVault,
    file: DocHandle<FileDocument>,
    url: AutomergeUrl,
  ) {
    return this.sharedRetention(`${vault.id}/${url}`, () =>
      this.openFileRetention(vault, file, url),
    );
  }
  private async openFileRetention(
    vault: FileVault,
    file: DocHandle<FileDocument>,
    url: AutomergeUrl,
  ) {
    const key = `${vault.id}/${url}`;
    if (this.retention.has(key)) return this.retention.get(key)!;
    const control = await this.repository.load<RetentionDocument>(url);
    if (
      !/^[a-f0-9]{64}$/.test(control.doc().owner) ||
      !(await this.repository.isDocumentAdmin(
        fromHex(control.doc().owner),
        file.url,
      )) ||
      !(await this.repository.isDocumentAdmin(
        fromHex(control.doc().owner),
        control.url,
      ))
    )
      throw Error("History control must belong to the file's administrator");
    const target = vault.fileRetentionTarget();
    const pruned = target.historyPruned;
    target.historyPruned = async (id) => {
      const proposal = control.doc().proposal;
      if (!proposal?.next) throw Error("Missing committed file checkpoint");
      const next = await this.repository.load<FileDocument>(proposal.next);
      const saved = this.catalog.files[fileKey(vault, id)];
      if (saved)
        this.catalog.files[fileKey(vault, id)] = {
          ...saved,
          url: next.url,
          epoch: next.doc().epoch,
          retired: [...new Set([...saved.retired, proposal.previous])],
        };
      this.watchFile(next, vault);
      await this.persist();
      if (vault.historyProtection(id))
        await vault.protectHistory(vault.archivePath(id), "file", id, {
          document: next.url,
          control: control.url,
        });
      await pruned?.(id);
    };
    const retention = await HistoryRetention.open(
      this.repository,
      target,
      file,
      control,
      (old, token, rewrite) => this.enqueueRotation(vault, old, token, rewrite),
      this.error,
      async () => {
        this.finishedApplying(vault.id);
        await this.enqueue(() => this.publish(vault));
      },
    );
    this.retention.set(key, retention);
    const changed = () => {
      if (this.needsRestriction(vault, file.doc().id))
        void this.enqueue(() => this.publish(vault));
    };
    control.on("change", changed);
    this.unsubscribers.push(() => control.off("change", changed));
    return retention;
  }
  private async protectScope(value: ShareDocument, local: LocalScope) {
    if (value.kind === "workspace") {
      for (const child of Object.values(value.vaults)) {
        const scope =
          this.scopes.get(child.url) ??
          (await this.repository.load<ShareDocument>(child.url));
        const selected = this.catalog.scopes.find(
          (item) => item.url === child.url,
        );
        if (selected) await this.protectScope(scope.doc(), selected);
      }
      return;
    }
    const vault = local.vault && this.vaults.get(local.vault);
    if (!vault) throw Error("Open this share's folder first");
    for (const file of Object.values(value.files))
      if (vault.hasEntry(file.id))
        await vault.protectHistory(
          vault.archivePath(file.id),
          "file",
          file.id,
          { document: file.url, control: file.retention },
        );
    for (const folder of Object.values(value.folders)) {
      const path = [local.prefix, folder.path].filter(Boolean).join("/");
      await vault.protectHistory(path, "folder", folder.id, {
        document: folder.url,
        control: folder.retention,
      });
    }
  }
  private async cleanUnsharedTransports(vault: FileVault) {
    for (const unit of vault.historyProtections()) {
      if (this.pendingGrants.size) continue;
      if (!isValidAutomergeUrl(unit.reference.document))
        throw Error("Invalid retained document URL");
      if (!(await this.repository.documentAccess(unit.reference.document)))
        continue;
      const members = await this.repository.shareMembers(
        unit.reference.document,
      );
      if (!members.every((member) => member.self)) continue;
      const before =
        unit.kind === "folder" ? vault.folderDocument(unit.path) : undefined;
      const key = `${vault.id}/${unit.reference.control}`;
      this.retention.get(key)?.close();
      this.retention.delete(key);
      const freeze = vault.getFreeze(unit.id);
      if (freeze) await vault.unfreezeHistory(unit.id, freeze.token);
      await vault.releaseHistoryProtection(unit.id);
      const control = await this.repository.create<RetentionDocument>({
        format: "saddle-retention/1",
        file: unit.id,
        owner: this.repository.identityId,
        proposal: null,
      });
      if (unit.kind === "file" && vault.hasEntry(unit.id)) {
        await vault.load(unit.id);
        const handle = await this.repository.importProtected<FileDocument>(
          vault.exportDocument(unit.id),
        );
        const saved = this.catalog.files[fileKey(vault, unit.id)];
        this.catalog.files[fileKey(vault, unit.id)] = {
          url: handle.url,
          epoch: handle.doc().epoch,
          retention: control.url,
          retired: [
            ...new Set([
              ...(saved?.retired ?? []),
              unit.reference.document as AutomergeUrl,
            ]),
          ],
        };
        this.watchFile(handle, vault);
      } else if (unit.kind === "folder") {
        let doc = vault.folderDocument(unit.path) ?? before;
        if (!doc) throw Error("Missing retained folder state");
        if (
          !vault.folderFeatures(unit.path).history &&
          A.stats(doc).numChanges > 1 &&
          !hasDistinctConflicts(doc)
        )
          doc = A.from<FolderDocument>({
            ...A.toJS(doc),
            checkpoint: {
              epoch: folderEpoch(doc) + 1,
              generation: crypto.randomUUID(),
            },
          });
        const handle = await this.repository.importProtected<FolderDocument>(
          A.save(doc),
        );
        const saved = this.catalog.folders[unit.id];
        this.catalog.folders[unit.id] = {
          url: handle.url,
          retention: control.url,
          retired: [
            ...new Set([
              ...(saved?.retired ?? []),
              unit.reference.document as AutomergeUrl,
            ]),
          ],
          audiences: [],
        };
        this.watchFolder(handle, vault, unit.path);
      }
      await this.persist();
      await this.repository.flush();
      await this.repository.removeDocument(
        unit.reference.document as AutomergeUrl,
      );
      await this.repository.removeDocument(
        unit.reference.control as AutomergeUrl,
      );
    }
  }
  private watchFolderRetention(
    vault: FileVault,
    folder: DocHandle<FolderDocument>,
    url: AutomergeUrl,
    path: string,
  ) {
    return this.sharedRetention(`${vault.id}/${url}`, () =>
      this.openFolderRetention(vault, folder, url, path),
    );
  }
  private async openFolderRetention(
    vault: FileVault,
    folder: DocHandle<FolderDocument>,
    url: AutomergeUrl,
    path: string,
  ) {
    const key = `${vault.id}/${url}`;
    const existing = this.retention.get(key);
    if (existing) return existing;
    const control = await this.repository.load<RetentionDocument>(url);
    if (
      !(await this.repository.isDocumentAdmin(
        fromHex(control.doc().owner),
        folder.url,
      )) ||
      !(await this.repository.isDocumentAdmin(
        fromHex(control.doc().owner),
        control.url,
      ))
    )
      throw Error("History control must belong to the folder's administrator");
    const target = vault.folderRetentionTarget(path);
    const pruned = target.historyPruned;
    target.historyPruned = async (id) => {
      const proposal = control.doc().proposal;
      if (!proposal?.next) throw Error("Missing committed folder checkpoint");
      const next = await this.repository.load<FolderDocument>(proposal.next);
      const saved = this.catalog.folders[id];
      if (saved)
        this.catalog.folders[id] = {
          ...saved,
          url: next.url,
          retired: [...new Set([...saved.retired, proposal.previous])],
        };
      this.watchFolder(next, vault, vault.unitPath(id) ?? path);
      await this.persist();
      if (vault.historyProtection(id))
        await vault.protectHistory(vault.unitPath(id) ?? path, "folder", id, {
          document: next.url,
          control: control.url,
        });
      await pruned?.(id);
    };
    const retention = await HistoryRetention.open(
      this.repository,
      target,
      folder,
      control,
      (old, token, rewrite) => {
        let next: DocHandle<FolderDocument>;
        return this.enqueue(async () => {
          if (this.catalog.folders[old.doc().id]?.url !== old.url)
            throw Error("This folder transport was retired");
          const doc = await vault.checkpointFolderHistory(
            vault.unitPath(old.doc().id) ?? path,
            A.getHeads(old.doc()),
            token,
            rewrite,
          );
          next = await this.repository.importProtected<FolderDocument>(
            A.save(doc),
          );
          const prior = this.catalog.folders[doc.id];
          this.catalog.folders[doc.id] = {
            ...prior,
            url: next.url,
            retention: control.url,
            retired: [...prior.retired, old.url],
          };
          for (const local of this.catalog.scopes.filter(
            (local) => local.vault === vault.id,
          )) {
            const scope = this.scopes.get(local.url);
            if (scope?.doc().folders[doc.id])
              await this.repository.grantDocumentGroup(
                next,
                scope.doc().group,
                "edit",
              );
          }
          if (vault.historyProtection(doc.id))
            await vault.protectHistory(path, "folder", doc.id, {
              document: next.url,
              control: control.url,
            });
          this.watchFolder(next, vault, path);
          await this.persist();
        }).then(() => next!);
      },
      this.error,
      () => this.enqueue(() => this.publish(vault)),
    );
    this.retention.set(key, retention);
    return retention;
  }
  /** Retention control continues while ordinary content exchange is disabled. */
  private async pruneDisabledUnits(
    vault: FileVault,
    folders: Array<{ path: string; doc: A.Doc<FolderDocument> }>,
  ) {
    const snapshots = new Map(folders.map((folder) => [folder.doc.id, folder]));
    for (const unit of vault.historyProtections()) {
      if (unit.kind === "file") {
        if (!vault.hasEntry(unit.id) || vault.historyEnabled(unit.id)) continue;
        await vault.load(unit.id);
        const saved = this.catalog.files[fileKey(vault, unit.id)];
        if (!saved) continue;
        const handle =
          this.documents.get(saved.url) ??
          (await this.repository.load<FileDocument>(saved.url));
        const current = vault.doc(unit.id);
        if (!vault.syncEnabled(unit.id)) {
          const content = (doc: FileDocument) => {
            const { retainHistory: _, ...rest } = A.toJS(doc);
            return canonical(rest);
          };
          if (content(current) !== content(handle.doc())) continue; // Never publish private edits to finish cleanup.
          if (!sameHeads(current, handle.doc())) {
            handle.update((doc) => A.merge(A.clone(doc), A.clone(current)));
            await this.repository.flush();
          }
        }
        const retention = await this.watchRetention(
          vault,
          handle,
          saved.retention,
        );
        if (
          A.stats(current).numChanges >= 32 ||
          ((current.retainHistory === false || !vault.syncEnabled(unit.id)) &&
            A.stats(current).numChanges > 1)
        )
          void retention.begin().catch(this.error);
      } else {
        if (vault.folderFeatures(unit.path).history) continue;
        const saved = this.catalog.folders[unit.id];
        if (!saved?.retention) continue;
        const snapshot = snapshots.get(unit.id);
        if (!snapshot) continue;
        const handle =
          this.folderHandles.get(unit.id) ??
          (await this.repository.load<FolderDocument>(saved.url));
        if (!vault.folderFeatures(unit.path).sync) {
          const content = (doc: FolderDocument) => {
            const { features: _, retainHistory: __, ...rest } = A.toJS(doc);
            return canonical(rest);
          };
          if (content(snapshot.doc) !== content(handle.doc())) continue;
          if (!sameHeads(snapshot.doc, handle.doc())) {
            handle.update((doc) =>
              A.merge(A.clone(doc), A.clone(snapshot.doc)),
            );
            await this.repository.flush();
          }
        }
        const retention = await this.watchFolderRetention(
          vault,
          handle,
          saved.retention,
          unit.path,
        );
        if (
          A.stats(snapshot.doc).numChanges >= 32 ||
          ((snapshot.doc.retainHistory === false ||
            !vault.folderFeatures(unit.path).sync) &&
            A.stats(snapshot.doc).numChanges > 1)
        )
          void retention.begin().catch(this.error);
      }
    }
  }
  private enqueueRotation(
    vault: FileVault,
    old: DocHandle<FileDocument>,
    token: string,
    rewrite?: HistoryRewrite,
  ): Promise<DocHandle<FileDocument>> {
    let handle: DocHandle<FileDocument>;
    return this.enqueue(async () => {
      this.applying.add(vault.id);
      try {
        if (this.catalog.files[fileKey(vault, old.doc().id)]?.url !== old.url)
          throw Error("This synchronization document was retired");
        await vault.checkpointHistory(
          old.doc().id,
          A.getHeads(old.doc()),
          token,
          rewrite,
        );
        handle = await this.document(vault, old.doc().id);
        for (const local of this.catalog.scopes.filter(
          (local) => local.vault === vault.id && local.role === "edit",
        )) {
          const scope = this.scopes.get(local.url);
          if (scope?.doc().files[old.doc().id])
            await this.repository.grantDocumentGroup(
              handle,
              scope.doc().group,
              "edit",
            );
        }
      } catch (error) {
        this.finishedApplying(vault.id);
        throw error;
      }
    }).then(() => handle!);
  }
  private watchFile(handle: DocHandle<FileDocument>, vault: FileVault) {
    const id = handle.doc().id;
    this.documents.set(handle.url, handle);
    const subscriptions =
      this.fileSubscriptions.get(handle.url) ?? new Set<FileVault>();
    if (subscriptions.has(vault)) return;
    subscriptions.add(vault);
    this.fileSubscriptions.set(handle.url, subscriptions);
    const changed = () => {
      void this.enqueue(async () => {
        if (
          !vault.syncActive ||
          this.vaults.get(vault.id) !== vault ||
          !vault.syncEnabled(id) ||
          !this.catalog.scopes.some(
            (scope) =>
              scope.vault === vault.id &&
              scope.broadcast !== false &&
              this.definitionEnabled(
                scope,
                this.scopes.get(scope.url)?.doc(),
              ) &&
              this.scopes.get(scope.url)?.doc().files[id]?.url === handle.url,
          )
        )
          return;
        if (this.catalog.files[fileKey(vault, id)]?.url !== handle.url) return;
        await this.repository.flush();
        await vault.reconcile();
        await vault.load(id);
        if (!sameHeads(vault.doc(id), handle.doc()))
          await vault.receiveDocument(id, A.save(handle.doc()));
      });
    };
    handle.on("change", changed);
    this.unsubscribers.push(() => handle.off("change", changed));
  }
  private scopeSubscriptions = new Set<AutomergeUrl>();
  private folderBindings = new Map<string, { path: string }>();
  private watchFolder(
    handle: DocHandle<FolderDocument>,
    vault: FileVault,
    path: string,
  ) {
    this.folderHandles.set(handle.doc().id, handle);
    const key = vault.id + "/" + handle.url;
    const existing = this.folderBindings.get(key);
    if (existing) {
      existing.path = path;
      return;
    }
    const binding = { path };
    this.folderBindings.set(key, binding);
    const changed = () => {
      if (this.vaults.get(vault.id) !== vault || !vault.syncActive) return;
      this.enqueue(async () => {
        if (
          this.vaults.get(vault.id) !== vault ||
          this.catalog.folders[handle.doc().id]?.retired.includes(handle.url) ||
          !(await this.repository.documentAccess(handle.url))
        )
          return;
        if (
          !this.catalog.scopes.some(
            (scope) =>
              scope.vault === vault.id &&
              scope.broadcast !== false &&
              this.definitionEnabled(
                scope,
                this.scopes.get(scope.url)?.doc(),
              ) &&
              under(binding.path + "/__folder__", scope.prefix),
          )
        )
          return;
        const path = vault.unitPath(handle.doc().id) ?? binding.path;
        if (!vault.folderFeatures(path).sync) return;
        await vault.receiveFolder(path, handle.doc());
      }).catch(this.error);
    };
    handle.on("change", changed);
    this.unsubscribers.push(() => handle.off("change", changed));
  }
  private async allocateScope(
    vault: FileVault,
    kind: Exclude<ShareKind, "workspace">,
    prefix = "",
    parents: string[] = [],
  ) {
    if (prefix) filePath(prefix);
    if (kind === "file" && !vault.find(prefix))
      throw Error("Select a file to share");
    const unit = await vault.ensureUnit(
      prefix,
      kind === "file" ? "file" : "folder",
    );
    const group = await this.repository.createGroup(parents);
    const scope = await this.repository.createGrouped<ShareDocument>(
      {
        format: "saddle-share/1",
        id: crypto.randomUUID(),
        name: kind === "vault" ? vault.name : prefix,
        kind,
        unit,
        rootFile: kind === "file" ? vault.find(prefix)!.id : null,
        contract: "",
        group,
        files: {},
        folders: {},
        workspace: null,
        vaults: {},
      },
      group,
    );
    await this.signScope(scope);
    const local: LocalScope = {
      unit,
      url: scope.url,
      vault: vault.id,
      prefix,
      owner: true,
      role: "edit",
      contract: this.contract(scope),
      admitted: {},
      routes: {},
    };
    this.catalog.scopes.push(local);
    await this.persist();
    return { scope, local };
  }
  async create(
    vault: FileVault,
    kind: Exclude<ShareKind, "workspace">,
    prefix = "",
    parents: string[] = [],
  ) {
    const { scope, local } = await this.allocateScope(
      vault,
      kind,
      prefix,
      parents,
    );
    this.scopes.set(scope.url, scope);
    await vault.configureScope(
      kind,
      kind === "file" ? vault.find(prefix)!.id : prefix,
      { sync: true },
    );
    await this.enqueue(() => this.publish(vault));
    // Install the incoming manifest listener after the initial publication.
    this.scopes.delete(scope.url);
    await this.watchScope(local);
    return {
      format: "saddle-share-invitation/1",
      url: scope.url,
      name: scope.doc().name,
      kind,
    } satisfies ShareInvitation;
  }
  private async publish(vault: FileVault) {
    if (this.vaults.get(vault.id) !== vault) return;
    const folderSnapshots = await vault.folderSnapshots();
    if (this.vaults.get(vault.id) !== vault) return;
    await this.pruneDisabledUnits(vault, folderSnapshots);
    if (this.vaults.get(vault.id) !== vault) return;
    if (!vault.syncActive) {
      for (const local of this.catalog.scopes.filter(
        (local) => local.vault === vault.id && local.role === "edit",
      )) {
        const scope = this.scopes.get(local.url);
        if (!scope) continue;
        for (const [id, folder] of Object.entries(scope.doc().folders)) {
          const saved = this.catalog.folders[id];
          if (saved && saved.url !== folder.url)
            scope.change((doc) => {
              doc.folders[id].url = saved.url;
            });
        }
        for (const [id, file] of Object.entries(scope.doc().files)) {
          const saved = this.catalog.files[fileKey(vault, id)];
          if (saved && saved.url !== file.url)
            scope.change((doc) => {
              doc.files[id].url = saved.url;
              doc.files[id].epoch = saved.epoch;
            });
        }
      }
      await this.repository.flush();
      await this.persist();
      return;
    }
    for (const local of [...this.catalog.scopes])
      if (
        (local.vault === vault.id ||
          (local.vault === null &&
            local.workspaceId === this.workspace.current.id)) &&
        !local.owner &&
        !(await this.repository.documentAccess(local.url))
      )
        await this.disconnectLocal(local);
    // Explicitly enabled vaults added later inherit the whole-workspace group.
    // Receiving settings alone never mounts a local filesystem capability.
    for (const local of this.catalog.scopes.filter(
      (scope) =>
        scope.vault === null &&
        scope.workspaceId === this.workspace.current.id &&
        scope.role === "edit" &&
        scope.broadcast !== false,
    )) {
      const root =
          this.scopes.get(local.url) ??
          (await this.repository.load<ShareDocument>(local.url)),
        current = root.doc();
      await this.validateScope(root, local, current);
      if (
        current.kind !== "workspace" ||
        current.workspace !== this.catalog.workspace ||
        current.vaults[vault.id] ||
        this.catalog.scopes.some(
          (scope) =>
            scope.vault === vault.id &&
            Object.values(current.vaults).some(
              (child) => child.url === scope.url,
            ),
        )
      )
        continue;
      if ((await this.repository.documentAccess(root.url)) !== "edit") continue;
      const child = await this.allocateScope(vault, "vault", "", [
        current.group,
      ]);
      await this.watchScope(child.local);
      root.change((doc) => {
        doc.vaults[vault.id] = { name: vault.name, url: child.scope.url };
      });
      await this.repository.flush();
    }
    const blocked = await this.restrictDocuments(vault);
    if (this.vaults.get(vault.id) !== vault) return;
    for (const local of this.catalog.scopes.filter(
      (s) =>
        s.vault === vault.id &&
        s.role === "edit" &&
        s.broadcast !== false &&
        this.definitionEnabled(s, this.scopes.get(s.url)?.doc()),
    )) {
      const scope =
        this.scopes.get(local.url) ??
        (await this.repository.load<ShareDocument>(local.url));
      this.scopes.set(scope.url, scope);
      const current = scope.doc();
      if (current.kind === "folder" || current.kind === "vault")
        local.prefix = vault.scopePath(current.id, local.prefix);
      await this.validateScope(scope, local, current);
      const hasPeers = (await this.repository.shareMembers(scope.url)).some(
        (member) => !member.self,
      );
      if (current.kind !== "file") {
        const folders: ShareDocument["folders"] = {};
        for (const folder of folderSnapshots.filter(
          (folder) =>
            folder.path === local.prefix || under(folder.path, local.prefix),
        )) {
          if (!vault.folderFeatures(folder.path).sync) continue;
          const prior = current.folders[folder.doc.id],
            saved = this.catalog.folders[folder.doc.id];
          const url = saved?.url ?? prior?.url;
          let handle = this.folderHandles.get(folder.doc.id);
          if (!handle && url) {
            if (!(await this.repository.documentAccess(url)))
              throw Error("Folder transport access is unavailable");
            handle = await this.repository.load<FolderDocument>(url);
          }
          if (
            handle &&
            folderGeneration(handle.doc()) !== folderGeneration(folder.doc)
          ) {
            await vault.resumeFolderSharing(folder.path, handle.doc());
            folder.doc = vault.folderDocument(folder.path) ?? folder.doc;
          }
          const outside =
            handle &&
            (saved?.audiences ?? []).some((url) => {
              const other = this.catalog.scopes.find(
                (scope) => scope.url === url,
              );
              if (!other) return true;
              if (other.vault !== vault.id) return false; // An unopened ancestor is outside this capability.
              const value = this.scopes.get(other.url)?.doc();
              return (
                !vault.folderFeatures(folder.path).sync ||
                !this.definitionEnabled(other, value) ||
                ((value?.kind === "folder" || value?.kind === "vault") &&
                  folder.path !== other.prefix &&
                  !under(folder.path, other.prefix))
              );
            });
          if (
            !handle ||
            outside ||
            folderGeneration(handle.doc()) !== folderGeneration(folder.doc)
          ) {
            const retired = [
              ...(saved?.retired ?? []),
              ...(handle ? [handle.url] : []),
            ];
            handle = await this.repository.importProtected<FolderDocument>(
              A.save(folder.doc),
            );
            this.catalog.folders[folder.doc.id] = {
              url: handle.url,
              retired,
              audiences: [],
            };
          } else
            this.catalog.folders[folder.doc.id] ??= {
              url: handle.url,
              retired: [],
              audiences: [],
            };
          if (handle.doc().id !== folder.doc.id)
            throw Error("Shared folder identity mismatch");
          if (!sameHeads(handle.doc(), folder.doc))
            handle.update((doc) => A.merge(A.clone(doc), A.clone(folder.doc)));
          this.watchFolder(handle, vault, folder.path);
          const savedFolder = this.catalog.folders[folder.doc.id];
          if (!savedFolder.retention) {
            const control = await this.repository.create<RetentionDocument>({
              format: "saddle-retention/1",
              file: folder.doc.id,
              owner: this.repository.identityId,
              proposal: null,
            });
            savedFolder.retention = control.url;
          }
          if (hasPeers)
            await vault.protectHistory(folder.path, "folder", folder.doc.id, {
              document: handle.url,
              control: savedFolder.retention!,
            });
          const grant = current.group + "/" + handle.url;
          if (!this.granted.has(grant)) {
            await this.repository.grantDocumentGroup(
              handle,
              current.group,
              "edit",
            );
            this.granted.add(grant);
          }
          const retention = await this.watchFolderRetention(
            vault,
            handle,
            savedFolder.retention,
            folder.path,
          );
          const controlGrant = current.group + "/" + savedFolder.retention;
          if (!this.granted.has(controlGrant)) {
            await this.repository.grantDocumentGroup(
              await this.repository.load<RetentionDocument>(
                savedFolder.retention,
              ),
              current.group,
              "read",
            );
            this.granted.add(controlGrant);
          }
          if (!savedFolder.audiences.includes(local.url))
            savedFolder.audiences.push(local.url);
          folders[folder.doc.id] = {
            id: folder.doc.id,
            path:
              folder.path === local.prefix
                ? ""
                : local.prefix
                  ? folder.path.slice(local.prefix.length + 1)
                  : folder.path,
            url: handle.url,
            retention: savedFolder.retention,
          };
          if (
            !vault.folderFeatures(folder.path).history &&
            (A.stats(folder.doc).numChanges >= 32 ||
              (folder.doc.retainHistory === false &&
                A.stats(folder.doc).numChanges > 1))
          )
            void retention.begin().catch(this.error);
        }
        if (canonical(current.folders) !== canonical(folders)) {
          scope.change((doc) => {
            doc.folders = folders;
          });
          await this.repository.flush();
        }
      }
      const selected = vault
        .list()
        .filter(
          (f) =>
            vault.syncEnabled(f.id) &&
            (current.kind === "file"
              ? f.id === current.rootFile
              : under(f.path, local.prefix)),
        );
      const entries: Record<string, SharedFile> = {};
      const routeChanges = new Map<
        string,
        { path: string; deleted: boolean }
      >();
      for (const file of selected) {
        const prior = current.files[file.id];
        if (
          !sameRoute(local.routes[file.id], file) ||
          (prior &&
            this.catalog.files[fileKey(vault, file.id)]?.retired.includes(
              prior.url,
            ))
        )
          routeChanges.set(file.id, { path: file.path, deleted: file.deleted });
        // An unchanged replica must not resurrect a route that another peer
        // removed. Re-entry uses a fresh protected document, issued locally.
        if (
          prior?.deleted &&
          prior.url === this.catalog.files[fileKey(vault, file.id)]?.url
        ) {
          routeChanges.delete(file.id);
          continue;
        }
        if (blocked.has(file.id)) {
          routeChanges.delete(file.id);
          if (current.files[file.id]) entries[file.id] = current.files[file.id];
          continue;
        }
        const handle = await this.document(vault, file.id);
        if (hasPeers)
          await vault.protectHistory(
            vault.archivePath(file.id),
            "file",
            file.id,
            {
              document: handle.url,
              control: this.catalog.files[fileKey(vault, file.id)].retention,
            },
          );
        const grant = `${current.group}/${handle.url}`;
        if (!this.granted.has(grant)) {
          await this.repository.grantDocumentGroup(
            handle,
            current.group,
            "edit",
          );
          this.granted.add(grant);
        }
        const retentionURL =
          this.catalog.files[fileKey(vault, file.id)].retention;
        const control =
          await this.repository.load<RetentionDocument>(retentionURL);
        const controlGrant = `${current.group}/${control.url}`;
        if (!this.granted.has(controlGrant)) {
          await this.repository.grantDocumentGroup(
            control,
            current.group,
            "read",
          );
          this.granted.add(controlGrant);
        }
        const relative =
          current.kind === "folder" || current.kind === "vault"
            ? local.prefix
              ? file.path.slice(local.prefix.length + 1)
              : file.path
            : current.kind === "file"
              ? file.path.split("/").pop()!
              : file.path;
        entries[file.id] = {
          id: file.id,
          path: relative,
          url: handle.url,
          deleted: false,
          epoch: handle.doc().epoch,
          retention: control.url,
        };
        local.admitted[file.id] = true;
        const retention = await this.watchRetention(vault, handle, control.url);
        if (
          !vault.historyEnabled(file.id) &&
          vault.doc(file.id).retainHistory !== true &&
          (A.stats(vault.doc(file.id)).numChanges >= 32 ||
            (vault.doc(file.id).retainHistory === false &&
              A.stats(vault.doc(file.id)).numChanges > 1))
        )
          void retention.begin().catch(this.error);
      }
      for (const prior of Object.values(current.files))
        if (!entries[prior.id] && local.admitted[prior.id] === true) {
          if (blocked.has(prior.id)) {
            entries[prior.id] = prior;
            continue;
          }
          entries[prior.id] = { ...prior, deleted: true };
          if (!vault.hasEntry(prior.id)) {
            entries[prior.id] = prior;
            continue;
          }
          const entry = vault.entry(prior.id);
          routeChanges.set(prior.id, {
            path: entry.path,
            deleted: entry.deleted,
          });
        }
      if (canonical(current.files) !== canonical(entries)) {
        scope.change((d) => {
          // A remote peer may add a file while this publication awaits durable
          // writes. Preserve entries that have not been admitted locally yet.
          for (const [id, file] of Object.entries(entries)) {
            if (
              !file.deleted &&
              d.files[id]?.deleted &&
              d.files[id].url === file.url
            )
              continue;
            const next =
              !routeChanges.has(id) && d.files[id]
                ? {
                    ...file,
                    path: d.files[id].path,
                    deleted: d.files[id].deleted,
                  }
                : file;
            if (canonical(d.files[id]) !== canonical(next)) d.files[id] = next;
          }
        });
        await this.repository.flush();
      }
      for (const [id, route] of routeChanges) local.routes[id] = route;
      await this.persist();
    }
  }
  private needsRestriction(vault: FileVault, id: string) {
    if (this.vaults.get(vault.id) !== vault) return false;
    let file;
    try {
      file = vault.entry(id);
    } catch {
      return false;
    }
    return this.catalog.scopes.some((local) => {
      if (local.vault !== vault.id || local.admitted[id] !== true) return false;
      const scope = this.scopes.get(local.url),
        value = scope?.doc(),
        previous = value?.files[id];
      if (
        !scope ||
        !previous ||
        local.contract !== this.contract(scope) ||
        this.catalog.files[fileKey(vault, id)]?.url !== previous.url
      )
        return false;
      return (
        !vault.syncEnabled(id) ||
        !this.definitionEnabled(local, value) ||
        file.deleted ||
        ((value!.kind === "folder" || value!.kind === "vault") &&
          !under(file.path, local.prefix))
      );
    });
  }
  /** Keep retired encrypted documents immutable; only remaining scopes get the new URL. */
  private async restrictDocuments(vault: FileVault) {
    const blocked = new Set<string>();
    for (const [key, saved] of Object.entries(this.catalog.files)) {
      if (!key.startsWith(vault.id + "/")) continue;
      const id = key.slice(vault.id.length + 1);
      if (!this.needsRestriction(vault, id)) continue;
      const old =
        this.documents.get(saved.url) ??
        (await this.repository.load<FileDocument>(saved.url));
      const retention = await this.watchRetention(vault, old, saved.retention);
      if (this.vaults.get(vault.id) !== vault) return blocked;
      if (
        !vault.historyEnabled(id) &&
        vault.historyProtection(id) &&
        A.stats(vault.doc(id)).numChanges > 1
      ) {
        blocked.add(id);
        void retention.begin().catch(this.error);
        continue;
      }
      if (!retention.canRetire) {
        blocked.add(id);
        void retention.cancelForRetirement().catch(this.error);
        continue;
      }
      await vault.load(id);
      const handle = await this.repository.importProtected<FileDocument>(
        vault.exportDocument(id),
      );
      const control = await this.repository.create<RetentionDocument>({
        format: "saddle-retention/1",
        file: id,
        owner: this.repository.identityId,
        proposal: null,
      });
      this.catalog.files[key] = {
        url: handle.url,
        epoch: handle.doc().epoch,
        retention: control.url,
        retired: [...saved.retired, saved.url],
      };
      await this.persist();
      retention.close();
      this.retention.delete(`${vault.id}/${saved.retention}`);
      const freeze = vault.getFreeze(id);
      if (freeze) await vault.unfreezeHistory(id, freeze.token);
      this.watchFile(handle, vault);
    }
    return blocked;
  }
  async grant(
    invitation: ShareInvitation,
    contactCard: string,
    access: "read" | "edit",
  ) {
    const scope =
      this.scopes.get(invitation.url) ??
      (await this.repository.load<ShareDocument>(invitation.url));
    const local = this.catalog.scopes.find((s) => s.url === invitation.url);
    if (!local?.owner)
      throw Error("Only the share owner can change its membership");
    const current = scope.doc();
    await this.validateScope(scope, local, current);
    const vault = local.vault ? this.vaults.get(local.vault) : undefined;
    const own =
      current.kind === "workspace"
        ? this.workspace.current.features.sync
        : current.kind === "file"
          ? vault?.scopePolicies.files[current.rootFile!]?.sync
          : local.prefix
            ? vault?.scopePolicies.folders[local.prefix]?.sync
            : vault?.scopePolicies.vault.sync;
    if (own !== true)
      throw Error("Enable Sharing on this item before adding access");
    this.pendingGrants.add(scope.url);
    try {
      await this.protectScope(current, local);
      const member = await this.repository.grantGroup(
        current.group,
        contactCard,
        access,
      );
      await this.protectScope(scope.doc(), local);
      local.members ??= {};
      local.members[member] = access;
      await this.persist();
      return invitation;
    } finally {
      this.pendingGrants.delete(scope.url);
    }
  }
  async revoke(invitation: ShareInvitation, member: string) {
    const scope = this.scopes.get(invitation.url);
    if (
      !scope ||
      !this.catalog.scopes.some((s) => s.url === invitation.url && s.owner)
    )
      throw Error("Unknown owned share");
    const local = this.catalog.scopes.find((local) => local.url === scope.url)!;
    const current = scope.doc();
    await this.validateScope(scope, local, current);
    await this.repository.revokeGroup(current.group, member);
    if (local.members) {
      delete local.members[member];
      await this.persist();
    }
    await this.enqueue(async () => {
      for (const vault of this.vaults.values()) {
        await this.cleanUnsharedTransports(vault);
        await this.publish(vault);
      }
    });
  }
  async setAccess(
    invitation: ShareInvitation,
    member: string,
    access: "read" | "edit",
  ) {
    const local = this.catalog.scopes.find((s) => s.url === invitation.url),
      scope = this.scopes.get(invitation.url);
    if (!local?.owner || !scope)
      throw Error("Only the share owner can change its membership");
    await this.validateScope(scope, local);
    if (member === this.repository.identityId)
      throw Error("The owner keeps administration access");
    await this.repository.setGroupAccess(scope.doc().group, member, access);
    local.members ??= {};
    local.members[member] = access;
    await this.persist();
  }
  async join(
    value: string,
    destination: FileVault,
    prefix?: string,
    _role?: "read" | "edit",
  ) {
    const explicitPrefix = prefix;
    prefix ??= "";
    const invitation = parseShareLink(value);
    if (
      invitation.format !== "saddle-share-invitation/1" ||
      !isValidAutomergeUrl(invitation.url)
    )
      throw Error("Invalid share invitation");
    if (prefix) filePath(prefix);
    const scope = await this.repository.load<ShareDocument>(invitation.url);
    const contract = await this.validateScope(scope);
    if (invitation.kind !== scope.doc().kind)
      throw Error("Invitation scope differs from its signed share contract");
    if (scope.doc().kind === "workspace")
      throw Error(
        "Join workspace settings and select local vault folders first",
      );
    const known = this.catalog.scopes.find((local) => local.url === scope.url);
    if (known) {
      await this.validateScope(scope, known);
      if (
        known.vault !== destination.id ||
        (explicitPrefix !== undefined && prefix !== known.prefix)
      )
        throw Error("This share is already mounted at a different location");
      await this.watchScope(known);
      return scope.doc();
    }
    if (!known && scope.doc().kind === "vault" && destination.list().length)
      throw Error("Choose an empty folder to join a whole vault");
    if (scope.doc().kind === "folder" && explicitPrefix === undefined)
      prefix = filePath(scope.doc().name.split("/").pop()!);
    if (
      !known &&
      scope.doc().kind === "folder" &&
      destination.list().some((file) => under(file.path, prefix!))
    )
      throw Error("Choose an empty destination folder for this share");
    const role = await this.repository.documentAccess(scope.url);
    if (!role) throw Error("This computer has no access to the share");
    const prepareRoot = async () => {
      if (scope.doc().kind !== "file") {
        const unit = scope.doc().unit!,
          prior = await destination.companions.descriptor(prefix);
        if (prior && prior.id !== unit.id) {
          if (
            Object.keys(prior.shares ?? {}).length ||
            prior.namedKeys?.length ||
            (await destination.companions.read(prefix, "resource.json"))
          )
            throw Error(
              "Destination folder already has independent metadata or shares",
            );
          await destination.companions.remove(prefix, folderName);
        }
        await destination.companions.describe(prefix, {
          ...prior,
          format: "saddle-companion/1",
          id: unit.id,
          kind: "folder",
          features: prior?.features ?? {},
        });
        const root = scope.doc().folders[unit.id];
        if (
          !root ||
          root.path !== "" ||
          !isValidAutomergeUrl(root.url) ||
          !(await this.repository.groupCanRead(scope.doc().group, root.url))
        )
          throw Error("Share is missing its authenticated root folder");
        const handle = await this.repository.load<FolderDocument>(root.url);
        if (handle.doc().id !== unit.id)
          throw Error("Share root identity mismatch");
        await destination.receiveFolder(prefix, handle.doc());
        await destination.protectHistory(prefix, "folder", unit.id, {
          document: handle.url,
          control: root.retention,
        });
      }
    };
    const local: LocalScope = {
      unit: scope.doc().unit!,
      url: scope.url,
      vault: destination.id,
      prefix,
      owner: false,
      role,
      contract,
      admitted: {},
      routes: {},
    };
    if (!this.catalog.scopes.some((s) => s.url === scope.url))
      this.catalog.scopes.push(local);
    await this.persist();
    this.applying.add(destination.id);
    try {
      await prepareRoot();
      if (scope.doc().kind === "file") {
        const root = scope.doc().files[scope.doc().rootFile!];
        if (root && destination.hasEntry(root.id))
          await destination.protectHistory(
            destination.archivePath(root.id),
            "file",
            root.id,
            { document: root.url, control: root.retention },
          );
      }
      await destination.configureScope(
        scope.doc().kind === "file"
          ? "file"
          : scope.doc().kind === "folder"
            ? "folder"
            : "vault",
        scope.doc().kind === "file" ? scope.doc().rootFile! : prefix,
        { sync: true },
      );
      await this.attach(destination);
      await this.watchScope(local);
    } finally {
      this.finishedApplying(destination.id);
    }
    return scope.doc();
  }
  private async watchScope(local: LocalScope) {
    const existing = this.scopes.get(local.url);
    const scope =
      existing ?? (await this.repository.load<ShareDocument>(local.url));
    this.scopes.set(scope.url, scope);
    const receive = async () => {
      if (!this.catalog.scopes.includes(local) || local.broadcast === false)
        return;
      if (!local.owner && !(await this.repository.documentAccess(local.url))) {
        await this.disconnectLocal(local);
        return;
      }
      const value = scope.doc(),
        vault = local.vault ? this.vaults.get(local.vault) : undefined;
      await this.validateScope(scope, local, value);
      await this.repository.flush();
      if (value.workspace) {
        if (value.workspaceRetention) {
          if (
            !(await this.repository.groupCanRead(
              value.group,
              value.workspaceRetention,
            ))
          )
            throw Error(
              "Workspace history control is outside its authenticated group",
            );
          this.catalog.workspaceControls ??= {};
          this.catalog.workspaceControls[this.workspace.current.id] =
            value.workspaceRetention;
        }
        if (local.owner || this.catalog.workspace === value.workspace)
          await this.watchWorkspace(value.workspace);
      }
      if (!vault || !vault.syncActive || !this.definitionEnabled(local, value))
        return;
      this.applying.add(vault.id);
      try {
        await vault.reconcile();
        if (value.kind === "file" && Object.keys(value.folders).length)
          throw Error("A file share cannot contain folders");
        for (const folder of Object.values(value.folders)) {
          documentId(folder.id);
          if (this.catalog.folders[folder.id]?.retired.includes(folder.url))
            continue;
          if (folder.path) filePath(folder.path);
          const path = [local.prefix, folder.path].filter(Boolean).join("/");
          if (!vault.folderFeatures(path).sync) continue;
          if (!isValidAutomergeUrl(folder.url))
            throw Error("Invalid shared folder URL");
          const handle = await this.repository.load<FolderDocument>(folder.url);
          if (!isValidAutomergeUrl(folder.retention))
            throw Error("Invalid folder retention URL");
          if (
            !(await this.repository.groupCanRead(value.group, folder.url)) ||
            !(await this.repository.groupCanRead(value.group, folder.retention))
          )
            throw Error(
              "Shared folder is outside its authenticated access group",
            );
          if (handle.doc().id !== folder.id)
            throw Error("Shared folder identity mismatch");
          this.catalog.folders[folder.id] ??= {
            url: handle.url,
            retired: [],
            audiences: [],
          };
          const priorFolder = vault.folderDocument(path);
          if (this.catalog.folders[folder.id]?.url === folder.url)
            await vault.resumeFolderSharing(path, handle.doc());
          if (
            priorFolder &&
            folderGeneration(vault.folderDocument(path) ?? priorFolder) !==
              folderGeneration(handle.doc())
          ) {
            const saved = this.catalog.folders[folder.id];
            const old =
              saved && (await this.repository.load<FolderDocument>(saved.url));
            if (!old) throw Error("Missing folder checkpoint baseline");
            const retention = await this.watchFolderRetention(
              vault,
              old,
              folder.retention,
              path,
            );
            await retention.acceptCommitted(A.save(handle.doc()));
          }
          await vault.receiveFolder(path, handle.doc());
          await vault.protectHistory(path, "folder", folder.id, {
            document: folder.url,
            control: folder.retention,
          });
          this.catalog.folders[folder.id] = {
            ...this.catalog.folders[folder.id],
            url: folder.url,
            retention: folder.retention,
          };
          this.watchFolder(handle, vault, path);
          await this.watchFolderRetention(
            vault,
            handle,
            folder.retention,
            path,
          );
        }
        for (const file of Object.values(value.files)) {
          filePath(file.path);
          if (
            this.catalog.files[fileKey(vault, file.id)]?.retired.includes(
              file.url,
            )
          ) {
            this.deferred.add(vault.id);
            continue;
          }
          if (value.kind === "file" && file.id !== value.rootFile)
            throw Error("A single-file share cannot add other files");
          let existing;
          try {
            existing = vault.entry(file.id);
          } catch {}
          if (
            existing &&
            (value.kind === "folder" || value.kind === "vault") &&
            !under(existing.path, local.prefix)
          ) {
            if (local.admitted[file.id] === true) {
              this.deferred.add(vault.id);
              continue;
            }
            throw Error(
              "Shared file identity collides outside its destination folder",
            );
          }
          if (
            existing &&
            local.admitted[file.id] !== true &&
            this.catalog.files[fileKey(vault, file.id)]?.url !== file.url
          )
            throw Error(
              "Shared file identity collides with an unrelated local file",
            );
          const incomingPath =
            local.owner && value.kind === "file"
              ? (existing?.path ?? local.prefix)
              : local.prefix
                ? `${local.prefix}/${file.path}`
                : file.path;
          if (
            !(existing
              ? vault.syncEnabled(file.id)
              : effectiveFeatures(
                  vault.scopePolicies,
                  vault.workspaceFeatures,
                  incomingPath,
                  file.id,
                ).sync)
          )
            continue;
          if (file.deleted && !existing) continue;
          if (existing) await vault.load(file.id);
          if (
            vault.list().some((f) => f.id === file.id) &&
            vault.doc(file.id).epoch > file.epoch &&
            vault.historyProtection(file.id)
          )
            continue;
          if (!isValidAutomergeUrl(file.url))
            throw Error("Invalid shared file URL");
          const handle =
            this.documents.get(file.url) ??
            (await this.repository.load<FileDocument>(file.url));
          if (
            !(await this.repository.groupCanRead(value.group, file.url)) ||
            !(await this.repository.groupCanRead(value.group, file.retention))
          )
            throw Error(
              "Shared file is outside its authenticated access group",
            );
          if (handle.doc().id !== file.id || handle.doc().epoch !== file.epoch)
            throw Error("Shared file identity mismatch");
          if (
            existing &&
            this.catalog.files[fileKey(vault, file.id)]?.url === file.url
          )
            await vault.resumeFileSharing(file.id, handle.doc());
          if (
            vault.list().some((f) => f.id === file.id) &&
            vault.doc(file.id).generation !== handle.doc().generation
          ) {
            const retention = await this.watchRetention(
              vault,
              this.documents.get(
                this.catalog.files[fileKey(vault, file.id)]?.url,
              ) ?? handle,
              file.retention,
            );
            if (vault.doc(file.id).generation !== handle.doc().generation)
              await retention.acceptCommitted(A.save(handle.doc()));
          }
          if (
            vault.list().some((f) => f.id === file.id) &&
            vault.doc(file.id).epoch > file.epoch
          )
            continue;
          const existingEntry = vault.list().find((f) => f.id === file.id);
          const path =
            local.owner && value.kind === "file"
              ? (existingEntry?.path ?? local.prefix)
              : local.prefix
                ? `${local.prefix}/${file.path}`
                : file.path;
          if (file.deleted && existingEntry && existingEntry.path !== path)
            continue;
          if (!file.deleted || vault.list().some((f) => f.id === file.id)) {
            const latest = (() => {
              try {
                return vault.entry(file.id);
              } catch {
                return undefined;
              }
            })();
            const preserveRoute =
              latest &&
              local.routes[file.id] &&
              !sameRoute(local.routes[file.id], latest);
            const route = preserveRoute
              ? { path: latest.path, deleted: latest.deleted }
              : { path, deleted: file.deleted };
            await vault.receiveSharedFile(
              { id: file.id, ...route },
              A.save(handle.doc()),
            );
            await vault.protectHistory(path, "file", file.id, {
              document: file.url,
              control: file.retention,
            });
            const prior = this.catalog.files[fileKey(vault, file.id)];
            this.catalog.files[fileKey(vault, file.id)] = {
              url: file.url,
              epoch: file.epoch,
              retention: file.retention,
              retired: prior
                ? [
                    ...prior.retired,
                    ...(prior.url !== file.url ? [prior.url] : []),
                  ]
                : [],
            };
            if (!preserveRoute) local.routes[file.id] = route;
            local.admitted[file.id] = true;
            this.watchFile(handle, vault);
            await this.watchRetention(vault, handle, file.retention);
          }
        }
        await this.persist();
      } finally {
        this.finishedApplying(vault.id);
      }
    };
    if (!this.scopeSubscriptions.has(local.url)) {
      this.scopeSubscriptions.add(local.url);
      const changed = () => {
        void this.enqueue(receive);
      };
      scope.on("change", changed);
      this.unsubscribers.push(() => scope.off("change", changed));
    }
    await receive();
  }
  async createWorkspace(vaults: FileVault[]) {
    await this.workspace.configure({ sync: true });
    const group = await this.repository.createGroup();
    const handle = await this.repository.importProtected<FileWorkspace>(
      this.workspace.export(),
    );
    await this.repository.grantDocumentGroup(handle, group, "edit");
    this.catalog.workspace = handle.url;
    this.catalog.workspaces ??= {};
    this.catalog.workspaces[this.workspace.current.id] = handle.url;
    const workspaceControl = await this.repository.create<RetentionDocument>({
      format: "saddle-retention/1",
      file: this.workspace.current.id,
      owner: this.repository.identityId,
      proposal: null,
    });
    await this.repository.grantDocumentGroup(workspaceControl, group, "read");
    this.catalog.workspaceControls ??= {};
    this.catalog.workspaceControls[this.workspace.current.id] =
      workspaceControl.url;
    const children: ShareDocument["vaults"] = {};
    for (const vault of vaults) {
      const invitation = await this.create(vault, "vault", "", [group]);
      const scope = this.scopes.get(invitation.url)!;
      children[vault.id] = { name: vault.name, url: invitation.url };
    }
    const scope = await this.repository.createGrouped<ShareDocument>(
      {
        format: "saddle-share/1",
        id: crypto.randomUUID(),
        kind: "workspace",
        unit: null,
        rootFile: null,
        contract: "",
        name: this.workspace.current.name,
        group,
        files: {},
        folders: {},
        workspace: handle.url,
        workspaceRetention: workspaceControl.url,
        vaults: children,
      },
      group,
    );
    await this.signScope(scope);
    this.catalog.scopes.push({
      url: scope.url,
      vault: null,
      workspaceId: this.workspace.current.id,
      prefix: "",
      owner: true,
      role: "edit",
      contract: this.contract(scope),
      admitted: {},
      routes: {},
    });
    this.scopes.set(scope.url, scope);
    await this.persist();
    await this.watchWorkspace(handle.url);
    return {
      format: "saddle-share-invitation/1",
      url: scope.url,
      name: scope.doc().name,
      kind: "workspace",
    } satisfies ShareInvitation;
  }
  private applyingWorkspace = false;
  private workspaceRetentions = new Map<
    string,
    HistoryRetention<FileWorkspace>
  >();
  async rewriteWorkspaceHistory(operation: HistoryRewrite) {
    const id = this.workspace.current.id,
      url = this.catalog.workspaces?.[id];
    if (!url) return this.workspace.rewriteHistory(operation);
    await this.flushWorkspace();
    const controlURL = this.catalog.workspaceControls?.[id];
    if (!controlURL) throw Error("This workspace share has no history control");
    await (
      await this.watchWorkspaceRetention(
        await this.repository.load<FileWorkspace>(url),
        controlURL,
      )
    ).rewrite(operation);
  }
  private workspaceRetentionOpen = new Map<
    string,
    Promise<HistoryRetention<FileWorkspace>>
  >();
  private watchWorkspaceRetention(
    file: DocHandle<FileWorkspace>,
    url: AutomergeUrl,
  ) {
    const current = this.workspaceRetentions.get(url);
    if (current) return Promise.resolve(current);
    const pending = this.workspaceRetentionOpen.get(url);
    if (pending) return pending;
    const opened = this.openWorkspaceRetention(file, url);
    this.workspaceRetentionOpen.set(url, opened);
    void opened
      .finally(() => this.workspaceRetentionOpen.delete(url))
      .catch(() => {});
    return opened;
  }
  private async openWorkspaceRetention(
    file: DocHandle<FileWorkspace>,
    url: AutomergeUrl,
  ) {
    const active = this.workspaceRetentions.get(url);
    if (active) return active;
    const control = await this.repository.load<RetentionDocument>(url);
    if (
      !(await this.repository.isDocumentAdmin(
        fromHex(control.doc().owner),
        file.url,
      )) ||
      !(await this.repository.isDocumentAdmin(
        fromHex(control.doc().owner),
        control.url,
      ))
    )
      throw Error("Workspace history control must belong to its administrator");
    const id = file.doc().id;
    const target = this.workspace.retentionTarget(async (freeze) => {
      this.catalog.workspaceFreezes ??= {};
      if (freeze) this.catalog.workspaceFreezes[id] = freeze;
      else delete this.catalog.workspaceFreezes[id];
      await this.persist();
    }, this.catalog.workspaceFreezes?.[id]);
    const adopt = target.acceptCheckpoint;
    target.acceptCheckpoint = async (unit, bytes, token) => {
      this.applyingWorkspace = true;
      try {
        await adopt(unit, bytes, token);
        const nextURL = control.doc().proposal?.next;
        if (nextURL) {
          this.catalog.workspaces![id] = nextURL;
          this.catalog.workspace = nextURL;
          await this.persist();
          await this.watchWorkspace(nextURL);
        }
      } finally {
        this.applyingWorkspace = false;
      }
    };
    const retention = await HistoryRetention.open(
      this.repository,
      target,
      file,
      control,
      async (old, token, operation) => {
        this.applyingWorkspace = true;
        try {
          const doc = await this.workspace.checkpointHistory(
            A.getHeads(old.doc()),
            token,
            operation,
          );
          const next = await this.repository.importProtected<FileWorkspace>(
            A.save(doc),
          );
          for (const local of this.catalog.scopes.filter(
            (scope) => scope.workspaceId === id && scope.vault === null,
          )) {
            const scope =
              this.scopes.get(local.url) ??
              (await this.repository.load<ShareDocument>(local.url));
            await this.repository.grantDocumentGroup(
              next,
              scope.doc().group,
              "edit",
            );
            scope.change((value) => {
              value.workspace = next.url;
            });
          }
          this.catalog.workspaces![id] = next.url;
          this.catalog.workspace = next.url;
          await this.persist();
          await this.watchWorkspace(next.url);
          await target.unfreezeHistory(id, token);
          return next;
        } finally {
          this.applyingWorkspace = false;
        }
      },
      this.error,
      () => this.flushWorkspace(),
    );
    this.workspaceRetentions.set(url, retention);
    return retention;
  }
  async flushWorkspace() {
    if (this.applyingWorkspace || !this.broadcastsWorkspace()) return;
    const current = this.catalog.workspaces?.[this.workspace.current.id];
    if (!current) return;
    const handle = await this.repository.load<FileWorkspace>(current);
    if (
      workspaceGeneration(handle.doc()) !==
      workspaceGeneration(this.workspace.current)
    )
      return;
    handle.update((prior) =>
      A.merge(A.clone(prior), A.load<FileWorkspace>(this.workspace.export())),
    );
    await this.repository.flush();
    if (
      !sameHeads(handle.doc(), A.load<FileWorkspace>(this.workspace.export()))
    )
      await this.workspace.merge(A.save(handle.doc()));
  }
  private async ensureWorkspaceControl(file: DocHandle<FileWorkspace>) {
    const id = file.doc().id;
    if (
      this.catalog.workspaceControls?.[id] ||
      !(await this.repository.isDocumentAdmin(
        fromHex(this.repository.identityId),
        file.url,
      ))
    )
      return;
    const scopes = this.catalog.scopes.filter(
      (scope) => scope.vault === null && scope.workspaceId === id,
    );
    if (!scopes.length) return;
    const control = await this.repository.create<RetentionDocument>({
      format: "saddle-retention/1",
      file: id,
      owner: this.repository.identityId,
      proposal: null,
    });
    for (const local of scopes) {
      const scope =
        this.scopes.get(local.url) ??
        (await this.repository.load<ShareDocument>(local.url));
      await this.validateScope(scope, local, scope.doc());
      await this.repository.grantDocumentGroup(
        control,
        scope.doc().group,
        "read",
      );
      scope.change((value) => {
        value.workspaceRetention = control.url;
      });
    }
    this.catalog.workspaceControls ??= {};
    this.catalog.workspaceControls[id] = control.url;
    await this.persist();
    await this.repository.flush();
  }
  private async watchWorkspace(url: AutomergeUrl) {
    if (this.workspaceHandle?.url === url) return;
    const handle = await this.repository.load<FileWorkspace>(url);
    if (handle.doc().id !== this.workspace.current.id) return;
    await this.ensureWorkspaceControl(handle);
    const controlURL = this.catalog.workspaceControls?.[handle.doc().id];
    if (
      workspaceGeneration(handle.doc()) !==
      workspaceGeneration(this.workspace.current)
    ) {
      if (!controlURL)
        throw Error("Missing authenticated workspace history control");
      const prior = this.workspaceHandle ?? handle;
      await (
        await this.watchWorkspaceRetention(prior, controlURL)
      ).acceptCommitted(A.save(handle.doc()));
    }
    this.workspaceHandle = handle;
    this.catalog.workspace = url;
    this.catalog.workspaces ??= {};
    this.catalog.workspaces[this.workspace.current.id] = url;
    const receive = () => {
      if (this.workspaceHandle !== handle || !this.broadcastsWorkspace())
        return;
      void this.enqueue(async () => {
        await this.repository.flush();
        if (
          !sameHeads(
            handle.doc(),
            A.load<FileWorkspace>(this.workspace.export()),
          )
        )
          await this.workspace.merge(A.save(handle.doc()));
      });
    };
    handle.on("change", receive);
    this.unsubscribers.push(() => handle.off("change", receive));
    await this.repository.flush();
    if (this.broadcastsWorkspace())
      await this.workspace.merge(A.save(handle.doc()));
    if (controlURL) await this.watchWorkspaceRetention(handle, controlURL);
    await this.persist();
  }
  static async inspect(repository: Repository, value: string) {
    const invitation = parseShareLink(value);
    const handle = await repository.load<ShareDocument>(invitation.url);
    await validateShareScope(repository, handle);
    if (invitation.kind !== handle.doc().kind)
      throw Error("Invitation scope differs from its signed share contract");
    return handle;
  }
  inspectInvitation(value: string) {
    return ProtectedFileSync.inspect(this.repository, value);
  }
  /** Joining settings is explicit. Folder capabilities are selected on this machine. */
  async joinWorkspace(
    value: string,
    computer: string,
    vaultLocations: Record<string, string>,
  ) {
    const scope = await this.inspectInvitation(value),
      share = scope.doc();
    if (share.kind !== "workspace" || !share.workspace)
      throw Error("Expected a workspace invitation");
    if ((await this.repository.documentAccess(scope.url)) !== "edit")
      throw Error(
        "Editing access is required to join shared workspace settings",
      );
    if (share.workspaceRetention) {
      if (
        !(await this.repository.groupCanRead(
          share.group,
          share.workspaceRetention,
        ))
      )
        throw Error(
          "Workspace history control is outside its authenticated group",
        );
      this.catalog.workspaceControls ??= {};
    }
    const settings = await this.repository.load<FileWorkspace>(share.workspace);
    if (!(await this.repository.groupCanRead(share.group, settings.url)))
      throw Error(
        "Workspace settings are outside the share's authenticated group",
      );
    await this.repository.flush();
    await this.workspace.adopt(
      A.save(settings.doc()),
      computer,
      vaultLocations,
    );
    if (share.workspaceRetention)
      this.catalog.workspaceControls![settings.doc().id] =
        share.workspaceRetention;
    this.catalog.workspace = settings.url;
    this.catalog.workspaces ??= {};
    this.catalog.workspaces[settings.doc().id] = settings.url;
    if (!this.catalog.scopes.some((s) => s.url === scope.url))
      this.catalog.scopes.push({
        url: scope.url,
        vault: null,
        workspaceId: settings.doc().id,
        prefix: "",
        owner: false,
        role: "edit",
        contract: this.contract(scope),
        admitted: {},
        routes: {},
      });
    this.scopes.set(scope.url, scope);
    await this.persist();
    await this.watchWorkspace(settings.url);
    return share;
  }
  close() {
    for (const id of this.vaults.keys()) this.detach(id);
    this.unsubscribers.splice(0).forEach((fn) => fn());
    this.retention.forEach((r) => r.close());
    this.workspaceRetentions.forEach((r) => r.close());
    return this.queue;
  }
  async flush() {
    await this.queue;
    await this.repository.flush();
  }
}
