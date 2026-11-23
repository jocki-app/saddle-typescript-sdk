import type { VaultFileSystem } from "./contracts.js";

/** Explicit app-owned namespace; it never lives under a mounted content root. */
export function localFiles(
  fs: VaultFileSystem,
  prefix: string,
): VaultFileSystem {
  return {
    read: (path) => fs.read(prefix + "/" + path),
    writeAtomic: (path, bytes) => fs.writeAtomic(prefix + "/" + path, bytes),
    remove: (path) => fs.remove(prefix + "/" + path),
    list: async () =>
      (fs.scan
        ? (await fs.scan(prefix)).map((entry) => entry.path)
        : await fs.list()
      )
        .filter((p) => p.startsWith(prefix + "/"))
        .map((p) => p.slice(prefix.length + 1)),
  };
}

/** In-memory hosts may omit device storage. Production hosts supply durable state. */
const memory = new WeakMap<VaultFileSystem, Map<string, Uint8Array>>();
export function memoryLocalFiles(owner: VaultFileSystem): VaultFileSystem {
  let entries = memory.get(owner);
  if (!entries) memory.set(owner, (entries = new Map()));
  const files = entries;
  return {
    read: async (p) => files.get(p)?.slice(),
    writeAtomic: async (p, b) => {
      files.set(p, b.slice());
    },
    remove: async (p) => {
      files.delete(p);
    },
    list: async () => [...files.keys()],
  };
}
