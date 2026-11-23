import {
  rewriteHistory,
  replayHistoryDelta,
  fileRewriteShape,
  folderRewriteShape,
  type HistoryRewrite,
} from "./history-rewrite.js";
import {
  folderEpoch,
  folderGeneration,
  folderName,
  type FolderDocument,
} from "./folder-document.js";
import * as A from "@automerge/automerge";
import { canonical, digest, text, utf8 } from "../crypto.js";
import {
  documentId,
  filePath,
  type FileDocument,
  type FileSystemChange,
  type FileSystemEntry,
  type FileDraft,
  type FileEntry,
  type FileSummary,
  type MaterializationState,
  type MaterializedFile,
  type RenameMatcher,
  type TemplateReference,
  type VaultFileSystem,
  type VaultManifest,
  type VaultPolicy,
} from "./contracts.js";
import { mimeType, textMime } from "./mime.js";
import { csdbState, csdbText, updateCSDB } from "./csdb-model.js";
import {
  importMetadata,
  newResource,
  MetadataErrors,
  parseResource,
  resourceContentType,
  relocatedResource,
  serializeResource,
  setResourceContentType,
  sidecarPath,
  isSidecar,
  type DataResource,
  type FileMetadata,
} from "./metadata.js";
import {
  effectiveFeatures,
  emptyScopePolicies,
  needsDocument,
  noFeatures,
  type Features,
  type FeatureOverrides,
} from "./scope-policy.js";
import { patchSettings } from "./workspace.js";
import {
  hasDistinctConflicts,
  historyLabel,
  historyMessage,
  textChangeSize,
} from "./history.js";
import { selectedCSDBRows, type CSDBRowSelection } from "./csdb.js";
import {
  Companions,
  companionDescriptor,
  companionPath,
  companionOwner,
  contentName,
  resourceName,
  parseCompanion,
  type CompanionDescriptor,
} from "./companions.js";
import { memoryLocalFiles } from "./local-files.js";

const settingsPath = "root-index.json";
const equalHeads = (left: A.Heads, right: A.Heads) =>
  [...left].sort().join() === [...right].sort().join();
const textProjections = new WeakMap<FileDocument, string>();
const historyCache = new WeakMap<FileDocument, FileHistoryVersion[]>();
export interface FileHistoryVersion {
  hash: string;
  heads: string[];
  message: string | null;
  description: string;
  event: string;
  time: number;
  bytes: Uint8Array;
  changes:
    { added: number; removed: number } | { before: number; after: number };
}
export function fileText(doc: FileDocument) {
  if (!doc.csdb) return doc.text;
  if (!A.isAutomerge(doc)) return csdbText(doc.csdb);
  let value = textProjections.get(doc);
  if (value === undefined) {
    value = csdbText(doc.csdb);
    textProjections.set(doc, value);
  }
  return value;
}
export const fileBytes = (doc: FileDocument) =>
  doc.kind === "text" ? utf8.encode(fileText(doc)) : new Uint8Array(doc.bytes);

export class Draft implements FileDraft {
  text: string;
  bytes: Uint8Array;
  mime: string;
  resource: DataResource | null;
  invalidResource: string | null;
  path: string;
  get contentType() {
    return resourceContentType(this.resource);
  }
  set contentType(value: string | null) {
    this.resource = setResourceContentType(this.resource, this.path, value);
  }
  private templateValue: TemplateReference | null = null;
  get template() {
    return this.templateValue;
  }
  set template(value: TemplateReference | null) {
    this.templateValue = value;
    if (value || this.resource?.saddle?.template) {
      this.resource ??= newResource(this.path);
      this.resource.saddle ??= {};
      if (value) this.resource.saddle.template = { ...value };
      else delete this.resource.saddle.template;
    }
  }
  get baseline() {
    return A.getHeads(this.original);
  }
  constructor(
    readonly fileId: string,
    public original: A.Doc<FileDocument>,
    path = "file",
  ) {
    this.path = path;
    this.text = fileText(original);
    this.bytes = new Uint8Array(original.bytes);
    this.mime = original.mime;
    this.resource = original.resource
      ? structuredClone(A.toJS(original).resource)
      : null;
    this.invalidResource = original.invalidResource;
    this.template = original.template
      ? structuredClone(A.toJS(original).template)
      : null;
  }
  get dirty() {
    return (
      this.text !== fileText(this.original) ||
      this.mime !== this.original.mime ||
      canonical(this.resource) !== canonical(this.original.resource) ||
      this.invalidResource !== this.original.invalidResource ||
      canonical(this.template) !== canonical(this.original.template) ||
      this.bytes.length !== this.original.bytes.length ||
      this.bytes.some((b, i) => b !== this.original.bytes[i])
    );
  }
}

