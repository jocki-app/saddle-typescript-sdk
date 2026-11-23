import { RecordFiles, SingleFile } from "../units/record-container.js";
import {
  open,
  mkdir,
  readdir,
  lstat,
  realpath,
  rename,
  unlink,
  readFile,
  rmdir,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { tryLock, unlock } from "fs-native-extensions";
import type { FileSystemEntry, VaultFileSystem } from "../units/contracts.js";

/** A selected root is the capability. Symlinks and traversal never leave it. */
export class NodeVaultFiles implements VaultFileSystem {
  private constructor(
    readonly root: string,
    private readonly exclude: string[] = [],
  ) {}
  static async open(
    root: string,
    options: { create?: boolean; exclude?: string[] } = {},
  ) {
    if (options.create !== false)
      await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw Error("Vault root must be a real directory");
    for (const name of options.exclude ?? [])
      if (
        !name ||
        name.startsWith("/") ||
        name.split("/").some((part) => !part || part === ".." || part === ".")
      )
        throw Error("Invalid excluded capability path");
    return new NodeVaultFiles(await realpath(root), options.exclude);
  }
  /** Kernel locks release on exit and are never copied with filesystem metadata. */
  async acquireWriter() {
    const locks = await NodeVaultFiles.open(
      path.join(tmpdir(), "saddle-writer-locks"),
    );
    const key = createHash("sha256").update(this.root).digest("hex");
    const file = await open(
      await locks.target(`locks/${key}.lock`, true),
      "a+",
      0o600,
    );
    try {
      if (!tryLock(file.fd))
        throw Error("This vault is already open in another SADDLE process");
    } catch (error) {
      await file.close();
      throw error;
    }
    let held = true;
    return async () => {
      if (!held) return;
      held = false;
      try {
        unlock(file.fd);
      } finally {
        await file.close();
      }
    };
  }
  private excluded(relative: string) {
    return this.exclude.some(
      (prefix) => relative === prefix || relative.startsWith(prefix + "/"),
    );
  }
  private async target(relative: string, create = false) {
    if (this.excluded(relative))
      throw Error("Path is outside the filesystem capability");
    if (
      !relative ||
      relative.startsWith("/") ||
      relative.includes("\\") ||
      /[\x00-\x1f:]/.test(relative) ||
      relative.split("/").some((p) => !p || p === "." || p === "..")
    )
      throw Error("Invalid relative path");
    const parts = relative.split("/");
    try {
      const rootInfo = await lstat(this.root);
      if (rootInfo.isSymbolicLink())
        throw Error("Filesystem root symlinks are not followed");
      if (!rootInfo.isDirectory())
        throw Error("Filesystem root must be a real directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (create) {
        await mkdir(this.root, { mode: 0o700 });
        if (process.platform !== "win32") {
          const parent = await open(path.dirname(this.root), "r");
          try {
            await parent.sync();
          } finally {
            await parent.close();
          }
        }
      }
    }
    let current = this.root;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      let info;
      try {
        info = await lstat(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (create && i < parts.length - 1) {
          await mkdir(current, { mode: 0o700 });
          info = await lstat(current);
          if (process.platform !== "win32") {
            const parent = await open(path.dirname(current), "r");
            try {
              await parent.sync();
            } finally {
              await parent.close();
            }
          }
        }
      }
      if (info?.isSymbolicLink())
        throw Error("Vault symlinks are not followed");
      if (info && i < parts.length - 1 && !info.isDirectory())
        throw Error("Path is not a directory");
    }
    return current;
  }
  async read(relative: string) {
    const target = await this.target(relative);
    try {
      return new Uint8Array(await readFile(target));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  async writeAtomic(relative: string, bytes: Uint8Array) {
    const target = await this.target(relative, true),
      temporary = path.join(
        path.dirname(target),
        `.saddle-write-${randomUUID()}`,
      );
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
      await file.close();
      // Revalidate after the write, before publishing through the selected path.
      await this.target(relative);
      await rename(temporary, target);
      // Directory fsync is supported by POSIX. Windows FlushFileBuffers on the file
      // plus atomic replacement supplies the platform's available durability.
      if (process.platform !== "win32") {
        const dir = await open(path.dirname(target), "r");
        try {
          await dir.sync();
        } finally {
          await dir.close();
        }
      }
    } catch (error) {
      await file.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
  async remove(relative: string) {
    try {
      await unlink(await this.target(relative));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return;
    }
    if (process.platform !== "win32") {
      const dir = await open(path.dirname(await this.target(relative)), "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    }
  }
  async mkdir(relative: string) {
    const target = await this.target(relative, true);
    await mkdir(target, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      const dir = await open(path.dirname(target), "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    }
  }
  async removeTree(relative: string) {
    if (!relative.split("/").at(-1)?.endsWith(".saddle"))
      throw Error("Only SADDLE metadata can be deleted recursively");
    const target = await this.target(relative);
    await rm(target, { recursive: true, force: true });
    if (process.platform !== "win32") {
      const dir = await open(path.dirname(target), "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    }
  }
  async removeDirectory(relative: string) {
    const target = await this.target(relative);
    for (const item of await readdir(target, { withFileTypes: true })) {
      if (!item.isDirectory() || item.isSymbolicLink())
        throw Error("Folder contains files; rescan before deleting");
      await this.removeDirectory(relative + "/" + item.name);
    }
    await rmdir(target);
    if (process.platform !== "win32") {
      const dir = await open(path.dirname(target), "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    }
  }
  async removeCompanionRoot() {
    const parent = new NodeVaultFiles(path.dirname(this.root));
    await parent.remove("." + path.basename(this.root) + ".saddle");
  }
  async companionRoot() {
    return new RecordFiles(this.companionStorage(), "container");
  }
  companionStorage() {
    return new SingleFile(
      new NodeVaultFiles(path.dirname(this.root)),
      "." + path.basename(this.root) + ".saddle",
    );
  }
  async readRange(relative: string, offset: number, length: number) {
    let handle;
    try {
      handle = await open(await this.target(relative), "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    try {
      const bytes = new Uint8Array(length);
      const result = await handle.read(bytes, 0, length, offset);
      return bytes.subarray(0, result.bytesRead);
    } finally {
      await handle.close();
    }
  }
  async writeAt(relative: string, offset: number, bytes: Uint8Array) {
    const handle = await open(await this.target(relative), "r+");
    try {
      let written = 0;
      while (written < bytes.length) {
        const result = await handle.write(
          bytes,
          written,
          bytes.length - written,
          offset + written,
        );
        if (!result.bytesWritten)
          throw Error("Positioned write made no progress");
        written += result.bytesWritten;
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  async move(from: string, to: string) {
    const source = await this.target(from),
      destination = await this.target(to, true);
    try {
      await lstat(destination);
      throw Error("Move destination already exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(source, destination);
    if (process.platform !== "win32")
      for (const parent of new Set([
        path.dirname(source),
        path.dirname(destination),
      ])) {
        const directory = await open(parent, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
  }
  async stat(relative: string): Promise<FileSystemEntry | undefined> {
    try {
      const info = await lstat(await this.target(relative), { bigint: true });
      if (info.isSymbolicLink()) return;
      return {
        path: relative,
        kind: relative.endsWith(".saddle")
          ? "companion"
          : info.isDirectory()
            ? "folder"
            : "file",
        size: Number(info.size),
        stamp: `${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.birthtimeNs}`,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  async scan(root = ""): Promise<FileSystemEntry[]> {
    const result: FileSystemEntry[] = [],
      pending = [root];
    while (pending.length) {
      const prefix = pending.pop()!;
      if (this.excluded(prefix)) continue;
      // A rename can happen between readdir and stat. Retry just this directory
      // so a partial snapshot does not report both names as absent.
      for (let attempt = 0; attempt < 2; attempt++) {
        let items;
        try {
          items = await readdir(
            prefix ? await this.target(prefix) : this.root,
            {
              withFileTypes: true,
            },
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
          throw error;
        }
        const entries: FileSystemEntry[] = [];
        let missing = false;
        for (const item of items) {
          if (
            item.isSymbolicLink() ||
            item.name === ".git" ||
            item.name === ".saddle" ||
            item.name.startsWith(".saddle-write-")
          )
            continue;
          const relative = prefix ? prefix + "/" + item.name : item.name;
          if (this.excluded(relative)) continue;
          const entry = await this.stat(relative);
          if (!entry) {
            missing = true;
            continue;
          }
          entries.push(entry);
        }
        if (missing && attempt === 0) continue;
        result.push(...entries);
        for (const entry of entries)
          if (entry.kind === "folder") pending.push(entry.path);
        break;
      }
    }
    return result;
  }
  async directories() {
    return (await this.scan())
      .filter((e) => e.kind === "folder")
      .map((e) => e.path)
      .sort();
  }
  async list() {
    return (await this.scan())
      .filter((e) => e.kind !== "folder")
      .map((e) => e.path)
      .sort();
  }
}
