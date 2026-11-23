/** Paths are portable, vault-relative and never include the private metadata tree. */
export function filePath(value: string): string {
  if (
    !value ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\x00-\x1f:]/.test(value)
  )
    throw Error("Expected a relative vault path");
  const parts = value.split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.toLowerCase() === ".saddle",
    )
  )
    throw Error("Invalid or reserved vault path");
  return parts.join("/");
}
export function documentId(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw Error("Invalid document ID");
  return value;
}
/** Implementations must close/flush writes durably before resolving. No UI imports. */
export interface VaultFileSystem {
  release?(): Promise<void>;
  /** Explicit local capability used to remove SADDLE metadata, never ordinary files. */
  removeTree?(path: string): Promise<void>;
  read(path: string): Promise<Uint8Array | undefined>;
  writeAtomic(path: string, data: Uint8Array): Promise<void>;
  /** Bounded reads and durable positioned writes for append-only unit containers. */
  readRange?(
    path: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array | undefined>;
  writeAt?(path: string, offset: number, data: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  list(): Promise<string[]>;
  mkdir?(path: string): Promise<void>;
  removeDirectory?(path: string): Promise<void>;
  directories?(): Promise<string[]>;
  /** Metadata-only inventory. Binary companions are opaque entries. */
  scan?(path?: string): Promise<FileSystemEntry[]>;
  stat?(path: string): Promise<FileSystemEntry | undefined>;
  /** Atomic directory/file rename within this explicit capability. */
  move?(from: string, to: string): Promise<void>;
  /** Narrow capability for the opened root's sibling companion. */
  removeCompanionRoot?(): Promise<void>;
  companionRoot?(create?: boolean): Promise<VaultFileSystem | undefined>;
}
export interface FileSystemEntry {
  path: string;
  kind: "file" | "folder" | "companion";
  stamp: string;
  size: number;
}
export interface FileSystemChange {
  path: string;
  type: "add" | "change" | "remove";
  directory?: boolean;
}
export interface RenameCandidate {
  path: string;
  bytes: Uint8Array;
}
export interface RenameMatch {
  from: string;
  to: string;
  similarity: number;
}
/** Explicit content-based rename capability. No alternate matcher is tried after failure. */
export interface RenameMatcher {
  readonly name: string;
  match(
    before: RenameCandidate[],
    after: RenameCandidate[],
  ): Promise<RenameMatch[]>;
}