/** One serialized durable writer per vault. No network, native execution, or UI. */
export class FileVault {
  readonly metadataErrors = new MetadataErrors();
  private diagnosticsPersisted = "";
  private metadataCache = new WeakMap<
    FileDocument,
    { path: string; value: FileMetadata; error?: string }
  >();
  private inherited: Features = { ...noFeatures };
  get version() {
    return this.revision;
  }
  private docs = new Map<string, A.Doc<FileDocument>>();
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private drafts = new Set<Draft>();
  private revision = 0;
  private folders: string[] = [];
  private frozen: Record<
    string,
    { token: string; heads: A.Heads; epoch: number; rewrite?: HistoryRewrite }
  > = {};
  readonly companions: Companions;
  private batching = false;
  private lazy = false;
  private scopeLocations = new Map<string, string>();
  private unitLocations = new Map<string, string>();
  unitPath(id: string) {
    return this.unitLocations.get(id);
  }
  private unloaded = new Set<string>();
  private cachedMetadata = new Map<string, FileMetadata>();
  private persistedDocuments = new Map<string, string>();
  private inventory = new Map<string, FileSystemEntry>();
  private constructor(
    readonly fs: VaultFileSystem,
    readonly computer: string,
    private manifest: A.Doc<VaultManifest>,
    private state: MaterializationState,
    readonly renames: RenameMatcher | undefined,
    readonly local: VaultFileSystem,
  ) {
    this.companions = new Companions(fs);
  }
  static async open(
    fs: VaultFileSystem,
    computer: string,
    options: {
      id?: string;
      name?: string;
      renames?: RenameMatcher;
      features?: Features;
      local?: VaultFileSystem;
      lazy?: boolean;
    } = {},
  ) {
    documentId(computer);
    const local = options.local ?? memoryLocalFiles(fs);
    const saved = await local.read(settingsPath);
    const settings = saved
      ? (JSON.parse(text.decode(saved)) as VaultManifest)
      : undefined;
    if (settings && settings.format !== "saddle-root-index/1")
      throw Error("Invalid root index");
    const manifest = A.from<VaultManifest>(
      settings
        ? { ...settings, name: options.name ?? settings.name }
        : {
            format: "saddle-root-index/1",
            id: options.id ?? crypto.randomUUID(),
            name: options.name ?? "Folder",
            policy: { history: false, sync: false },
            coordinated: false,
            files: {},
            scopes: emptyScopePolicies(),
            namedPaths: {},
            templates: {},
          },
    );
    if (options.id && manifest.id !== options.id)
      throw Error("Opened folder reference changed");
    const state: MaterializationState = {
      format: "saddle-materialization/1",
      files: {},
    };
    const vault = new FileVault(
      fs,
      computer,
      manifest,
      state,
      options.renames,
      local,
    );
    vault.lazy = options.lazy ?? false;
    vault.inherited = { ...(options.features ?? noFeatures) };
    const retention = await local.read(`retention-${computer}.json`);
    if (retention) vault.frozen = JSON.parse(text.decode(retention));
    const localPaths = new Set(await local.list());
    const moves = [...localPaths].filter(
      (path) => path.startsWith("moves/") && path.endsWith(".json"),
    );
    for (const journal of moves) {
      const move = JSON.parse(text.decode((await local.read(journal))!)) as {
        id: string;
        from: string;
        to: string;
        folder?: boolean;
      };
      documentId(move.id);
      filePath(move.from);
      filePath(move.to);
      const source = await fs.stat?.(move.from),
        target = await fs.stat?.(move.to);
      if (source && !target && fs.move) await fs.move(move.from, move.to);
      if (source && target)
        throw Error(
          "An interrupted move has two destinations; preserve both before resolving the conflict",
        );
      await vault.companions.move(move.from, move.to);
      vault.manifest = A.change(A.clone(vault.manifest), (d) => {
        for (const entry of Object.values(d.files))
          if (
            entry.path === move.from ||
            (move.folder && entry.path.startsWith(move.from + "/"))
          )
            entry.path = move.to + entry.path.slice(move.from.length);
        if (move.folder)
          for (const path of Object.keys(d.scopes.folders))
            if (path === move.from || path.startsWith(move.from + "/")) {
              d.scopes.folders[move.to + path.slice(move.from.length)] = {
                ...d.scopes.folders[path],
              };
              delete d.scopes.folders[path];
            }
      });
    }
    await vault.discoverCompanions();
    for (const entry of Object.values(vault.manifest.files)) {
      const savedState = await local.read(
        `materialized/${computer}/${entry.id}.json`,
      );
      if (savedState)
        state.files[entry.id] = JSON.parse(text.decode(savedState));
    }
    for (const entry of Object.values(vault.manifest.files)) {
      documentId(entry.id);
      filePath(entry.path);
      const pending = await local.read(`pending/${entry.id}.automerge`);
      if (
        vault.lazy &&
        !pending &&
        !localPaths.has(`checkpoints/${computer}-${entry.id}.automerge`)
      ) {
        const placeholder = await vault.readPlainDocument(
          entry.id,
          entry.path,
          new Uint8Array(),
        );
        vault.docs.set(entry.id, placeholder);
        vault.unloaded.add(entry.id);
        const archived = await vault.companions.stat(
          entry.storage ?? entry.path,
          contentName,
        );
        if (archived) vault.persistedDocuments.set(entry.id, "unloaded");
        if (!state.files[entry.id]) {
          const stat = vault.inventory.get(entry.path);
          state.files[entry.id] = {
            path: entry.path,
            hash: "",
            heads: [],
            epoch: 0,
            deleted: entry.deleted,
            stamp: stat?.stamp,
            sidecar: await vault.sidecarCheckpoint(entry.path),
          };
        }
        continue;
      }
      const archived = await vault.companions.read(
        entry.storage ?? entry.path,
        contentName,
      );
      const backupPath = `checkpoints/${computer}-${entry.id}.automerge`;
      const backup = await local.read(backupPath);
      let doc: A.Doc<FileDocument>;
      if (pending || archived) {
        doc = A.load<FileDocument>((pending ?? archived)!);
        if (backup && state.files[entry.id]?.epoch !== doc.epoch) {
          doc = A.load<FileDocument>(backup);
          await vault.companions.write(
            entry.storage ?? entry.path,
            contentName,
            backup,
          );
        }
        vault.validateDocument(doc, entry.id);
      } else {
        const baseline =
          (await local.read(`baselines/${entry.id}.bin`)) ??
          (await vault.companions.read(
            entry.storage ?? entry.path,
            "baseline.bin",
          ));
        const visible =
          baseline ?? (await fs.read(entry.path)) ?? new Uint8Array();
        doc = await vault.readPlainDocument(entry.id, entry.path, visible);
        if (!state.files[entry.id])
          state.files[entry.id] = {
            path: entry.path,
            heads: A.getHeads(doc),
            epoch: doc.epoch,
            hash: await digest(visible),
            deleted: entry.deleted,
            sidecar: await vault.sidecarCheckpoint(entry.path),
          };
        else state.files[entry.id].heads = A.getHeads(doc);
      }
      vault.docs.set(entry.id, doc);
      if (archived)
        vault.persistedDocuments.set(entry.id, A.getHeads(doc).sort().join());
      if (archived && !pending)
        await vault.restoreArchiveCheckpoint(entry.id, doc);
      if (pending) await vault.materialize(entry.id);
      if (backup) await local.remove(backupPath);
    }
    const diagnostics = await local.read("metadata-errors.json");
    if (diagnostics)
      for (const diagnostic of JSON.parse(text.decode(diagnostics)))
        vault.metadataErrors.entries.set(diagnostic.file, diagnostic);
    await vault.reconcile();
    await vault.refreshDocumentStorage();
    for (const move of moves) await local.remove(move);
    await vault.cleanInactiveArchivesOnOpen();
    return vault;
  }
  /** Rebuild portable rules/identities from companions; the device index is not authoritative. */
  private async discoverCompanions() {
    const priorPolicies = canonical([
      this.manifest.scopes,
      this.manifest.namedPaths,
      this.manifest.templates,
    ]);
    this.protectedHistory.clear();
    const root = await this.companions.descriptor("");
    if (root) this.discoverScopes("", root);
    const inventory = this.fs.scan ? await this.fs.scan() : undefined;
    if (inventory)
      this.inventory = new Map(inventory.map((entry) => [entry.path, entry]));
    const packages = inventory
      ? inventory.filter((e) => e.kind === "companion").map((e) => e.path)
      : (await this.fs.list()).filter(
          (p) => p.split("/").at(-1)!.startsWith(".") && p.endsWith(".saddle"),
        );
    const descriptors: Array<[string, CompanionDescriptor, string?]> = [];
    for (const path of packages) {
      const owner = companionOwner(path);
      const descriptor = await this.companions.descriptor(owner);
      if (descriptor) {
        this.discoverScopes(owner, descriptor);
        descriptors.push([owner, descriptor]);
      }
    }
    this.unitLocations.clear();
    for (const [path, descriptor] of [
      ...descriptors,
      ...(root ? [["", root] as [string, CompanionDescriptor]] : []),
    ]) {
      if (
        this.unitLocations.has(descriptor.id) &&
        this.unitLocations.get(descriptor.id) !== path
      )
        throw Error(
          `Duplicate companion identity at ${this.unitLocations.get(descriptor.id)} and ${path}`,
        );
      this.unitLocations.set(descriptor.id, path);
    }
    const fileDeclarations = new Map<
      string,
      { keys: string[]; template?: { name: string; enabled: boolean } }
    >();
    for (const [path, descriptor] of descriptors) {
      if (descriptor.kind !== "file" || descriptor.deleted) continue;
      const bytes = await this.companions.read(path, resourceName);
      if (!bytes) continue;
      let resource: DataResource;
      try {
        resource = parseResource(text.decode(bytes));
      } catch {
        continue;
      } // Invalid metadata is reported by the shared metadata pipeline.
      const values = resource.saddle;
      const keys = Array.isArray(values?.namedKeys)
        ? values.namedKeys.filter(
            (key): key is string => typeof key === "string",
          )
        : [];
      const template = values?.templateDefinition;
      fileDeclarations.set(path, {
        keys,
        ...(template &&
        typeof template === "object" &&
        !Array.isArray(template) &&
        typeof template.name === "string" &&
        typeof template.enabled === "boolean"
          ? { template: { name: template.name, enabled: template.enabled } }
          : {}),
      });
    }
    this.manifest = A.change(A.clone(this.manifest), (d) => {
      d.scopes = emptyScopePolicies();
      d.namedPaths = {};
      d.templates = {};
      const declarations = [
        ...descriptors,
        ...(root ? [["", root] as [string, CompanionDescriptor]] : []),
      ];
      for (const [path, descriptor] of declarations) {
        if (descriptor.deleted) continue;
        for (const key of descriptor.kind === "file"
          ? (fileDeclarations.get(path)?.keys ?? [])
          : (descriptor.namedKeys ?? []))
          d.namedPaths[descriptor.id + ":" + key] = {
            id: descriptor.id,
            key,
            path,
            kind: descriptor.kind,
          };
        const template = fileDeclarations.get(path)?.template;
        if (template) d.templates[path] = { path, ...template };
      }
      if (root) d.scopes.vault = root.features;
      for (const [path, descriptor, retainedPath] of descriptors) {
        if (descriptor.kind === "folder") {
          if (!descriptor.deleted && Object.keys(descriptor.features).length)
            d.scopes.folders[path] = descriptor.features;
        } else {
          const prior = d.files[descriptor.id];
          if (
            prior &&
            prior.path !== path &&
            this.inventory.has(prior.path) &&
            this.inventory.has(path)
          )
            throw Error(
              "Duplicate companion identity; copy files without their companions to create independent copies",
            );
          const deleted = descriptor.materialized?.deleted ?? false;
          const logical = deleted
            ? [
                ...path.split("/").slice(0, -1),
                descriptor.deletedPath ?? descriptor.materialized!.path,
              ].join("/")
            : path;
          d.files[descriptor.id] = {
            id: descriptor.id,
            path: logical,
            deleted,
            ...(logical !== path ? { storage: path } : {}),
          };
          d.scopes.files[descriptor.id] = descriptor.features;
          if (!this.state.files[descriptor.id] && descriptor.materialized)
            this.state.files[descriptor.id] = this.portableCheckpoint(
              logical,
              descriptor.materialized,
              path,
            );
        }
      }
      d.policy = { ...this.inherited, ...d.scopes.vault };
    });
    // Stable child IDs are location hints for an orphan folder companion. They do
    // not create access to an ancestor, or guess identities for unmatched files.
    const foldersById = new Map(
      descriptors
        .filter(([, d]) => d.kind === "folder")
        .map(([path, d]) => [d.id, path]),
    );
    const hintedPaths = new Map<string, Set<string>>();
    const hint = async (
      storage: string,
      previous: string,
      visited: Set<string>,
    ) => {
      if (visited.has(storage)) throw Error("Cyclic folder membership hints");
      const bytes = await this.companions.read(storage, "membership.json");
      if (!bytes) return;
      const members = JSON.parse(text.decode(bytes)) as {
        format: string;
        children: FolderDocument["children"];
      };
      if (
        members.format !== "saddle-membership/1" ||
        !members.children ||
        typeof members.children !== "object" ||
        Array.isArray(members.children)
      )
        throw Error("Invalid folder membership hints");
      const next = new Set(visited).add(storage);
      for (const [id, child] of Object.entries(members.children)) {
        documentId(id);
        if (
          !child ||
          typeof child.name !== "string" ||
          child.name.includes("/") ||
          !["file", "folder"].includes(child.kind)
        )
          throw Error("Invalid folder member hint");
        filePath(child.name);
        const oldPath = previous + "/" + child.name;
        if (child.kind === "folder") {
          const owner = foldersById.get(id);
          if (owner) await hint(owner, oldPath, next);
        } else if (
          this.state.files[id] &&
          !this.manifest.files[id]?.deleted &&
          this.inventory.get(this.manifest.files[id]?.path)?.kind === "file"
        ) {
          const paths = hintedPaths.get(id) ?? new Set<string>();
          paths.add(oldPath);
          hintedPaths.set(id, paths);
        }
      }
    };
    if (inventory)
      for (const [path, descriptor] of descriptors)
        if (
          descriptor.kind === "folder" &&
          !descriptor.deleted &&
          !this.inventory.has(path)
        )
          await hint(path, path, new Set());
    for (const [id, paths] of hintedPaths)
      if (paths.size === 1) this.state.files[id].path = [...paths][0];
    if (
      priorPolicies !==
      canonical([
        this.manifest.scopes,
        this.manifest.namedPaths,
        this.manifest.templates,
      ])
    )
      this.revision++;
  }
  get id() {
    return this.manifest.id;
  }
  get name() {
    return this.manifest.name;
  }
  isLoaded(id: string) {
    return !this.unloaded.has(id);
  }
  fileMime(id: string) {
    const doc = this.docs.get(documentId(id));
    if (!doc) throw Error("Unknown vault file");
    return doc.mime;
  }
  fileSize(id: string) {
    return this.inventory.get(this.entry(id).path)?.size;
  }
  documentRevision(id: string) {
    const state = this.state.files[id];
    return `${state?.hash}:${state?.stamp}:${state?.sidecar?.hash ?? ""}`;
  }
  private async loadDocument(id: string) {
    if (!this.unloaded.has(id)) return;
    const entry = this.entry(id),
      archive = await this.companions.read(this.archivePath(id), contentName);
    const baseline = !archive && (await this.local.read(`baselines/${id}.bin`));
    const visible =
      !archive &&
      (baseline || (await this.fs.read(entry.path)) || new Uint8Array());
    const doc = archive
      ? A.load<FileDocument>(archive)
      : await this.readPlainDocument(id, entry.path, visible as Uint8Array);
    this.validateDocument(doc, id);
    this.docs.set(id, doc);
    this.unloaded.delete(id);
    if (archive) this.persistedDocuments.set(id, A.getHeads(doc).sort().join());
    const restored = archive && (await this.restoreArchiveCheckpoint(id, doc));
    // Ordinary saves made while an enclosing feature is out of scope do not
    // rewrite its archive. Reconstruct that working value from the file.
    if (restored && !needsDocument(this.features(id)) && !entry.deleted) {
      const bytes = await this.fs.read(entry.path);
      if (bytes) {
        const plain = await this.readPlainDocument(id, entry.path, bytes);
        const data = A.toJS(plain);
        const draft = new Draft(id, A.clone(doc), entry.path);
        draft.text = fileText(plain);
        draft.bytes = new Uint8Array(plain.bytes);
        draft.resource = data.resource ? structuredClone(data.resource) : null;
        draft.invalidResource = plain.invalidResource;
        draft.template = data.template;
        this.docs.set(id, this.applyDraft(draft, doc, "External edit"));
        Object.assign(this.state.files[id], {
          heads: A.getHeads(this.doc(id)),
          hash: await digest(bytes),
          stamp: (await this.fs.stat?.(entry.path))?.stamp,
          sidecar: await this.sidecarCheckpoint(entry.path),
        });
        await this.local.writeAtomic(`baselines/${id}.bin`, bytes);
        await this.checkpoint([id]);
      }
    }
    const checkpoint = this.state.files[id];
    if (!archive || !checkpoint?.heads.length) {
      this.state.files[id] = {
        ...checkpoint,
        path: entry.path,
        heads: A.getHeads(doc),
        epoch: doc.epoch,
        hash: await digest(fileBytes(doc)),
        deleted: entry.deleted,
        stamp: (await this.fs.stat?.(entry.path))?.stamp,
        sidecar: await this.sidecarCheckpoint(entry.path),
      };
      if (!archive)
        await this.local.writeAtomic(`baselines/${id}.bin`, fileBytes(doc));
      await this.checkpoint([id]);
    }
    this.metadata(id);
  }
  private portableCheckpoint(
    path: string,
    value: MaterializedFile,
    storage = path,
  ): MaterializedFile {
    return {
      ...value,
      path,
      stamp: undefined,
      sidecar: value.sidecar
        ? {
            path: companionPath(storage) + "/" + resourceName,
            hash: value.sidecar.hash,
          }
        : null,
    };
  }
  private async restoreArchiveCheckpoint(id: string, doc: A.Doc<FileDocument>) {
    const checkpoint = this.state.files[id];
    if (checkpoint?.heads.length && A.hasHeads(doc, checkpoint.heads))
      return false;
    const saved = (await this.companions.descriptor(this.archivePath(id)))
      ?.materialized;
    if (!saved || !A.hasHeads(doc, saved.heads))
      throw Error(
        "File archive does not contain its materialization checkpoint",
      );
    const restored = this.portableCheckpoint(
      this.entry(id).path,
      saved,
      this.archivePath(id),
    );
    if (checkpoint) Object.assign(checkpoint, restored);
    else this.state.files[id] = restored;
    return true;
  }
  async load(id: string) {
    await this.write(() => this.loadDocument(id));
    return this.doc(id);
  }
  unload(id: string) {
    if (
      !this.lazy ||
      this.unloaded.has(id) ||
      this.syncEnabled(id) ||
      this.hasDirtyDraft(id) ||
      [...this.drafts].some((d) => d.fileId === id)
    )
      return;
    const doc = this.docs.get(id);
    if (!doc) return;
    this.cachedMetadata.set(id, this.metadata(id));
    this.docs.set(
      id,
      A.from<FileDocument>({
        ...A.toJS(doc),
        text: "",
        csdb: null,
        bytes: new Uint8Array(),
      }),
    );
    this.unloaded.add(id);
  }
  historyEnabled(id: string) {
    return (
      this.features(id).history && this.docs.get(id)?.retainHistory !== false
    );
  }
  syncEnabled(id: string) {
    return this.features(id).sync;
  }
  features(id: string): Features {
    return effectiveFeatures(
      this.manifest.scopes,
      this.inherited,
      this.entry(id).path,
      id,
    );
  }
  get workspaceFeatures() {
    return this.inherited;
  }
  get scopePolicies() {
    return this.manifest.scopes;
  }
  inheritFeatures(features: Features) {
    const next = { ...features };
    return this.write(async () => {
      if (canonical(next) === canonical(this.inherited)) return;
      const previous = this.inherited;
      const before = new Map(
        [...this.docs.keys()].map((id) => [id, this.features(id)]),
      );
      this.inherited = next;
      try {
        for (const [id, doc] of this.docs) {
          const prior = before.get(id)!,
            current = this.features(id);
          if (prior.history === current.history) continue;
          await this.loadDocument(id);
          const currentDoc = this.docs.get(id)!;
          if (current.history && currentDoc.retainHistory !== true) {
            await this.persistDoc(
              A.change(
                A.clone(currentDoc),
                { message: "Enable history" },
                (value) => {
                  value.retainHistory = true;
                },
              ),
            );
            if (this.state.files[id]) await this.materialize(id);
          } else if (!current.history && currentDoc.retainHistory !== false) {
            await this.persistDoc(
              A.change(
                A.clone(currentDoc),
                { message: "Disable history" },
                (value) => {
                  value.retainHistory = false;
                },
              ),
            );
            if (this.state.files[id]) await this.materialize(id);
          }
        }
        await this.refreshDocumentStorage(
          new Set(
            [...before]
              .filter(
                ([id, previous]) =>
                  needsDocument(previous) && !needsDocument(this.features(id)),
              )
              .map(([id]) => id),
          ),
        );
        if (previous.history !== next.history)
          await this.markFolderHistory(() => true);
        await this.cleanHistory();
      } catch (error) {
        this.inherited = previous;
        throw error;
      }
      this.notify();
    });
  }
  private async persistVaultSettings() {
    if (this.batching) return;
    await this.local.writeAtomic(
      settingsPath,
      utf8.encode(JSON.stringify(A.toJS(this.manifest)) + "\n"),
    );
    const root = this.manifest.scopes.vault;
    const rootPrior = await this.companions.descriptor("");
    if (Object.keys(root).length || rootPrior) {
      const prior = rootPrior;
      await this.companions.updateDescriptor("", (latest) => ({
        ...latest,
        format: "saddle-companion/1",
        id: prior?.id ?? this.id,
        kind: "folder",
        features: { ...root },
      }));
      await this.companions.cleanup("");
    }
    for (const [path, policy] of Object.entries(this.manifest.scopes.folders)) {
      const prior = await this.companions.descriptor(path);
      if (Object.keys(policy).length || prior)
        await this.companions.updateDescriptor(path, (latest) => ({
          ...latest,
          format: "saddle-companion/1",
          id: prior?.id ?? crypto.randomUUID(),
          kind: "folder",
          features: { ...policy },
        }));
      await this.companions.cleanup(path);
    }
    for (const [id, entry] of Object.entries(this.manifest.files)) {
      const policy = this.manifest.scopes.files[id] ?? {};
      if (Object.keys(policy).length)
        await this.describeFile(id, entry.storage ?? entry.path);
    }
  }
  private protectedHistory = new Map<
    string,
    {
      path: string;
      kind: "file" | "folder";
      reference: NonNullable<CompanionDescriptor["retention"]>;
    }
  >();
  get hasProtectedHistory() {
    return this.protectedHistory.size > 0;
  }
  historyProtection(id: string) {
    const unit = this.protectedHistory.get(id);
    return unit
      ? {
          ...unit,
          path:
            unit.kind === "file" && this.manifest.files[id]
              ? this.archivePath(id)
              : (this.unitPath(id) ?? unit.path),
        }
      : undefined;
  }
  historyProtections() {
    return [...this.protectedHistory.keys()].map((id) => ({
      id,
      ...this.historyProtection(id)!,
    }));
  }
  protectHistory(
    path: string,
    kind: "file" | "folder",
    id: string,
    reference: NonNullable<CompanionDescriptor["retention"]>,
  ) {
    return this.write(async () => {
      const location =
        kind === "file" && this.manifest.files[id]
          ? this.archivePath(id)
          : (this.unitPath(id) ?? path);
      await this.companions.updateDescriptor(location, (prior) => ({
        ...prior,
        format: "saddle-companion/1",
        id,
        kind,
        features: prior?.features ?? {},
        retention: reference,
      }));
      this.protectedHistory.set(id, { path: location, kind, reference });
    });
  }
  releaseHistoryProtection(id: string) {
    return this.write(async () => {
      const protectedUnit = this.historyProtection(id);
      if (!protectedUnit) return;
      await this.companions.updateDescriptor(protectedUnit.path, (prior) => {
        if (!prior) throw Error("Missing retained unit descriptor");
        const next = { ...prior };
        delete next.retention;
        return next;
      });
      this.protectedHistory.delete(id);
      await this.cleanHistory();
      await this.refreshDocumentStorage(new Set([id]));
      await this.companions.cleanup(protectedUnit.path);
      this.notify();
    });
  }
  /** Clean inactive archives inside this capability, never inspect ancestors outside it. */
  private async cleanInactiveArchivesOnOpen() {
    const removed = new Set<string>();
    for (const id of this.docs.keys()) {
      if (
        this.historyEnabled(id) ||
        this.protectedHistory.has(id) ||
        !this.persistedDocuments.has(id)
      )
        continue;
      await this.loadDocument(id);
      if (A.stats(this.doc(id)).numChanges > 1) await this.prune(id);
      removed.add(id);
    }
    if (removed.size) await this.refreshDocumentStorage(removed);
    await this.pruneFolderStorage(() => true);
  }
  /** Only the absence of external participants permits unilateral compaction. */
  private async cleanHistory() {
    for (const [id] of this.docs) {
      if (
        this.historyEnabled(id) ||
        this.protectedHistory.has(id) ||
        this.unloaded.has(id) ||
        this.hasDirtyDraft(id)
      )
        continue;
      if (A.stats(this.doc(id)).numChanges > 1) await this.prune(id);
    }
    await this.pruneFolderStorage(() => true);
  }
  private folderDocuments = new Map<string, A.Doc<FolderDocument>>();
  private folderStamps = new Map<string, string>();
  private async loadFolder(path: string) {
    const stat = await this.companions.stat(path, folderName),
      cached = this.folderDocuments.get(path);
    if (cached && stat?.stamp === this.folderStamps.get(path)) return cached;
    const bytes = stat
      ? await this.companions.read(path, folderName)
      : undefined;
    if (!bytes) {
      if (this.folderDocuments.delete(path)) this.revision++;
      this.folderStamps.delete(path);
      return;
    }
    const doc = A.load<FolderDocument>(bytes);
    if (!cached || !equalHeads(A.getHeads(cached), A.getHeads(doc)))
      this.revision++;
    this.folderDocuments.set(path, doc);
    this.folderStamps.set(path, stat!.stamp);
    return doc;
  }
  private async saveFolder(path: string, doc: A.Doc<FolderDocument>) {
    const previous = this.folderDocuments.get(path);
    await this.companions.saveDocument(path, folderName, doc);
    this.folderDocuments.set(path, doc);
    if (!previous || !equalHeads(A.getHeads(previous), A.getHeads(doc)))
      this.revision++;
    const stat = await this.companions.stat(path, folderName);
    if (stat) this.folderStamps.set(path, stat.stamp);
  }
  private async syncFolder(path: string, children: FolderDocument["children"]) {
    let descriptor = await this.companions.descriptor(path);
    const features = effectiveFeatures(
      this.manifest.scopes,
      this.inherited,
      path ? path + "/__folder__" : "__folder__",
    );
    if (!descriptor && !needsDocument(features)) return;
    if (!descriptor) {
      await this.ensureUnit(path, "folder");
      descriptor = (await this.companions.descriptor(path))!;
    }
    if (descriptor.kind !== "folder" || descriptor.deleted) return;
    if (
      needsDocument(features) ||
      Object.keys(descriptor.features).length ||
      descriptor.namedKeys?.length ||
      (await this.companions.stat(path, resourceName))
    )
      await this.companions.write(
        path,
        "membership.json",
        utf8.encode(
          JSON.stringify({ format: "saddle-membership/1", children }),
        ),
      );
    const archived = await this.loadFolder(path);
    // Collect an inactive archive for cleanup without creating a new one.
    if (!needsDocument(features) && !this.protectedHistory.has(descriptor.id))
      return archived;
    const bytes = await this.companions.read(path, resourceName);
    const resource = bytes ? parseResource(text.decode(bytes)) : null;
    const value: FolderDocument = {
      format: "saddle-folder/1",
      id: descriptor.id,
      features: { ...descriptor.features },
      namedKeys: descriptor.namedKeys ?? [],
      resource,
      children,
      ...(archived?.retainHistory !== undefined
        ? { retainHistory: archived.retainHistory }
        : features.history
          ? { retainHistory: true }
          : {}),
      ...(archived?.checkpoint
        ? { checkpoint: A.toJS(archived).checkpoint }
        : {}),
    };
    let doc = archived ?? A.from(value);
    if (doc.format !== value.format || doc.id !== value.id)
      throw Error("Folder archive identity mismatch");
    if (canonical(A.toJS(doc)) !== canonical(value))
      doc = A.change(
        A.clone(doc),
        { message: historyMessage("Update folder", "") },
        (draft) => {
          patchSettings(draft, value);
        },
      );
    if (
      !features.history &&
      !this.protectedHistory.has(descriptor.id) &&
      A.stats(doc).numChanges > 1
    )
      doc = this.freshFolder(doc);
    if (!archived || !equalHeads(A.getHeads(archived), A.getHeads(doc))) {
      if (this.frozen[doc.id]) {
        delete this.frozen[doc.id];
        await this.persistRetention();
      }
      await this.saveFolder(path, doc);
    }
    return doc;
  }
  folderSnapshots(prefix = "") {
    return this.write(async () => {
      const version = this.revision;
      const result = await this.collectFolderSnapshots(prefix);
      if (version !== this.revision) this.notify();
      return result;
    });
  }
  private async collectFolderSnapshots(prefix = "") {
    const paths = [
      prefix,
      ...this.directories().filter(
        (path) => (!prefix || path.startsWith(prefix + "/")) && path !== prefix,
      ),
    ];
    const result: Array<{ path: string; doc: A.Doc<FolderDocument> }> = [];
    const members = new Map<string, FolderDocument["children"]>();
    const add = (
      path: string,
      id: string,
      kind: "file" | "folder",
      deleted: boolean,
    ) => {
      const parent = path.split("/").slice(0, -1).join("/");
      let values = members.get(parent);
      if (!values) members.set(parent, (values = {}));
      values[id] = { name: path.split("/").at(-1)!, kind, deleted };
    };
    for (const entry of Object.values(this.manifest.files))
      add(entry.path, entry.id, "file", entry.deleted);
    // Children first: each entry is examined once and each parent gets direct members.
    for (const path of paths.sort(
      (a, b) => (b ? b.split("/").length : 0) - (a ? a.split("/").length : 0),
    )) {
      const doc = await this.syncFolder(path, members.get(path) ?? {});
      if (doc) {
        result.push({ path, doc });
        if (path) add(path, doc.id, "folder", false);
      } else if (path) {
        const descriptor = await this.companions.descriptor(path);
        if (descriptor)
          add(path, descriptor.id, "folder", !!descriptor.deleted);
      }
    }
    return result;
  }
  setFolderResource(path: string, resource: DataResource | null) {
    if (path) filePath(path);
    if (resource) parseResource(serializeResource(resource));
    return this.write(async () => {
      await this.ensureUnit(path, "folder");
      if (resource)
        await this.companions.write(
          path,
          resourceName,
          utf8.encode(serializeResource(resource)),
        );
      else await this.companions.remove(path, resourceName);
      await this.collectFolderSnapshots(path);
      await this.companions.cleanup(path);
      this.notify();
    });
  }
  folderFeatures(path: string) {
    return effectiveFeatures(
      this.manifest.scopes,
      this.inherited,
      path ? path + "/__folder__" : "__folder__",
    );
  }
  /** Count the same rollback rows as folderHistory, without constructing snapshots. */
  folderHistoryVersionCount(path: string) {
    const doc = this.folderDocuments.get(path);
    return this.folderFeatures(path).history && doc
      ? A.stats(doc).numChanges
      : 0;
  }
  folderHistory(path: string): FileHistoryVersion[] {
    if (!this.folderFeatures(path).history) return [];
    const doc = this.folderDocuments.get(path);
    if (!doc) return [];
    let previous = "";
    const heads = new Set<string>();
    return A.getAllChanges(doc).map((encoded, index) => {
      const change = A.decodeChange(encoded);
      for (const parent of change.deps) heads.delete(parent);
      heads.add(change.hash);
      const json = JSON.stringify(A.toJS(A.view(doc, [...heads])), null, 2);
      const changes = textChangeSize(previous, json);
      previous = json;
      return {
        hash: change.hash,
        heads: [...heads],
        message: change.message,
        ...historyLabel(
          change.message,
          index === 0 ? "Folder created" : "Update folder",
        ),
        time: change.time,
        bytes: utf8.encode(json),
        changes,
      };
    });
  }
  folderDocument(path: string) {
    return this.folderDocuments.get(path);
  }
  folderCurrent(path: string) {
    const doc = this.folderDocuments.get(path);
    return doc ? JSON.stringify(A.toJS(doc), null, 2) : "";
  }
  async restoreFolder(path: string, heads: string[]) {
    if (!this.folderFeatures(path).history)
      throw Error("Folder history is disabled");
    const doc = this.folderDocuments.get(path);
    if (!doc || !A.hasHeads(doc, heads))
      throw Error("Unknown folder history version");
    const snapshot = A.toJS(A.view(doc, heads));
    const next = A.change(
      A.clone(doc),
      { message: historyMessage("Restore folder", "") },
      (value) => {
        value.features = snapshot.features;
        value.namedKeys = snapshot.namedKeys;
        value.resource = snapshot.resource;
      },
    );
    await this.receiveFolder(path, next);
  }
  private async markFolderHistory(applies: (path: string) => boolean) {
    for (const [path, doc] of this.folderDocuments) {
      const enabled = this.folderFeatures(path).history;
      if (!applies(path) || doc.retainHistory === enabled) continue;
      await this.saveFolder(
        path,
        A.change(
          A.clone(doc),
          { message: enabled ? "Enable history" : "Disable history" },
          (value) => {
            value.retainHistory = enabled;
            patchSettings(value.features as Record<string, unknown>, {
              ...(path
                ? (this.manifest.scopes.folders[path] ?? {})
                : this.manifest.scopes.vault),
            });
          },
        ),
      );
    }
  }
  private freshFolder(doc: A.Doc<FolderDocument>) {
    if (hasDistinctConflicts(doc)) return doc;
    return A.from<FolderDocument>({
      ...A.toJS(doc),
      checkpoint: {
        epoch: folderEpoch(doc) + 1,
        generation: crypto.randomUUID(),
      },
    });
  }
  private async pruneFolderStorage(applies: (path: string) => boolean) {
    for (const path of new Set([
      "",
      ...this.directories(),
      ...this.folderDocuments.keys(),
    ])) {
      if (!applies(path)) continue;
      const doc = this.folderDocuments.get(path),
        features = this.folderFeatures(path);
      if (
        features.history ||
        (doc &&
          (this.protectedHistory.has(doc.id) || hasDistinctConflicts(doc)))
      )
        continue;
      if (features.sync && doc) {
        if (A.stats(doc).numChanges > 1)
          await this.saveFolder(path, this.freshFolder(doc));
      } else if (!needsDocument(features)) {
        await this.companions.remove(path, folderName);
        if (this.folderDocuments.delete(path)) this.revision++;
        this.folderStamps.delete(path);
        await this.companions.cleanup(path);
      }
    }
  }
  fileRetentionTarget(): import("./retention").RetentionTarget<FileDocument> {
    return {
      prepareForPruning: (incoming) =>
        this.write(async () => {
          const doc = this.doc(incoming.id);
          if (
            this.historyEnabled(incoming.id) ||
            this.hasDirtyDraft(incoming.id) ||
            incoming.retainHistory !== false
          )
            return;
          const content = (value: FileDocument) => {
            const { retainHistory: _, ...rest } = A.toJS(value);
            return canonical(rest);
          };
          if (
            content(doc) !== content(incoming) ||
            equalHeads(A.getHeads(doc), A.getHeads(incoming))
          )
            return;
          await this.persistDoc(A.merge(A.clone(doc), A.clone(incoming)));
          await this.materialize(incoming.id);
          this.notify();
        }),
      getFreeze: (id) => this.getFreeze(id),
      doc: (id) => this.doc(id),
      historyEnabled: (id) => this.historyEnabled(id),
      retainsHistory: (id) => this.doc(id).retainHistory === true,
      hasDirtyDraft: (id) => this.hasDirtyDraft(id),
      epoch: (doc) => doc.epoch,
      generation: (doc) => doc.generation,
      validateHistoryRewrite: (id, operation) => {
        const next = rewriteHistory(
          this.doc(id),
          operation,
          crypto.randomUUID(),
          fileRewriteShape,
        );
        this.validateDocument(next, id);
        fileBytes(next);
        if (next.resource) parseResource(serializeResource(next.resource));
      },
      freezeHistory: (id, token, heads, rewrite) =>
        this.freezeHistory(id, token, heads, rewrite),
      unfreezeHistory: (id, token) => this.unfreezeHistory(id, token),
      acceptCheckpoint: (id, bytes, token) =>
        this.acceptCheckpoint(id, bytes, token),
      historyPruned: async (id) => {
        if (!this.syncEnabled(id)) await this.releaseHistoryProtection(id);
      },
    };
  }
  folderRetentionTarget(
    path: string,
  ): import("./retention").RetentionTarget<FolderDocument> {
    const unit = this.folderDocuments.get(path)?.id;
    const location = () => (unit && this.unitPath(unit)) ?? path;
    const current = () => {
      const doc = this.folderDocuments.get(location());
      if (!doc) throw Error("Folder archive is unavailable");
      return doc;
    };
    return {
      prepareForPruning: async (incoming) => {
        const doc = current();
        if (
          this.folderFeatures(location()).history ||
          incoming.retainHistory !== false
        )
          return;
        const content = (value: FolderDocument) => {
          const result = A.toJS(value);
          result.retainHistory = false;
          result.features.history = false;
          return canonical(result);
        };
        if (
          content(doc) !== content(incoming) ||
          equalHeads(A.getHeads(doc), A.getHeads(incoming))
        )
          return;
        await this.receiveFolder(location(), incoming);
      },
      historyPruned: async (id) => {
        if (!this.folderFeatures(location()).sync)
          await this.releaseHistoryProtection(id);
      },
      getFreeze: (id) => this.getFreeze(id),
      doc: () => current(),
      historyEnabled: () => this.folderFeatures(location()).history,
      retainsHistory: () => current().retainHistory === true,
      hasDirtyDraft: () => false,
      epoch: folderEpoch,
      generation: folderGeneration,
      validateHistoryRewrite: (_, operation) =>
        this.validateFolderDocument(
          rewriteHistory(
            current(),
            operation,
            crypto.randomUUID(),
            folderRewriteShape,
          ),
        ),
      freezeHistory: (id, token, heads, rewrite) =>
        this.write(async () => {
          const doc = current();
          if (
            doc.id !== id ||
            (!rewrite &&
              (this.folderFeatures(location()).history ||
                doc.retainHistory === true)) ||
            hasDistinctConflicts(doc) ||
            !equalHeads(A.getHeads(doc), heads) ||
            (this.frozen[id] && this.frozen[id].token !== token)
          )
            return false;
          this.frozen[id] = {
            token,
            heads,
            epoch: folderEpoch(doc),
            ...(rewrite ? { rewrite } : {}),
          };
          await this.persistRetention();
          this.notify();
          return true;
        }),
      unfreezeHistory: (id, token) => this.unfreezeHistory(id, token),
      acceptCheckpoint: (id, bytes, token) =>
        this.write(async () => {
          const incoming = A.load<FolderDocument>(bytes),
            doc = current(),
            frozen = this.frozen[id];
          if (folderGeneration(incoming) === folderGeneration(doc)) return;
          if (
            incoming.id !== id ||
            !frozen ||
            frozen.token !== token ||
            folderEpoch(incoming) !== folderEpoch(doc) + 1
          )
            throw Error("Folder checkpoint requires an agreed freeze");
          const baseline = A.getHistory(incoming)[0]?.snapshot;
          const content = (value: FolderDocument) => {
            const { checkpoint: _, ...rest } = A.toJS(value);
            return canonical(rest);
          };
          if (
            frozen.rewrite
              ? !A.hasHeads(
                  incoming,
                  A.getHeads(
                    rewriteHistory(
                      A.view(doc, frozen.heads),
                      frozen.rewrite,
                      token,
                      folderRewriteShape,
                    ),
                  ),
                )
              : !baseline ||
                content(baseline) !== content(A.view(doc, frozen.heads))
          )
            throw Error("Folder checkpoint does not match its frozen state");
          if (frozen.rewrite)
            await this.materializeFolder(
              location(),
              incoming,
              await this.companions.descriptor(location()),
            );
          else await this.saveFolder(location(), incoming);
          delete this.frozen[id];
          await this.persistRetention();
          this.notify();
        }),
    };
  }
  checkpointFolderHistory(
    path: string,
    heads: A.Heads,
    token: string,
    rewrite?: HistoryRewrite,
  ) {
    return this.write(async () => {
      const doc = this.folderDocuments.get(path);
      if (
        !doc ||
        (!rewrite &&
          (this.folderFeatures(path).history || doc.retainHistory === true)) ||
        this.frozen[doc.id]?.token !== token ||
        !equalHeads(A.getHeads(doc), heads)
      )
        throw Error("Folder history checkpoint is no longer eligible");
      if (rewrite)
        await this.materializeFolder(
          path,
          rewriteHistory(doc, rewrite, token, folderRewriteShape),
          await this.companions.descriptor(path),
        );
      else await this.saveFolder(path, this.freshFolder(doc));
      delete this.frozen[doc.id];
      await this.persistRetention();
      this.notify();
      return this.folderDocuments.get(path)!;
    });
  }
  private validateFolderDocument(incoming: A.Doc<FolderDocument>) {
    if (incoming.format !== "saddle-folder/1")
      throw Error("Invalid shared folder document");
    documentId(incoming.id);
    if (
      !incoming.children ||
      typeof incoming.children !== "object" ||
      Array.isArray(incoming.children)
    )
      throw Error("Invalid folder membership");
    for (const [id, child] of Object.entries(incoming.children)) {
      documentId(id);
      if (
        !child ||
        typeof child.name !== "string" ||
        child.name.includes("/") ||
        !["file", "folder"].includes(child.kind) ||
        typeof child.deleted !== "boolean"
      )
        throw Error("Invalid folder member");
      filePath(child.name);
    }
    if (incoming.resource)
      parseResource(serializeResource(A.toJS(incoming).resource!));
  }
  receiveFolder(path: string, incoming: A.Doc<FolderDocument>) {
    return this.write(async () => {
      if (path) filePath(path);
      this.validateFolderDocument(incoming);
      const prior = await this.companions.descriptor(path);
      if (prior && (prior.id !== incoming.id || prior.kind !== "folder"))
        throw Error("Shared folder identity collides with another unit");
      const current = await this.loadFolder(path);
      if (current && folderGeneration(current) !== folderGeneration(incoming))
        throw Error("Folder checkpoint requires explicit agreement");
      const doc = current
        ? A.merge(A.clone(current), A.clone(incoming))
        : incoming;
      if (current && equalHeads(A.getHeads(doc), A.getHeads(current))) return;
      await this.materializeFolder(path, doc, prior);
    });
  }
  private async materializeFolder(
    path: string,
    doc: A.Doc<FolderDocument>,
    prior?: CompanionDescriptor,
  ) {
    const descriptor: CompanionDescriptor = {
      ...prior,
      format: "saddle-companion/1",
      id: doc.id,
      kind: "folder",
      features: { ...doc.features },
      namedKeys: [...doc.namedKeys],
    };
    parseCompanion(utf8.encode(JSON.stringify(descriptor)));
    if (path && !this.directories().includes(path)) {
      await this.fs.mkdir?.(path);
      this.folders.push(path);
    }
    await this.saveFolder(path, doc);
    await this.companions.describe(path, descriptor);
    if (doc.resource)
      await this.companions.write(
        path,
        resourceName,
        utf8.encode(serializeResource(A.toJS(doc).resource!)),
      );
    else await this.companions.remove(path, resourceName);
    await this.discoverCompanions();
    this.folderDocuments.set(path, doc);
    this.notify();
  }
  async ensureUnit(path: string, kind: "file" | "folder") {
    const prior = await this.companions.descriptor(path);
    if (prior && prior.kind !== kind) throw Error("Unit kind mismatch");
    const id =
      prior?.id ??
      (kind === "file" ? this.find(path)?.id : undefined) ??
      crypto.randomUUID();
    await this.companions.describe(path, {
      ...prior,
      format: "saddle-companion/1",
      id,
      kind,
      features: prior?.features ?? {},
    });
    this.unitLocations.set(id, path);
    return { id, kind };
  }
  rememberScope(id: string, path: string) {
    this.scopeLocations.set(id, path);
  }
  private discoverScopes(path: string, descriptor: CompanionDescriptor) {
    if (descriptor.retention)
      this.protectedHistory.set(descriptor.id, {
        path,
        kind: descriptor.kind,
        reference: descriptor.retention,
      });
    for (const [id, url] of Object.entries(descriptor.shares ?? {})) {
      documentId(id);
      if (typeof url !== "string")
        throw Error("Invalid companion share reference");
      if (this.scopeLocations.has(id) && this.scopeLocations.get(id) !== path)
        throw Error("A share has multiple companion locations");
      this.scopeLocations.set(id, path);
    }
  }
  scopePath(id: string, fallback: string) {
    return this.scopeLocations.get(id) ?? fallback;
  }
  /** References discovered through this filesystem capability, never ancestors. */
  async scopeCompanions() {
    const result: Array<{
      id: string;
      url: string;
      path: string;
      unit: { id: string; kind: "file" | "folder" };
    }> = [];
    const descriptors = new Map<string, CompanionDescriptor | undefined>();
    for (const [id, path] of this.scopeLocations) {
      if (!descriptors.has(path))
        descriptors.set(path, await this.companions.descriptor(path));
      const descriptor = descriptors.get(path);
      const url = descriptor?.shares?.[id];
      if (descriptor && url)
        result.push({
          id,
          url,
          path,
          unit: { id: descriptor.id, kind: descriptor.kind },
        });
    }
    return result;
  }
  private relocateScopes(from: string, to: string) {
    for (const [id, path] of this.unitLocations)
      if (path === from || path.startsWith(from + "/"))
        this.unitLocations.set(id, to + path.slice(from.length));
    for (const [path, doc] of [...this.folderDocuments])
      if (path === from || path.startsWith(from + "/")) {
        this.folderDocuments.delete(path);
        this.folderStamps.delete(path);
        this.folderDocuments.set(to + path.slice(from.length), doc);
      }
    for (const [id, path] of this.scopeLocations)
      if (path === from || path.startsWith(from + "/"))
        this.scopeLocations.set(id, to + path.slice(from.length));
  }
  archivePath(id: string) {
    const entry = this.entry(id);
    return entry.storage ?? entry.path;
  }
  private async describeFile(id: string, path = this.archivePath(id)) {
    const prior = await this.companions.descriptor(path);
    if (prior && prior.id !== id)
      throw Error("Companion belongs to another file");
    const state = this.state.files[id];
    // A portable checkpoint belongs to this file, never to the folder used to open it.
    const materialized = state
      ? {
          heads: [...state.heads],
          epoch: state.epoch,
          hash: state.hash,
          deleted: state.deleted,
          path: this.entry(id).path.split("/").at(-1)!,
          sidecar: state.sidecar
            ? { path: resourceName, hash: state.sidecar.hash }
            : null,
        }
      : prior?.materialized;
    await this.companions.updateDescriptor(path, (latest) => ({
      ...latest,
      format: "saddle-companion/1",
      id,
      kind: "file",
      features: { ...(this.manifest.scopes.files[id] ?? {}) },
      ...(materialized
        ? {
            materialized: {
              ...materialized,
              path: this.entry(id).path.split("/").at(-1)!,
            },
          }
        : {}),
    }));
    this.unitLocations.set(id, path);
    const stat = await this.fs.stat?.(companionPath(path));
    if (stat) this.inventory.set(stat.path, stat);
  }
  private async refreshDocumentStorage(remove?: ReadonlySet<string>) {
    await this.persistVaultSettings();
    await this.collectFolderSnapshots();
    for (const [id, doc] of this.docs) {
      const path = this.archivePath(id);
      if (
        this.unloaded.has(id) &&
        needsDocument(this.features(id)) &&
        this.persistedDocuments.has(id)
      )
        continue;
      if (
        needsDocument(this.features(id)) ||
        this.protectedHistory.has(id) ||
        (!this.unloaded.has(id) && hasDistinctConflicts(doc))
      ) {
        await this.loadDocument(id);
        const doc = this.doc(id);
        const revision = A.getHeads(doc).sort().join();
        if (this.persistedDocuments.get(id) !== revision) {
          await this.describeFile(id);
          await this.companions.saveDocument(path, contentName, doc);
          this.persistedDocuments.set(id, revision);
        }
      } else if (remove?.has(id) && this.persistedDocuments.has(id)) {
        await this.companions.remove(path, contentName);
        this.persistedDocuments.delete(id);
        await this.companions.cleanup(path);
        if (
          !this.entry(id).deleted &&
          (await this.companions.descriptor(path))
        ) {
          const baseline =
            (await this.local.read(`baselines/${id}.bin`)) ??
            (await this.fs.read(this.entry(id).path));
          if (baseline)
            await this.companions.write(path, "baseline.bin", baseline);
        }
      }
    }
  }
  configureScope(
    kind: "vault" | "folder" | "file",
    target: string,
    policy: FeatureOverrides,
  ) {
    if (kind === "folder") filePath(target);
    if (kind === "file") documentId(target);
    return this.write(async () => {
      if ([...this.drafts].some((draft) => draft.dirty))
        throw Error("Save or discard edits before changing history or sharing");
      const next = A.change(A.clone(this.manifest), (d) => {
        const apply = (target: FeatureOverrides) => {
          for (const [key, value] of Object.entries(policy)) {
            if (value === undefined)
              delete target[key as keyof FeatureOverrides];
            else target[key as keyof FeatureOverrides] = value;
          }
        };
        if (kind === "vault") apply(d.scopes.vault);
        else {
          const settings =
            kind === "folder" ? d.scopes.folders : d.scopes.files;
          settings[target] ??= {};
          apply(settings[target]);
        }
        d.policy = { ...this.inherited, ...d.scopes.vault };
        if (policy.sync) d.coordinated = true;
      });
      await this.persistManifest(next);
      if (
        kind === "file" &&
        this.manifest.files[target] &&
        (Object.keys(policy).some(
          (key) => policy[key as keyof FeatureOverrides] !== undefined,
        ) ||
          (await this.companions.descriptor(this.archivePath(target))))
      )
        await this.describeFile(target);
      for (const [id, doc] of this.docs) {
        if (
          (kind === "file" && id !== target) ||
          (kind === "folder" && !this.entry(id).path.startsWith(target + "/"))
        )
          continue;
        const features = this.features(id);
        if (
          this.unloaded.has(id) &&
          (features.history ||
            features.sync ||
            Object.hasOwn(policy, "history"))
        )
          await this.loadDocument(id);
        const currentDoc = this.docs.get(id)!;
        if (
          Object.hasOwn(policy, "history") &&
          !features.history &&
          currentDoc.retainHistory !== false
        ) {
          await this.persistDoc(
            A.change(
              A.clone(currentDoc),
              { message: "Disable history" },
              (value) => {
                value.retainHistory = false;
              },
            ),
          );
          if (this.state.files[id]) await this.materialize(id);
        } else if (features.history && currentDoc.retainHistory !== true) {
          await this.persistDoc(
            A.change(
              A.clone(currentDoc),
              { message: "Enable history" },
              (value) => {
                value.retainHistory = true;
              },
            ),
          );
          if (this.state.files[id]) await this.materialize(id);
        }
      }
      if (Object.hasOwn(policy, "history"))
        await this.markFolderHistory(
          (path) =>
            kind === "vault" ||
            (kind === "folder" &&
              (path === target || path.startsWith(target + "/"))),
        );
      await this.refreshDocumentStorage(
        new Set(
          [...this.docs.keys()].filter(
            (id) =>
              kind === "vault" ||
              (kind === "file"
                ? id === target
                : this.entry(id).path.startsWith(target + "/")),
          ),
        ),
      );
      if (kind !== "file")
        await this.pruneFolderStorage(
          (path) =>
            kind === "vault" ||
            path === target ||
            path.startsWith(target + "/"),
        );
      for (const [id, doc] of this.docs)
        if (
          !this.historyEnabled(id) &&
          !this.syncEnabled(id) &&
          !this.persistedDocuments.has(id) &&
          ![...this.drafts].some((draft) => draft.fileId === id)
        ) {
          this.docs.set(id, A.from(A.toJS(doc)));
          const checkpoint = this.state.files[id];
          if (checkpoint && !this.unloaded.has(id))
            checkpoint.heads = A.getHeads(this.doc(id));
        }
      if (kind === "file" && this.manifest.files[target])
        await this.companions.cleanup(this.archivePath(target));
      await this.cleanHistory();
      await this.checkpoint();
      this.notify();
    });
  }
  get namedPaths() {
    return this.manifest.namedPaths;
  }
  get templates() {
    return this.manifest.templates;
  }
  setNamedPath(key: string, path: string, kind: "file" | "folder") {
    if (!/^[a-z][a-z0-9.-]*$/.test(key)) throw Error("Invalid named path key");
    path = path.replace(/^\//, "");
    if (path) filePath(path);
    if (kind === "file")
      return this.updateFileDeclaration(path, (resource) => {
        resource.saddle ??= {};
        const keys = Array.isArray(resource.saddle.namedKeys)
          ? resource.saddle.namedKeys
          : [];
        resource.saddle.namedKeys = [...new Set([...keys, key])];
      });
    return this.write(async () => {
      if (kind === "folder" && path && !this.directories().includes(path))
        throw Error("Named folder does not exist");
      const prior = await this.companions.descriptor(path);
      await this.companions.describe(path, {
        ...prior,
        format: "saddle-companion/1",
        id: prior?.id ?? crypto.randomUUID(),
        kind,
        features: prior?.features ?? {},
        namedKeys: [...new Set([...(prior?.namedKeys ?? []), key])],
      });
      await this.discoverCompanions();
      await this.persistVaultSettings();
      await this.collectFolderSnapshots(path);
      this.notify();
    });
  }
  private async updateFileDeclaration(
    path: string,
    change: (resource: DataResource) => void,
  ) {
    const file = this.find(path);
    if (!file) throw Error("File does not exist");
    await this.load(file.id);
    const draft = this.draft(file.id);
    if (draft.invalidResource)
      throw Error("Fix the sidecar metadata before changing declarations");
    draft.resource ??= newResource(path);
    change(draft.resource);
    const saved = await this.save(draft);
    this.release(saved);
    await this.write(async () => {
      await this.discoverCompanions();
      await this.persistVaultSettings();
      await this.collectFolderSnapshots();
      this.notify();
    });
  }
  setTemplate(path: string, name: string, enabled = true) {
    return this.updateFileDeclaration(path, (resource) => {
      resource.saddle ??= {};
      resource.saddle.templateDefinition = { name, enabled };
    });
  }
  removeTemplate(path: string) {
    return this.updateFileDeclaration(path, (resource) => {
      if (resource.saddle) delete resource.saddle.templateDefinition;
    });
  }
  metadata(id: string) {
    if (this.unloaded.has(id) && this.cachedMetadata.has(id))
      return this.cachedMetadata.get(id)!;
    const doc = this.docs.get(id)!,
      path = this.entry(id).path;
    const cached = this.metadataCache.get(doc);
    if (cached?.path === path) {
      if (cached.error) this.metadataErrors.set(id, cached.error);
      else this.metadataErrors.clear(id);
      return cached.value;
    }
    try {
      if (doc.invalidResource !== null) parseResource(doc.invalidResource);
      const value = importMetadata(
        this.entry(id).path,
        doc.mime,
        fileText(doc),
        doc.resource,
      );
      this.metadataErrors.clear(id);
      this.metadataCache.set(doc, { path, value });
      return value;
    } catch (error) {
      this.metadataErrors.set(id, error);
      const value: FileMetadata = {
        resource: null,
        properties: {},
        links: [],
        terms: [],
        contentType: null,
      };
      this.metadataCache.set(doc, {
        path,
        value,
        error: error instanceof Error ? error.message : String(error),
      });
      return value;
    }
  }
  contentType(id: string) {
    return this.metadata(id).contentType;
  }
  async recheckMetadata(id: string) {
    await this.load(id);
    this.metadataErrors.clear(id);
    this.metadataCache.delete(this.doc(id));
    await this.reconcile();
    this.metadata(id);
    await this.persistMetadataErrors();
    this.notify();
  }
  private async persistMetadataErrors() {
    const value = JSON.stringify([...this.metadataErrors.entries.values()]);
    if (value === this.diagnosticsPersisted) return;
    await this.local.writeAtomic("metadata-errors.json", utf8.encode(value));
    this.diagnosticsPersisted = value;
  }
  setFileHistory(id: string, enabled: boolean) {
    return this.configureScope("file", id, { history: enabled });
  }
  directories() {
    return [
      ...new Set([
        ...this.folders,
        ...this.list().flatMap((f) => {
          const parts = f.path.split("/");
          return parts
            .slice(0, -1)
            .map((_, i) => parts.slice(0, i + 1).join("/"));
        }),
      ]),
    ].sort();
  }
  async createFolder(path: string) {
    filePath(path);
    if (!this.fs.mkdir)
      throw Error("Folder creation is unavailable on this platform");
    return this.write(async () => {
      await this.fs.mkdir!(path);
      this.folders = (await this.fs.directories?.()) ?? [...this.folders, path];
      this.notify();
    });
  }
  async removeFolder(path: string) {
    filePath(path);
    if (!this.fs.removeDirectory)
      throw Error("Folder deletion is unavailable on this platform");
    for (const f of this.list().filter((f) => f.path.startsWith(path + "/"))) {
      if (this.hasDirtyDraft(f.id))
        throw Error("Save or discard folder drafts first");
    }
    for (const f of this.list().filter((f) => f.path.startsWith(path + "/")))
      await this.remove(f.id);
    // Retained units remain separate sibling containers, independently discoverable.
    const parent = path.split("/").slice(0, -1).join("/");
    const retain = async (source: string, descriptor: CompanionDescriptor) => {
      const owner = [parent, "deleted-" + descriptor.id]
        .filter(Boolean)
        .join("/");
      descriptor.deleted = true;
      descriptor.deletedPath = source.slice(parent ? parent.length + 1 : 0);
      await this.companions.describe(source, descriptor);
      await this.companions.move(source, owner);
      return owner;
    };
    for (const entry of Object.values(this.manifest.files).filter((e) =>
      e.path.startsWith(path + "/"),
    )) {
      const source = this.archivePath(entry.id),
        descriptor = await this.companions.descriptor(source);
      if (!descriptor) continue;
      const owner = await retain(source, descriptor);
      this.manifest = A.change(A.clone(this.manifest), (d) => {
        d.files[entry.id].storage = owner;
      });
    }
    const nested = this.fs.scan
      ? (await this.fs.scan(path)).filter((e) => e.kind === "companion")
      : [];
    for (const item of nested) {
      const owner = companionOwner(item.path),
        descriptor = await this.companions.descriptor(owner);
      if (descriptor) await retain(owner, descriptor);
    }
    const own = await this.companions.descriptor(path);
    if (own) {
      own.deleted = true;
      await this.companions.describe(path, own);
    }
    await this.persistVaultSettings();
    await this.fs.removeDirectory(path);
    this.folders = this.folders.filter(
      (f) => f !== path && !f.startsWith(path + "/"),
    );
    this.notify();
  }
  async moveFolder(from: string, to: string) {
    filePath(from);
    filePath(to);
    if (to === from || to.startsWith(from + "/"))
      throw Error("Choose a different destination outside this folder");
    if (!this.fs.move)
      throw Error("Folder moves are unavailable on this platform");
    return this.write(async () => {
      if (
        this.directories().includes(to) ||
        this.find(to) ||
        (await this.fs.stat?.(to))
      )
        throw Error("Destination already exists");
      const journal = `moves/${crypto.randomUUID()}.json`;
      await this.local.writeAtomic(
        journal,
        utf8.encode(JSON.stringify({ id: this.id, from, to, folder: true })),
      );
      await this.fs.move!(from, to);
      await this.companions.move(from, to);
      this.relocateScopes(from, to);
      await this.persistManifest(
        A.change(A.clone(this.manifest), (d) => {
          for (const entry of Object.values(d.files))
            if (entry.path.startsWith(from + "/")) {
              entry.path = to + entry.path.slice(from.length);
              if (entry.storage?.startsWith(from + "/"))
                entry.storage = to + entry.storage.slice(from.length);
            }
          for (const path of Object.keys(d.scopes.folders))
            if (path === from || path.startsWith(from + "/")) {
              d.scopes.folders[to + path.slice(from.length)] = {
                ...d.scopes.folders[path],
              };
              delete d.scopes.folders[path];
            }
          for (const value of Object.values(d.namedPaths))
            if (value.path === from || value.path.startsWith(from + "/"))
              value.path = to + value.path.slice(from.length);
          for (const path of Object.keys(d.templates))
            if (path.startsWith(from + "/")) {
              const name = to + path.slice(from.length);
              d.templates[name] = { ...d.templates[path], path: name };
              delete d.templates[path];
            }
        }),
      );
      const changed: string[] = [];
      for (const [id, checkpoint] of Object.entries(this.state.files))
        if (checkpoint.path.startsWith(from + "/")) {
          checkpoint.path = to + checkpoint.path.slice(from.length);
          if (checkpoint.sidecar?.path.startsWith(from + "/"))
            checkpoint.sidecar.path =
              to + checkpoint.sidecar.path.slice(from.length);
          const stat = await this.fs.stat?.(checkpoint.path);
          checkpoint.stamp = stat?.stamp;
          if (stat) this.inventory.set(stat.path, stat);
          if (await this.companions.descriptor(this.archivePath(id)))
            await this.describeFile(id);
          changed.push(id);
        }
      this.folders = this.folders.map((path) =>
        path === from || path.startsWith(from + "/")
          ? to + path.slice(from.length)
          : path,
      );
      if (this.fs.scan)
        this.inventory = new Map(
          (await this.fs.scan()).map((entry) => [entry.path, entry]),
        );
      await this.checkpoint(changed);
      await this.local.remove(journal);
      this.notify();
    });
  }
  get policy(): VaultPolicy {
    return { ...this.inherited, ...this.manifest.scopes.vault };
  }
  get syncActive() {
    return (
      this.policy.sync ||
      Object.values(this.manifest.scopes.folders).some((p) => p.sync) ||
      Object.values(this.manifest.scopes.files).some((p) => p.sync)
    );
  }
  flush() {
    return this.queue.then(() => {});
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private notify() {
    this.listeners.forEach((fn) => fn());
  }
  private write<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }
  private validateDocument(doc: FileDocument, id: string) {
    if (
      (doc.retainHistory !== undefined &&
        typeof doc.retainHistory !== "boolean") ||
      doc.format !== "saddle-file/1" ||
      doc.id !== id ||
      !Number.isSafeInteger(doc.epoch) ||
      doc.epoch < 0 ||
      !["text", "binary"].includes(doc.kind) ||
      typeof doc.text !== "string" ||
      !(doc.bytes instanceof Uint8Array) ||
      typeof doc.mime !== "string" ||
      !/^[\w.+-]+\/[\w.+-]+$/.test(doc.mime) ||
      Object.hasOwn(doc, "contentType") ||
      !(doc.resource === null || typeof doc.resource === "object") ||
      !(doc.invalidResource === null || typeof doc.invalidResource === "string")
    )
      throw Error("Invalid file document");
  }
  list(): FileSummary[] {
    return Object.values(this.manifest.files)
      .filter((e) => !e.deleted)
      .map((entry) => {
        const doc = this.docs.get(entry.id)!;
        return {
          ...entry,
          mime: doc.mime,
          kind: doc.kind,
          contentType: this.contentType(entry.id),
          ...(this.metadataErrors.entries.has(entry.id)
            ? {
                metadataError: this.metadataErrors.entries.get(entry.id)!
                  .message,
              }
            : {}),
          epoch: doc.epoch,
        };
      })
      .sort((a, b) => a.path.localeCompare(b.path));
  }
  hasEntry(id: string) {
    return Object.hasOwn(this.manifest.files, documentId(id));
  }
  entry(id: string): FileEntry {
    const entry = this.manifest.files[documentId(id)];
    if (!entry) throw Error("Unknown vault file");
    return entry;
  }
  deletedFiles(): FileEntry[] {
    return Object.values(this.manifest.files).filter(
      (entry) => entry.deleted && this.historyEnabled(entry.id),
    );
  }
  doc(id: string): A.Doc<FileDocument> {
    const doc = this.docs.get(documentId(id));
    if (!doc) throw Error("Unknown vault file");
    if (this.unloaded.has(id))
      throw Error("Load this file before accessing its contents");
    return doc;
  }
  find(path: string) {
    return this.list().find((e) => e.path === filePath(path));
  }
  draft(id: string) {
    if (this.entry(id).deleted) throw Error("This file was deleted");
    const draft = new Draft(id, A.clone(this.doc(id)), this.entry(id).path);
    this.drafts.add(draft);
    return draft;
  }
  release(draft: Draft) {
    this.drafts.delete(draft);
  }
  hasDirtyDraft(id: string) {
    return [...this.drafts].some((d) => d.fileId === id && d.dirty);
  }
  getFreeze(id: string) {
    return this.frozen[id];
  }
  private async persistRetention() {
    await this.local.writeAtomic(
      `retention-${this.computer}.json`,
      utf8.encode(JSON.stringify(this.frozen)),
    );
  }
  freezeHistory(
    id: string,
    token: string,
    heads: A.Heads,
    rewrite?: HistoryRewrite,
  ) {
    return this.write(async () => {
      const frozen = this.frozen[id];
      if (
        frozen?.token === token &&
        frozen.epoch === this.doc(id).epoch &&
        equalHeads(frozen.heads, heads) &&
        equalHeads(A.getHeads(this.doc(id)), heads)
      )
        return true;
      if (
        (!rewrite &&
          (this.historyEnabled(id) || this.doc(id).retainHistory === true)) ||
        hasDistinctConflicts(this.doc(id)) ||
        this.hasDirtyDraft(id) ||
        !equalHeads(A.getHeads(this.doc(id)), heads)
      )
        return false;
      const checkpoint = this.state.files[id],
        actual = checkpoint && (await this.fs.read(checkpoint.path));
      if (!checkpoint || !actual || (await digest(actual)) !== checkpoint.hash)
        return false;
      if (this.frozen[id] && this.frozen[id].token !== token) return false;
      this.frozen[id] = {
        token,
        heads,
        epoch: this.doc(id).epoch,
        ...(rewrite ? { rewrite } : {}),
      };
      await this.persistRetention();
      this.notify();
      return true;
    });
  }
  unfreezeHistory(id: string, token: string) {
    return this.write(async () => {
      if (this.frozen[id]?.token === token) {
        delete this.frozen[id];
        await this.persistRetention();
        this.notify();
      }
    });
  }
  private async persistManifest(next: A.Doc<VaultManifest>) {
    if (equalHeads(A.getHeads(next), A.getHeads(this.manifest))) return;
    const paths = new Set<string>();
    for (const entry of Object.values(next.files)) {
      filePath(entry.path);
      documentId(entry.id);
      if (!entry.deleted && paths.has(entry.path))
        throw Error(`Concurrent path conflict: ${entry.path}`);
      if (!entry.deleted) paths.add(entry.path);
    }
    const previous = this.manifest;
    this.manifest = next;
    try {
      await this.persistVaultSettings();
    } catch (error) {
      this.manifest = previous;
      throw error;
    }
    this.revision++;
  }
  private async persistDoc(next: A.Doc<FileDocument>, path?: string) {
    this.validateDocument(next, next.id);
    const previous = this.docs.get(next.id);
    if (previous && equalHeads(A.getHeads(next), A.getHeads(previous))) return;
    const target = path ?? this.manifest.files[next.id]?.path;
    const features = target
      ? effectiveFeatures(this.manifest.scopes, this.inherited, target, next.id)
      : noFeatures;
    if (
      (needsDocument(features) ||
        this.protectedHistory.has(next.id) ||
        hasDistinctConflicts(next)) &&
      target
    ) {
      await this.describeFile(
        next.id,
        path ?? this.manifest.files[next.id]?.storage ?? target,
      );
      await this.companions.saveDocument(
        path ?? this.manifest.files[next.id]?.storage ?? target,
        contentName,
        next,
      );
      this.persistedDocuments.set(next.id, A.getHeads(next).sort().join());
    } else {
      await this.local.writeAtomic(
        `pending/${next.id}.automerge`,
        A.save(next),
      );
      if (
        target &&
        this.persistedDocuments.has(next.id) &&
        previous &&
        hasDistinctConflicts(previous)
      ) {
        const location =
          path ?? this.manifest.files[next.id]?.storage ?? target;
        await this.companions.remove(location, contentName);
        this.persistedDocuments.delete(next.id);
        await this.companions.cleanup(location);
      }
    }
    this.unloaded.delete(next.id);
    this.cachedMetadata.delete(next.id);
    this.docs.set(next.id, next);
    this.revision++;
  }
  private async checkpoint(ids = Object.keys(this.state.files)) {
    for (const id of ids)
      if (this.state.files[id])
        await this.local.writeAtomic(
          `materialized/${this.computer}/${documentId(id)}.json`,
          utf8.encode(JSON.stringify(this.state.files[id])),
        );
  }
  private async materialize(id: string) {
    const entry = this.entry(id),
      doc = this.doc(id),
      previous = this.state.files[id];
    const bytes = fileBytes(doc);
    // Refuse to overwrite another document after a path conflict or interrupted move.
    if (previous && previous.path !== entry.path) {
      const existing = await this.fs.read(entry.path);
      if (existing && (await digest(existing)) !== (await digest(bytes)))
        throw Error(`Move target already exists: ${entry.path}`);
    }
    if (!entry.deleted) {
      const existing = await this.fs.read(entry.path);
      if (!existing || (await digest(existing)) !== (await digest(bytes)))
        await this.fs.writeAtomic(entry.path, bytes);
    }
    const resourcePath = sidecarPath(this.archivePath(id)) + "/" + resourceName;
    const resourceBytes =
      doc.invalidResource !== null
        ? utf8.encode(doc.invalidResource)
        : doc.resource
          ? utf8.encode(serializeResource(A.toJS(doc).resource!))
          : null;
    if (resourceBytes) {
      await this.describeFile(id);
      await this.companions.write(
        this.archivePath(id),
        resourceName,
        resourceBytes,
      );
    } else {
      await this.companions.remove(this.archivePath(id), resourceName);
    }
    if (previous && (entry.deleted || previous.path !== entry.path)) {
      const old = await this.fs.read(previous.path);
      if (
        old &&
        (await digest(old)) === previous.hash &&
        !this.list().some((e) => e.id !== id && e.path === previous.path)
      )
        await this.fs.remove(previous.path);
    }
    const stat = await this.fs.stat?.(entry.path);
    if (stat) this.inventory.set(entry.path, stat);
    const next = {
      path: entry.path,
      heads: A.getHeads(doc),
      epoch: doc.epoch,
      hash: await digest(bytes),
      deleted: entry.deleted,
      stamp: stat?.stamp,
      sidecar:
        !entry.deleted && resourceBytes
          ? { path: resourcePath, hash: await digest(resourceBytes) }
          : null,
    };
    if (
      previous &&
      previous.path === next.path &&
      previous.epoch === next.epoch &&
      previous.hash === next.hash &&
      previous.deleted === next.deleted &&
      equalHeads(previous.heads, next.heads) &&
      canonical(previous.sidecar ?? null) === canonical(next.sidecar)
    ) {
      await this.local.remove(`pending/${id}.automerge`);
      return;
    }
    const declarations = A.toJS(doc).resource?.saddle;
    this.manifest = A.change(A.clone(this.manifest), (value) => {
      for (const [key, declaration] of Object.entries(value.namedPaths))
        if (declaration.id === id) delete value.namedPaths[key];
      if (previous) delete value.templates[previous.path];
      delete value.templates[entry.path];
      if (!entry.deleted) {
        for (const key of Array.isArray(declarations?.namedKeys)
          ? declarations.namedKeys
          : [])
          if (typeof key === "string")
            value.namedPaths[id + ":" + key] = {
              id,
              key,
              path: entry.path,
              kind: "file",
            };
        const template = declarations?.templateDefinition;
        if (
          template &&
          typeof template === "object" &&
          !Array.isArray(template) &&
          typeof template.name === "string" &&
          typeof template.enabled === "boolean"
        )
          value.templates[entry.path] = {
            path: entry.path,
            name: template.name,
            enabled: template.enabled,
          };
      }
    });
    const prior = this.state;
    this.state = { ...prior, files: { ...prior.files, [id]: next } };
    try {
      if (!previous || previous.hash !== next.hash)
        await this.local.writeAtomic(`baselines/${id}.bin`, bytes);
      if (
        needsDocument(this.features(id)) ||
        resourceBytes ||
        Object.keys(this.manifest.scopes.files[id] ?? {}).length ||
        (await this.companions.descriptor(this.archivePath(id)))
      ) {
        await this.describeFile(id);
        if (!this.persistedDocuments.has(id))
          await this.companions.write(
            this.archivePath(id),
            "baseline.bin",
            bytes,
          );
        else await this.companions.remove(this.archivePath(id), "baseline.bin");
      }
      if (!this.batching) await this.checkpoint([id]);
      if (!this.batching) await this.local.remove(`pending/${id}.automerge`);
    } catch (error) {
      this.state = prior;
      throw error;
    }
  }
  async create(
    path: string,
    bytes = utf8.encode(""),
    options: {
      mime?: string;
      contentType?: string | null;
      resource?: DataResource | null;
      invalidResource?: string | null;
    } = {},
  ) {
    return this.write(async () => {
      filePath(path);
      if (isSidecar(path))
        throw Error(
          "A sidecar belongs to its main file; edit that file's resource metadata",
        );
      if (this.find(path) || (await this.fs.read(path)))
        throw Error(`File already exists: ${path}`);
      const id = await this.importFile(path, bytes, options);
      await this.materialize(id);
      this.notify();
      return id;
    });
  }
  private async sidecarCheckpoint(path: string) {
    if (this.fs.scan && !this.inventory.has(sidecarPath(path))) return null;
    const value = await this.companions.read(path, resourceName);
    return value
      ? {
          path: sidecarPath(path) + "/" + resourceName,
          hash: await digest(value),
        }
      : null;
  }
  private async readPlainDocument(
    id: string,
    path: string,
    bytes: Uint8Array,
    options: {
      mime?: string;
      contentType?: string | null;
      resource?: DataResource | null;
      invalidResource?: string | null;
    } = {},
  ) {
    const mime = options.mime ?? mimeType(path);
    let kind: "text" | "binary" = textMime(mime) ? "text" : "binary";
    let value = "";
    if (kind === "text")
      try {
        value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        kind = "binary";
      }
    let csdb = null;
    if (mime === "application/vnd.csdb")
      try {
        csdb = csdbState(value);
      } catch {}
    let resource: DataResource | null = null,
      invalidResource: string | null = null;
    const descriptor =
      this.fs.scan && !this.inventory.has(sidecarPath(path))
        ? undefined
        : await this.companions.read(path, resourceName);
    if (descriptor) {
      const source = text.decode(descriptor);
      try {
        resource = parseResource(source);
      } catch {
        invalidResource = source;
      }
    }
    if (options.resource !== undefined)
      resource = options.resource ? structuredClone(options.resource) : null;
    if (options.invalidResource !== undefined)
      invalidResource = options.invalidResource;
    if (options.contentType !== undefined) {
      if (invalidResource)
        throw Error("Fix the sidecar before changing its content type");
      resource = setResourceContentType(resource, path, options.contentType);
    }
    return A.from<FileDocument>({
      format: "saddle-file/1",
      id,
      epoch: 0,
      generation: crypto.randomUUID(),
      mime,
      resource,
      invalidResource,
      kind,
      text: csdb ? "" : value,
      csdb,
      bytes: kind === "binary" ? new Uint8Array(bytes) : new Uint8Array(),
      ...(effectiveFeatures(this.manifest.scopes, this.inherited, path, id)
        .history
        ? { retainHistory: true }
        : {}),
      template:
        resource?.saddle?.template &&
        typeof resource.saddle.template === "object" &&
        !Array.isArray(resource.saddle.template) &&
        typeof resource.saddle.template.file === "string" &&
        typeof resource.saddle.template.baseline === "string"
          ? (resource.saddle.template as unknown as TemplateReference)
          : null,
    });
  }
  private async importFile(
    path: string,
    bytes: Uint8Array,
    options: {
      mime?: string;
      contentType?: string | null;
      resource?: DataResource | null;
      invalidResource?: string | null;
    } = {},
  ) {
    let descriptor = await this.companions.descriptor(path);
    if (descriptor?.materialized?.deleted) {
      const owner = path + ".deleted-" + descriptor.id;
      await this.companions.move(path, owner);
      if (this.manifest.files[descriptor.id])
        await this.persistManifest(
          A.change(A.clone(this.manifest), (d) => {
            d.files[descriptor!.id].storage = owner;
          }),
        );
      descriptor = undefined;
    }
    const id = descriptor?.id ?? crypto.randomUUID();
    await this.persistDoc(
      await this.readPlainDocument(id, path, bytes, options),
      path,
    );
    await this.persistManifest(
      A.change(A.clone(this.manifest), (d) => {
        d.files[id] = { id, path, deleted: false };
      }),
    );
    return id;
  }
  private applyDraft(
    draft: Draft,
    baseline: A.Doc<FileDocument>,
    message = "Save file",
  ) {
    const csdb =
      draft.mime === "application/vnd.csdb"
        ? csdbState(draft.text, baseline.csdb)
        : null;
    return A.change(
      A.clone(baseline),
      { message, time: Math.floor(Date.now() / 1000) },
      (d) => {
        if (csdb) {
          if (d.csdb) updateCSDB(d.csdb, csdb);
          else d.csdb = csdb;
          if (d.text) A.updateText(d, ["text"], "");
        } else {
          if (d.csdb) d.csdb = null;
          if (d.text !== draft.text) A.updateText(d, ["text"], draft.text);
        }
        if (
          d.bytes.length !== draft.bytes.length ||
          d.bytes.some((b, i) => b !== draft.bytes[i])
        )
          d.bytes = new Uint8Array(draft.bytes);
        if (d.mime !== draft.mime) d.mime = draft.mime;
        if (canonical(d.resource) !== canonical(draft.resource)) {
          if (d.resource && draft.resource)
            patchSettings(
              d.resource as Record<string, unknown>,
              draft.resource as Record<string, unknown>,
            );
          else
            d.resource = draft.resource
              ? structuredClone(draft.resource)
              : null;
        }
        if (d.invalidResource !== draft.invalidResource)
          d.invalidResource = draft.invalidResource;
        if (canonical(d.template) !== canonical(draft.template))
          d.template = draft.template ? structuredClone(draft.template) : null;
      },
    );
  }
  save(draft: Draft, description = "", selection?: CSDBRowSelection) {
    const message = historyMessage("Save file", description);
    return this.write(async () => {
      if (description.trim() && !this.historyEnabled(draft.fileId))
        throw Error("Enable history before saving a version description");
      if (this.entry(draft.fileId).deleted)
        throw Error("File was deleted. Save your draft as a new file.");
      const current = this.doc(draft.fileId);
      if (this.frozen[draft.fileId])
        throw Error(
          "A history checkpoint is in progress. Your draft is preserved; retry Save after it completes.",
        );
      if (
        draft.original.id !== current.id ||
        draft.original.generation !== current.generation
      )
        throw Error(
          "History checkpoint changed. Save this draft as a new file to preserve offline edits.",
        );
      // Capture the submitted value. An editor may continue typing during disk I/O.
      const submitted = new Draft(
        draft.fileId,
        A.clone(draft.original),
        this.entry(draft.fileId).path,
      );
      submitted.text = draft.text;
      if (selection) {
        if (
          draft.mime !== "application/vnd.csdb" ||
          (!selection.ids.length && !selection.metadata)
        )
          throw Error("Choose tasks to save");
        submitted.text = selectedCSDBRows(
          fileText(draft.original),
          draft.text,
          selection,
        );
      }
      submitted.bytes = new Uint8Array(draft.bytes);
      if (!selection || selection.metadata) {
        submitted.mime = draft.mime;
        submitted.resource = draft.resource
          ? structuredClone(draft.resource)
          : null;
        submitted.invalidResource = draft.invalidResource;
        submitted.template = draft.template
          ? structuredClone(draft.template)
          : null;
      }
      let edited = this.applyDraft(submitted, draft.original, message);
      if (
        description.trim() &&
        equalHeads(A.getHeads(edited), A.getHeads(draft.original))
      )
        edited = A.emptyChange(A.clone(edited), { message });
      const next = A.merge(A.clone(current), edited);
      await this.persistDoc(next);
      await this.materialize(draft.fileId);
      this.metadata(draft.fileId);
      await this.persistMetadataErrors();
      this.release(draft);
      const ongoing = new Draft(
        draft.fileId,
        A.clone(edited),
        this.entry(draft.fileId).path,
      );
      ongoing.text = draft.text;
      ongoing.bytes = new Uint8Array(draft.bytes);
      ongoing.mime = draft.mime;
      ongoing.resource = draft.resource
        ? structuredClone(draft.resource)
        : null;
      ongoing.invalidResource = draft.invalidResource;
      ongoing.template = draft.template
        ? structuredClone(draft.template)
        : null;
      this.notify();
      if (ongoing.dirty) {
        this.drafts.add(ongoing);
        return ongoing;
      }
      return this.draft(draft.fileId);
    });
  }
  compactLocal(id: string) {
    return this.write(async () => {
      if (this.unloaded.has(id)) return;
      if (
        !this.historyEnabled(id) &&
        !this.protectedHistory.has(id) &&
        ![...this.drafts].some((d) => d.fileId === id) &&
        A.stats(this.doc(id)).numChanges > 1
      ) {
        await this.prune(id);
        this.notify();
      }
    });
  }
  move(id: string, path: string) {
    return this.write(async () => {
      filePath(path);
      if (
        this.find(path)?.id !== id &&
        (this.find(path) || (await this.fs.read(path)))
      )
        throw Error("Move target exists");
      await this.loadDocument(id);
      const prior = this.entry(id).path,
        current = this.doc(id);
      const journal = `moves/${id}.json`;
      await this.local.writeAtomic(
        journal,
        utf8.encode(JSON.stringify({ id, from: prior, to: path })),
      );
      if (this.fs.move && (!this.fs.stat || (await this.fs.stat(prior))))
        await this.fs.move(prior, path);
      await this.companions.move(prior, path);
      this.relocateScopes(prior, path);
      if (current.resource?.path === prior.split("/").pop())
        await this.persistDoc(
          A.change(A.clone(current), (doc) => {
            doc.resource!.path = path.split("/").pop()!;
          }),
          path,
        );
      await this.persistManifest(
        A.change(A.clone(this.manifest), (d) => {
          d.files[id].path = path;
        }),
      );
      await this.materialize(id);
      await this.refreshDocumentStorage(new Set([id]));
      await this.local.remove(journal);
      this.notify();
    });
  }
  remove(id: string) {
    return this.write(async () => {
      this.entry(id);
      await this.loadDocument(id);
      await this.persistManifest(
        A.change(A.clone(this.manifest), (d) => {
          d.files[id].deleted = true;
        }),
      );
      await this.materialize(id);
      this.notify();
    });
  }
  configure(policy: Partial<VaultPolicy>) {
    return this.configureScope("vault", "", policy);
  }
  /** Scan first, before remote materialization. Local edits branch from last written heads. */
  reconcile(changes?: FileSystemChange[]) {
    return this.write(async () => {
      const revision = this.revision;
      const beforeFeatures = new Map(
        [...this.docs.keys()].map((id) => [id, this.features(id)]),
      );
      const priorFolders = this.folders.join("\0");
      const forced = new Set<string>();
      let inventory: FileSystemEntry[] | undefined;
      // Structural events need one consistent metadata snapshot: watcher add and
      // remove notifications for the same rename can arrive in separate batches.
      if (
        changes &&
        this.fs.stat &&
        !changes.some(
          (c) =>
            c.directory || c.type !== "change" || !this.inventory.has(c.path),
        )
      ) {
        let missing = false;
        for (const change of changes) {
          const parts = change.path.split("/");
          const packageIndex = parts.findIndex((part) =>
            part.endsWith(".saddle"),
          );
          const path =
            packageIndex < 0
              ? change.path
              : companionOwner(parts.slice(0, packageIndex + 1).join("/"));
          if (
            !path ||
            path
              .split("/")
              .some((part) => part === ".git" || part === ".saddle")
          )
            continue;
          forced.add(path);
          const entry = await this.fs.stat(path);
          if (entry) this.inventory.set(path, entry);
          else {
            missing = true;
            this.inventory.delete(path);
          }
        }
        if (missing && this.fs.scan) {
          inventory = await this.fs.scan();
          this.inventory = new Map(
            inventory.map((entry) => [entry.path, entry]),
          );
        } else inventory = [...this.inventory.values()];
      } else if (this.fs.scan) {
        inventory = await this.fs.scan();
        this.inventory = new Map(inventory.map((entry) => [entry.path, entry]));
      }
      this.folders = inventory
        ? inventory
            .filter((e) => e.kind === "folder")
            .map((e) => e.path)
            .sort()
        : ((await this.fs.directories?.()) ?? this.folders).sort();
      let policiesChanged = false;
      if (
        !changes ||
        changes.some(
          (change) => change.path.endsWith(".saddle") || change.directory,
        )
      ) {
        const roots: Array<[string, CompanionDescriptor]> = [];
        const rootDescriptor = await this.companions.descriptor("");
        if (rootDescriptor) roots.push(["", rootDescriptor]);
        for (const entry of inventory ?? [])
          if (entry.kind === "companion") {
            const owner = companionOwner(entry.path),
              descriptor = await this.companions.descriptor(owner);
            if (descriptor) roots.push([owner, descriptor]);
          }
        const scopes = emptyScopePolicies();
        this.scopeLocations.clear();
        for (const [path, descriptor] of roots) {
          this.discoverScopes(path, descriptor);
          if (descriptor.kind === "folder") {
            if (!descriptor.deleted) {
              if (path) {
                if (Object.keys(descriptor.features).length)
                  scopes.folders[path] = descriptor.features;
              } else scopes.vault = descriptor.features;
            }
          } else scopes.files[descriptor.id] = descriptor.features;
        }
        for (const entry of Object.values(this.manifest.files))
          if (entry.storage && this.manifest.scopes.files[entry.id])
            scopes.files[entry.id] = {
              ...this.manifest.scopes.files[entry.id],
            };
        // Hosts without metadata inventories retain known policies. Native/browser
        // providers distinguish a removed companion from a missing inventory.
        if (
          inventory &&
          canonical(scopes) !== canonical(this.manifest.scopes)
        ) {
          this.manifest = A.change(A.clone(this.manifest), (d) => {
            d.scopes = scopes;
            d.policy = { ...this.inherited, ...scopes.vault };
          });
          this.revision++;
          policiesChanged = true;
        }
      }
      const paths = inventory
        ? inventory.filter((e) => e.kind === "file").map((e) => e.path)
        : (await this.fs.list()).filter(
            (path) =>
              !path
                .split("/")
                .some((part) => part === ".saddle" || part.endsWith(".saddle")),
          );
      const present = new Set(paths);
      const known = Object.entries(this.state.files).filter(
        ([, e]) => !e.deleted,
      );
      const occupied = new Map(
        Object.values(this.manifest.files)
          .filter((e) => !e.deleted)
          .map((e) => [e.path, e.id]),
      );
      const missing = known.filter(([, e]) => !present.has(e.path));
      const added = paths.filter((path) => !occupied.has(path));
      const disk = new Map<string, Uint8Array>();
      const read = async (path: string) => {
        if (!disk.has(path)) {
          const bytes = await this.fs.read(path);
          if (bytes) disk.set(path, bytes);
        }
        return disk.get(path);
      };
      const matches: import("./contracts").RenameMatch[] = known.flatMap(
        ([id, before]) => {
          const entry = this.entry(id);
          return entry.path !== before.path && present.has(entry.path)
            ? [{ from: before.path, to: entry.path, similarity: 100 }]
            : [];
        },
      );
      const unmatchedOld = missing.filter(
        ([, e]) => !matches.some((m) => m.from === e.path),
      );
      const unmatchedNew = added.filter(
        (path) => !matches.some((m) => m.to === path),
      );
      if (this.renames && unmatchedOld.length && unmatchedNew.length) {
        const before = [];
        for (const [id, checkpoint] of unmatchedOld) {
          const baseline =
            (await this.local.read(`baselines/${id}.bin`)) ??
            (await this.companions.read(this.archivePath(id), "baseline.bin"));
          if (baseline) before.push({ path: checkpoint.path, bytes: baseline });
          else if (!this.unloaded.has(id) || this.persistedDocuments.has(id)) {
            await this.loadDocument(id);
            before.push({
              path: checkpoint.path,
              bytes: fileBytes(this.doc(id)),
            });
          }
          // A never-read ordinary file has no observed contents to compare.
        }
        const after = [];
        for (const path of unmatchedNew) {
          const bytes = await read(path);
          if (bytes) after.push({ path, bytes });
        }
        matches.push(...(await this.renames.match(before, after)));
      }
      const touched = new Set<string>();
      this.batching = true;
      try {
        for (const match of matches) {
          const found = missing.find(([, e]) => e.path === match.from);
          if (!found) continue;
          await this.companions.move(match.from, match.to);
          await this.persistManifest(
            A.change(A.clone(this.manifest), (d) => {
              d.files[found[0]].path = match.to;
            }),
          );
          touched.add(found[0]);
        }
        // All folder-owned declarations travel with libgit2-identified descendant moves.
        const folderOwners = new Set([
          ...Object.keys(this.manifest.scopes.folders),
          ...[...this.unitLocations]
            .filter(
              ([id, path]) => path && !Object.hasOwn(this.manifest.files, id),
            )
            .map(([, path]) => path),
        ]);
        for (const from of folderOwners) {
          if (this.folders.includes(from)) continue;
          const children = known.filter(([, e]) =>
            e.path.startsWith(from + "/"),
          );
          const destinations = new Set(
            children.flatMap(([, entry]) => {
              const move = matches.find((m) => m.from === entry.path);
              const suffix = entry.path.slice(from.length);
              return move?.to.endsWith(suffix)
                ? [move.to.slice(0, -suffix.length)]
                : [];
            }),
          );
          if (
            children.length &&
            destinations.size === 1 &&
            children.every(([, e]) => matches.some((m) => m.from === e.path))
          ) {
            const to = [...destinations][0];
            if (!this.folders.includes(to)) continue;
            await this.companions.move(from, to);
            this.relocateScopes(from, to);
            this.manifest = A.change(A.clone(this.manifest), (d) => {
              d.scopes.folders[to] = { ...d.scopes.folders[from] };
              delete d.scopes.folders[from];
              for (const declaration of Object.values(d.namedPaths))
                if (
                  declaration.path === from ||
                  declaration.path.startsWith(from + "/")
                )
                  declaration.path = to + declaration.path.slice(from.length);
            });
          }
        }
        for (const [id, checkpoint] of known) {
          const entry = this.entry(id),
            moved = matches.find((m) => m.from === checkpoint.path);
          const path = moved?.to ?? entry.path;
          if (!present.has(path)) {
            await this.loadDocument(id);
            if (
              !entry.deleted &&
              equalHeads(A.getHeads(this.doc(id)), checkpoint.heads) &&
              entry.path === checkpoint.path
            ) {
              await this.persistManifest(
                A.change(A.clone(this.manifest), (d) => {
                  d.files[id].deleted = true;
                }),
              );
              touched.add(id);
            }
            continue;
          }
          const stat = this.inventory.get(path);
          const unchanged =
            !forced.has(path) && stat?.stamp && stat.stamp === checkpoint.stamp;
          // Metadata may change independently of the visible file.
          const sidecar = await this.sidecarCheckpoint(path);
          const metadataChanged =
            canonical(sidecar) !== canonical(checkpoint.sidecar ?? null);
          if (unchanged && !metadataChanged && !moved && this.unloaded.has(id))
            continue;
          await this.loadDocument(id);
          if (!unchanged || metadataChanged || moved) {
            const bytes = await read(path);
            if (!bytes) continue;
            if (
              (await digest(bytes)) !== checkpoint.hash ||
              metadataChanged ||
              moved
            ) {
              if (this.frozen[id])
                throw Error(
                  "External edits arrived during a history checkpoint; cancel the checkpoint before rescanning",
                );
              const base = A.view(this.doc(id), this.state.files[id].heads),
                draft = new Draft(id, A.clone(base), path);
              if (base.kind === "text")
                draft.text = new TextDecoder("utf-8", { fatal: true }).decode(
                  bytes,
                );
              else draft.bytes = bytes;
              const descriptor = await this.companions.read(path, resourceName);
              draft.resource = null;
              draft.invalidResource = null;
              if (descriptor) {
                const source = text.decode(descriptor);
                try {
                  draft.resource = parseResource(source);
                } catch {
                  draft.invalidResource = source;
                }
              }
              if (moved)
                draft.resource = relocatedResource(
                  draft.resource,
                  checkpoint.path,
                  path,
                );
              await this.persistDoc(
                A.merge(
                  A.clone(this.doc(id)),
                  this.applyDraft(draft, base, "External edit"),
                ),
              );
              touched.add(id);
            } else if (stat) {
              this.state.files[id].stamp = stat.stamp;
            }
          }
          if (
            !equalHeads(A.getHeads(this.doc(id)), checkpoint.heads) ||
            entry.path !== checkpoint.path
          )
            touched.add(id);
        }
        const incoming: Array<{
          id: string;
          path: string;
          doc: A.Doc<FileDocument>;
        }> = [];
        for (const path of added) {
          if (matches.some((m) => m.to === path)) continue;
          const descriptor = await this.companions.descriptor(path);
          const features = effectiveFeatures(
            this.manifest.scopes,
            this.inherited,
            path,
            descriptor?.id,
          );
          if (
            this.lazy &&
            !needsDocument(features) &&
            !descriptor &&
            !this.inventory.has(sidecarPath(path))
          ) {
            const id = crypto.randomUUID(),
              stat = this.inventory.get(path);
            const doc = await this.readPlainDocument(
              id,
              path,
              new Uint8Array(),
            );
            incoming.push({ id, path, doc });
            this.unloaded.add(id);
            this.state.files[id] = {
              path,
              heads: [],
              epoch: 0,
              hash: "",
              deleted: false,
              stamp: stat?.stamp,
              sidecar: null,
            };
            continue;
          }
          const bytes = await read(path);
          if (!bytes) continue;
          const id = descriptor?.id ?? crypto.randomUUID();
          const doc = await this.readPlainDocument(id, path, bytes);
          incoming.push({ id, path, doc });
        }
        if (incoming.length) {
          await this.persistManifest(
            A.change(A.clone(this.manifest), (d) => {
              for (const { id, path } of incoming)
                d.files[id] = { id, path, deleted: false };
            }),
          );
          for (const { id, path, doc } of incoming) {
            if (this.unloaded.has(id)) {
              this.docs.set(id, doc);
              continue;
            }
            await this.persistDoc(doc, path);
            touched.add(id);
          }
        }
        for (const id of touched) {
          await this.materialize(id);
          this.metadata(id);
        }
      } finally {
        this.batching = false;
      }
      if (touched.size || this.revision !== revision) {
        await this.persistVaultSettings();
        await this.checkpoint([...touched]);
        for (const id of touched)
          await this.local.remove(`pending/${id}.automerge`);
      }
      if (policiesChanged)
        await this.refreshDocumentStorage(
          new Set(
            [...beforeFeatures]
              .filter(
                ([id, before]) =>
                  needsDocument(before) && !needsDocument(this.features(id)),
              )
              .map(([id]) => id),
          ),
        );
      await this.persistMetadataErrors();
      if (
        this.revision !== revision ||
        priorFolders !== this.folders.join("\0")
      )
        this.notify();
    });
  }
  /** Read lazy archive statistics without loading the file or generating its diffs. */
  async historyVersionCount(id: string) {
    if (!this.historyEnabled(id)) return 0;
    if (!this.unloaded.has(id)) return A.stats(this.doc(id)).numChanges;
    return this.companions.documentChanges(this.archivePath(id), contentName);
  }
  history(id: string) {
    if (!this.historyEnabled(id))
      throw Error("Edit history is disabled for this file");
    const doc = this.doc(id);
    let versions = historyCache.get(doc);
    if (!versions) {
      const heads = new Set<string>();
      let previous = new Uint8Array();
      versions = A.getAllChanges(doc).map((encoded, index) => {
        const change = A.decodeChange(encoded);
        for (const parent of change.deps) heads.delete(parent);
        heads.add(change.hash);
        // Views reuse the existing document instead of rebuilding every prefix of history.
        const snapshot = A.view(doc, [...heads]);
        const bytes = fileBytes(snapshot);
        const changes =
          snapshot.kind === "binary"
            ? { before: previous.byteLength, after: bytes.byteLength }
            : textChangeSize(text.decode(previous), text.decode(bytes));
        previous = bytes;
        return {
          hash: change.hash,
          heads: [...heads],
          message: change.message,
          ...historyLabel(
            change.message,
            index === 0 ? "File created" : "Update file",
          ),
          time: change.time,
          bytes,
          changes,
        };
      });
      historyCache.set(doc, versions);
    }
    return versions.slice();
  }
  restore(id: string, heads: A.Heads) {
    if (!this.historyEnabled(id))
      throw Error("Edit history is disabled for this file");
    const draft = this.draft(id),
      old = A.view(this.doc(id), heads);
    draft.text = fileText(old);
    draft.bytes = new Uint8Array(old.bytes);
    draft.mime = old.mime;
    draft.resource = old.resource
      ? structuredClone(A.toJS(old).resource)
      : null;
    draft.invalidResource = old.invalidResource;
    draft.template = old.template ? structuredClone(old.template) : null;
    return draft; // Recovery remains a draft until explicitly saved.
  }
  /** Explicit recovery creates an independent file; it never restores old grants. */
  recoverCopy(id: string, path: string, heads: A.Heads) {
    if (!this.historyEnabled(id))
      throw Error("Edit history is disabled for this file");
    const old = A.view(this.doc(id), heads);
    return this.create(path, fileBytes(old), {
      mime: old.mime,
      resource: relocatedResource(
        A.toJS(old).resource,
        this.entry(id).path,
        path,
      ),
      invalidResource: old.invalidResource,
    });
  }
  exportDocument(id: string) {
    this.entry(id);
    return A.save(this.doc(id));
  }
  exportManifest() {
    return A.save(this.manifest);
  }
  /** Resume an authenticated, previously shared checkpoint after private compaction.
   * Reapply saved edits to its baseline so remote edits remain concurrent.
   * Never use this to bypass a pending retention agreement or retained history.
   */
  resumeFileSharing(id: string, shared: A.Doc<FileDocument>) {
    return this.write(async () => {
      await this.loadDocument(id);
      this.validateDocument(shared, id);
      const current = this.doc(id);
      if (
        current.generation === shared.generation ||
        !this.syncEnabled(id) ||
        this.historyEnabled(id) ||
        this.protectedHistory.has(id) ||
        this.frozen[id] ||
        this.hasDirtyDraft(id) ||
        hasDistinctConflicts(current)
      )
        return;
      const baseline = A.getHistory(shared)[0]?.snapshot;
      if (!baseline || baseline.kind !== current.kind)
        throw Error("Missing shared checkpoint baseline");
      const draft = new Draft(id, A.clone(baseline), this.entry(id).path);
      draft.text = fileText(current);
      draft.bytes = new Uint8Array(current.bytes);
      draft.mime = current.mime;
      draft.resource = current.resource ? A.toJS(current).resource : null;
      draft.invalidResource = current.invalidResource;
      draft.template = current.template ? A.toJS(current).template : null;
      await this.persistDoc(
        A.merge(
          A.clone(shared),
          this.applyDraft(draft, baseline, "Resume sharing"),
        ),
      );
      await this.materialize(id);
      for (const open of this.drafts)
        if (open.fileId === id && !open.dirty)
          open.original = A.clone(this.doc(id));
      this.notify();
    });
  }
  /** The caller supplies a transport already authenticated for this folder. */
  resumeFolderSharing(path: string, shared: A.Doc<FolderDocument>) {
    return this.write(async () => {
      if (path) filePath(path);
      this.validateFolderDocument(shared);
      const current = await this.loadFolder(path);
      if (
        !current ||
        current.id !== shared.id ||
        folderGeneration(current) === folderGeneration(shared) ||
        !this.folderFeatures(path).sync ||
        this.folderFeatures(path).history ||
        this.protectedHistory.has(current.id) ||
        this.frozen[current.id] ||
        hasDistinctConflicts(current)
      )
        return;
      const baseline = A.getHistory(shared)[0]?.snapshot;
      if (!baseline) throw Error("Missing shared folder checkpoint baseline");
      const desired = {
        ...A.toJS(current),
        ...(shared.checkpoint ? { checkpoint: A.toJS(shared).checkpoint } : {}),
      };
      if (!shared.checkpoint) delete desired.checkpoint;
      const branch = A.change(
        A.clone(baseline),
        { message: "Resume sharing" },
        (draft) => {
          patchSettings(draft, desired);
        },
      );
      await this.materializeFolder(
        path,
        A.merge(A.clone(shared), branch),
        await this.companions.descriptor(path),
      );
    });
  }
  /** Caller must authenticate scope and peer before handing bytes to this method. */
  receiveDocument(id: string, bytes: Uint8Array) {
    return this.write(async () => {
      this.entry(id);
      await this.loadDocument(id);
      const incoming = A.load<FileDocument>(bytes),
        current = this.doc(id);
      this.validateDocument(incoming, id);
      if (incoming.generation !== current.generation)
        throw Error("Different checkpoint epoch; explicit rejoin is required");
      await this.persistDoc(A.merge(A.clone(current), incoming));
      await this.materialize(id);
      this.notify();
    });
  }
  /** Explicitly accepted, authenticated scope entries. Never accepts filesystem roots. */
  receiveSharedFile(entry: FileEntry, bytes: Uint8Array) {
    return this.write(async () => {
      filePath(entry.path);
      documentId(entry.id);
      const incoming = A.load<FileDocument>(bytes);
      this.validateDocument(incoming, entry.id);
      await this.loadDocument(entry.id);
      const current = this.docs.get(entry.id),
        collision = this.find(entry.path);
      if (collision && collision.id !== entry.id)
        throw Error(`Shared path already exists: ${entry.path}`);
      if (!current && (await this.fs.read(entry.path)))
        throw Error(`Untracked file already exists: ${entry.path}`);
      if (current && incoming.generation !== current.generation)
        throw Error(
          "Different checkpoint epoch; preserve offline edits before rejoining",
        );
      await this.persistDoc(
        current ? A.merge(A.clone(current), incoming) : incoming,
      );
      const previous = this.manifest.files[entry.id];
      let journal: string | undefined;
      if (previous && previous.path !== entry.path) {
        journal = `moves/${entry.id}.json`;
        await this.local.writeAtomic(
          journal,
          utf8.encode(
            JSON.stringify({
              id: entry.id,
              from: previous.path,
              to: entry.path,
            }),
          ),
        );
        if (
          this.fs.move &&
          (!this.fs.stat || (await this.fs.stat(previous.path)))
        )
          await this.fs.move(previous.path, entry.path);
        await this.companions.move(
          previous.storage ?? previous.path,
          entry.path,
        );
        this.relocateScopes(previous.path, entry.path);
      }
      await this.persistManifest(
        A.change(A.clone(this.manifest), (d) => {
          d.files[entry.id] = {
            id: entry.id,
            path: entry.path,
            deleted: entry.deleted,
          };
        }),
      );
      await this.materialize(entry.id);
      if (journal) await this.local.remove(journal);
      this.notify();
    });
  }
  rewriteFileHistory(id: string, operation: HistoryRewrite) {
    return this.write(async () => {
      await this.loadDocument(id);
      if (!this.historyEnabled(id)) throw Error("History is disabled");
      if (this.historyProtection(id))
        throw Error("Shared history requires computer agreement");
      if (this.hasDirtyDraft(id) || this.frozen[id])
        throw Error("Save or discard drafts before editing history");
      const checkpoint = this.state.files[id],
        actual = await this.fs.read(checkpoint.path);
      if (!actual || (await digest(actual)) !== checkpoint.hash)
        throw Error("Reconcile external edits before changing history");
      await this.replaceFileHistory(id, operation, crypto.randomUUID());
      this.notify();
    });
  }
  private async replaceFileHistory(
    id: string,
    operation: HistoryRewrite,
    token: string,
  ) {
    const prior = this.doc(id),
      next = rewriteHistory(prior, operation, token, fileRewriteShape);
    this.validateDocument(next, id);
    // Validate projections before publishing any replacement bytes.
    fileBytes(next);
    if (next.resource) parseResource(serializeResource(next.resource));
    const backup = `checkpoints/${this.computer}-${id}.automerge`;
    await this.local.writeAtomic(backup, A.save(prior));
    await this.persistDoc(next);
    await this.materialize(id);
    await this.local.remove(backup);
    this.rebaseHistoryDrafts(id, next);
  }
  private rebaseHistoryDrafts(id: string, next: A.Doc<FileDocument>) {
    for (const draft of this.drafts) {
      if (draft.fileId !== id) continue;
      const state = draft.dirty
        ? (replayHistoryDelta(
            A.toJS(draft.original),
            A.toJS(this.applyDraft(draft, draft.original)),
            A.toJS(next),
          ) as FileDocument)
        : A.toJS(next);
      const fresh = new Draft(id, A.clone(next), this.entry(id).path);
      fresh.text = fileText(state);
      fresh.bytes = new Uint8Array(state.bytes);
      fresh.mime = state.mime;
      fresh.resource = state.resource;
      fresh.invalidResource = state.invalidResource;
      fresh.template = state.template;
      Object.assign(draft, {
        original: fresh.original,
        text: fresh.text,
        bytes: fresh.bytes,
        mime: fresh.mime,
        resource: fresh.resource,
        invalidResource: fresh.invalidResource,
        template: fresh.template,
      });
    }
  }
  rewriteFolderHistory(path: string, operation: HistoryRewrite) {
    return this.write(async () => {
      const doc = await this.loadFolder(path);
      if (!doc || !this.folderFeatures(path).history)
        throw Error("Folder history is disabled");
      if (this.historyProtection(doc.id))
        throw Error("Shared history requires computer agreement");
      const next = rewriteHistory(
        doc,
        operation,
        crypto.randomUUID(),
        folderRewriteShape,
      );
      this.validateFolderDocument(next);
      await this.materializeFolder(
        path,
        next,
        await this.companions.descriptor(path),
      );
    });
  }
  /** Called by the retention barrier only, with no participants writing the old epoch. */
  checkpointHistory(
    id: string,
    frozenHeads: A.Heads,
    token: string,
    rewrite?: HistoryRewrite,
  ) {
    return this.write(async () => {
      if (
        (!rewrite &&
          (this.historyEnabled(id) || this.doc(id).retainHistory === true)) ||
        this.frozen[id]?.token !== token ||
        (!rewrite && this.hasDirtyDraft(id)) ||
        !equalHeads(A.getHeads(this.doc(id)), frozenHeads)
      )
        throw Error("History checkpoint is no longer eligible");
      const checkpoint = this.state.files[id],
        actual = await this.fs.read(checkpoint.path);
      if (!actual || (await digest(actual)) !== checkpoint.hash)
        throw Error("External edits must be preserved before checkpointing");
      if (rewrite) await this.replaceFileHistory(id, rewrite, token);
      else await this.prune(id);
      delete this.frozen[id];
      await this.persistRetention();
      this.notify();
    });
  }
  private async prune(id: string) {
    const doc = this.doc(id);
    // Distinct conflicting registers are live data; identical assignments can be checkpointed.
    if (hasDistinctConflicts(doc)) return;
    const current = A.toJS(doc);
    const backupPath = `checkpoints/${this.computer}-${id}.automerge`;
    await this.local.writeAtomic(backupPath, A.save(doc));
    await this.persistDoc(
      A.from<FileDocument>({
        ...current,
        epoch: current.epoch + 1,
        generation: crypto.randomUUID(),
      }),
    );
    await this.materialize(id);
    await this.local.remove(backupPath);
    for (const draft of this.drafts)
      if (draft.fileId === id && !draft.dirty)
        draft.original = A.clone(this.doc(id));
  }
  acceptCheckpoint(id: string, bytes: Uint8Array, token: string) {
    return this.write(async () => {
      const current = this.doc(id),
        incoming = A.load<FileDocument>(bytes);
      this.validateDocument(incoming, id);
      // The control document and share manifest can deliver the same commit
      // concurrently. Check again inside the serialized writer, after waiting.
      if (
        incoming.generation === current.generation &&
        incoming.epoch === current.epoch
      ) {
        if (!equalHeads(A.getHeads(current), A.getHeads(incoming))) {
          await this.persistDoc(A.merge(A.clone(current), incoming));
          await this.materialize(id);
          this.notify();
        }
        return;
      }
      const frozen = this.frozen[id];
      if (
        !frozen ||
        frozen.token !== token ||
        frozen.epoch !== current.epoch ||
        incoming.epoch !== current.epoch + 1
      )
        throw Error(
          "Checkpoint requires explicit rejoin; offline drafts are preserved",
        );
      const baseline = A.getHistory(incoming)[0]?.snapshot;
      if (frozen.rewrite) {
        const expected = rewriteHistory(
          A.view(current, frozen.heads),
          frozen.rewrite,
          token,
          fileRewriteShape,
        );
        if (!A.hasHeads(incoming, A.getHeads(expected)))
          throw Error("History rewrite does not match the agreed operation");
      } else if (
        !baseline ||
        (await digest(fileBytes(baseline))) !==
          (await digest(fileBytes(A.view(current, frozen.heads))))
      )
        throw Error("Checkpoint does not match the frozen file state");
      const checkpoint = this.state.files[id],
        actual = await this.fs.read(checkpoint.path);
      let next = incoming;
      if (actual && (await digest(actual)) !== checkpoint.hash) {
        const external = new Draft(
          id,
          A.clone(frozen.rewrite ? current : baseline),
        );
        if (current.kind === "text")
          external.text = new TextDecoder("utf-8", { fatal: true }).decode(
            actual,
          );
        else external.bytes = actual;
        if (frozen.rewrite) {
          const state = replayHistoryDelta(
            A.toJS(current),
            A.toJS(this.applyDraft(external, current)),
            A.toJS(incoming),
          ) as FileDocument;
          const rebased = new Draft(id, A.clone(incoming));
          rebased.text = fileText(state);
          rebased.bytes = new Uint8Array(state.bytes);
          rebased.mime = state.mime;
          rebased.resource = state.resource;
          rebased.invalidResource = state.invalidResource;
          rebased.template = state.template;
          next = this.applyDraft(rebased, incoming, "External edit");
        } else {
          next = A.merge(
            A.clone(incoming),
            this.applyDraft(external, baseline, "External edit"),
          );
        }
      }
      fileBytes(next);
      const backupPath = `checkpoints/${this.computer}-${id}.automerge`;
      await this.local.writeAtomic(backupPath, A.save(current));
      await this.persistDoc(next);
      await this.materialize(id);
      await this.local.remove(backupPath);
      // Unsaved edits branch from the equivalent fresh checkpoint, preserving drafts.
      if (frozen.rewrite) this.rebaseHistoryDrafts(id, next);
      else
        for (const draft of this.drafts)
          if (draft.fileId === id) draft.original = A.clone(baseline);
      delete this.frozen[id];
      await this.persistRetention();
      this.notify();
    });
  }
}
