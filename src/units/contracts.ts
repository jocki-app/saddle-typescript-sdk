import type * as A from "@automerge/automerge";

export { filePath, documentId } from "../filesystem.js";
export type {
  VaultFileSystem,
  FileSystemEntry,
  FileSystemChange,
  RenameCandidate,
  RenameMatch,
  RenameMatcher,
} from "../filesystem.js";
export type FileKind = "text" | "binary";
export interface TemplateReference {
  file: string;
  /** Advisory location only; never grants filesystem access. */
  hint: string;
  /** Last accepted source contents, for three-way updates on open only. */
  baseline: string;
}
export interface FileDocument extends Record<string, unknown> {
  format: "saddle-file/1";
  id: string;
  epoch: number;
  generation: string;
  mime: string;
  resource: import("./metadata").DataResource | null;
  invalidResource: string | null;
  kind: FileKind;
  text: string;
  csdb: import("./csdb-model").CSDBState | null;
  bytes: Uint8Array;
  template: TemplateReference | null;
  retainHistory?: boolean;
}
export interface FileEntry {
  id: string;
  path: string;
  deleted: boolean;
  /** Companion owner path for retained deletions moved out of a removed folder. */
  storage?: string;
}
export interface VaultPolicy {
  history: boolean;
  sync: boolean;
}
export interface VaultManifest extends Record<string, unknown> {
  format: "saddle-root-index/1";
  id: string;
  name: string;
  policy: VaultPolicy;
  coordinated: boolean;
  files: Record<string, FileEntry>;
  scopes: import("./scope-policy").ScopePolicies;
  namedPaths: Record<
    string,
    { key: string; id: string; path: string; kind: "file" | "folder" }
  >;
  templates: Record<string, { path: string; name: string; enabled: boolean }>;
}
export interface MaterializedFile {
  path: string;
  heads: A.Heads;
  epoch: number;
  hash: string;
  deleted: boolean;
  sidecar?: { path: string; hash: string } | null;
  stamp?: string;
}
export interface MaterializationState {
  format: "saddle-materialization/1";
  files: Record<string, MaterializedFile>;
}
export interface FileSummary extends FileEntry {
  mime: string;
  contentType: string | null;
  epoch: number;
  kind: FileKind;
  metadataError?: string;
}
export interface ContentType {
  id: string;
  name: string;
  mimeTypes: string[];
  extensions: string[];
  tables?: Record<string, { required: Record<string, string> }>;
  requirements?: string[];
}
export interface FileHandler {
  id: string;
  name: string;
  contentTypes: string[];
  requiresContentType: boolean;
  mimeTypes: string[];
  extensions: string[];
}
export interface FileDraft {
  readonly fileId: string;
  readonly baseline: A.Heads;
  text: string;
  bytes: Uint8Array;
  mime: string;
  contentType: string | null;
  template: TemplateReference | null;
  readonly dirty: boolean;
}
