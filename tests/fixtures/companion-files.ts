import { RecordFiles } from "../../src/units/record-container";
import type { VaultFileSystem } from "../../src/filesystem";

/** Ordinary files and an independently granted sibling companion capability. */
export class CompanionFiles implements VaultFileSystem {
  values = new Map<string, Uint8Array>();
  folders = new Set<string>();
  fail?: string;
  private sibling?: CompanionFiles;
  get files() {
    return this.values;
  }
  set files(value: Map<string, Uint8Array>) {
    this.values = value;
  }
  async read(path: string) {
    return this.values.get(path)?.slice();
  }
  async readRange(path: string, offset: number, length: number) {
    return this.values.get(path)?.slice(offset, offset + length);
  }
  async writeAt(path: string, offset: number, bytes: Uint8Array) {
    if (this.fail === path) throw Error("Disk full");
    const prior = this.values.get(path);
    if (!prior) throw Error("Missing container");
    const next = new Uint8Array(Math.max(prior.length, offset + bytes.length));
    next.set(prior);
    next.set(bytes, offset);
    this.values.set(path, next);
  }
  async writeAtomic(path: string, bytes: Uint8Array) {
    if (this.fail === path) throw Error("Disk full");
    this.values.set(path, bytes.slice());
  }
  async remove(path: string) {
    this.values.delete(path);
  }
  async list() {
    return [...this.values.keys()];
  }
  async companionRoot() {
    return new RecordFiles(
      (this.sibling ??= new CompanionFiles()),
      "container",
    );
  }
  async removeCompanionRoot() {
    this.sibling = undefined;
  }
  async removeTree(path: string) {
    if (!path.endsWith(".saddle"))
      throw Error("Only companion packages can be removed");
    for (const key of this.values.keys())
      if (key.startsWith(path + "/")) this.values.delete(key);
  }
  async move(from: string, to: string) {
    if (
      [...this.values.keys()].some(
        (key) => key === to || key.startsWith(to + "/"),
      )
    )
      throw Error("Move destination already exists");
    for (const [key, bytes] of [...this.values])
      if (key === from || key.startsWith(from + "/")) {
        this.values.set(to + key.slice(from.length), bytes);
        this.values.delete(key);
      }
  }
  async mkdir(path: string) {
    this.folders.add(path);
  }
  async directories() {
    return [...this.folders];
  }
  async removeDirectory(path: string) {
    this.folders.delete(path);
  }
  clone(): CompanionFiles {
    const copy = new CompanionFiles();
    copy.values = new Map([...this.values].map(([p, b]) => [p, b.slice()]));
    copy.folders = new Set(this.folders);
    copy.sibling = this.sibling?.clone();
    return copy;
  }
}
