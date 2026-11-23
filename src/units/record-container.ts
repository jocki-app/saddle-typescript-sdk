import * as A from "@automerge/automerge";
import type { VaultFileSystem } from "../filesystem.js";
import { filePath } from "../filesystem.js";
import { digest, fromHex, text, utf8 } from "../crypto.js";

// The only on-disk format: magic, two independently checksummed commit slots,
// immutable record chunks, and a small JSON index. Publishing a slot is the commit.
const magic = utf8.encode("SADDLE01"),
  headerSize = 144,
  slotSize = 68;
type Chunk = { offset: number; length: number; hash: string };
type DocumentIndex = { heads?: string[]; numChanges?: number };
type RecordEntry = DocumentIndex & { chunks: Chunk[] };
type Index = Record<string, RecordEntry>;
type Commit = { generation: number; end: number; index: Index; slot: number };
const changeCounts = new WeakMap<
  VaultFileSystem,
  Map<string, { stamp: string; count: number }>
>();
const queues = new WeakMap<VaultFileSystem, Map<string, Promise<unknown>>>();
const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i]);
const view = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const validNumber = (v: number) => Number.isSafeInteger(v) && v >= 0;
async function checksum(bytes: Uint8Array) {
  return fromHex(await digest(bytes));
}

/** A capability for named records inside one file; never exposes its parent. */
export class RecordFiles implements VaultFileSystem {
  constructor(
    private readonly fs: VaultFileSystem,
    readonly container: string,
  ) {
    filePath(container);
  }
  private async range(offset: number, length: number) {
    if (this.fs.readRange) {
      if (length <= 1024 * 1024)
        return this.fs.readRange(this.container, offset, length);
      const result = new Uint8Array(length);
      for (let at = 0; at < length; at += 1024 * 1024) {
        const bytes = await this.fs.readRange(
          this.container,
          offset + at,
          Math.min(length - at, 1024 * 1024),
        );
        if (!bytes) return;
        result.set(bytes, at);
        if (bytes.length < Math.min(length - at, 1024 * 1024))
          return result.subarray(0, at + bytes.length);
      }
      return result;
    }
    return (await this.fs.read(this.container))?.slice(offset, offset + length);
  }
  private async commit(): Promise<Commit | undefined> {
    const header = await this.range(0, headerSize);
    if (!header) return;
    if (header.length !== headerSize || !same(header.subarray(0, 8), magic))
      throw Error("Invalid SADDLE binary container");
    const slots: Array<{
      generation: number;
      offset: number;
      length: number;
      end: number;
      hash: Uint8Array;
      slot: number;
    }> = [];
    for (let slot = 0; slot < 2; slot++) {
      const bytes = header.subarray(
          8 + slot * slotSize,
          8 + (slot + 1) * slotSize,
        ),
        v = view(bytes);
      if (!same(await checksum(bytes.subarray(0, 36)), bytes.subarray(36)))
        continue;
      const generation = Number(v.getBigUint64(0, true)),
        offset = Number(v.getBigUint64(8, true)),
        length = v.getUint32(16, true),
        end = Number(v.getBigUint64(20, true));
      if (
        ![generation, offset, length, end].every(validNumber) ||
        !generation ||
        offset < headerSize ||
        length > 16 * 1024 * 1024 ||
        offset + length !== end
      )
        continue;
      slots.push({
        generation,
        offset,
        length,
        end,
        hash: bytes.subarray(28, 36),
        slot,
      });
    }
    for (const slot of slots.sort((a, b) => b.generation - a.generation)) {
      const bytes = await this.range(slot.offset, slot.length);
      if (
        !bytes ||
        bytes.length !== slot.length ||
        !same((await checksum(bytes)).subarray(0, 8), slot.hash)
      )
        continue;
      const index = JSON.parse(text.decode(bytes)) as Index;
      if (!index || typeof index !== "object" || Array.isArray(index))
        throw Error("Invalid SADDLE record index");
      for (const [name, entry] of Object.entries(index)) {
        filePath(name);
        if (
          !entry ||
          !Array.isArray(entry.chunks) ||
          entry.chunks.some(
            (c) =>
              !validNumber(c.offset) ||
              !validNumber(c.length) ||
              c.offset < headerSize ||
              c.offset + c.length > slot.offset ||
              !/^[a-f0-9]{64}$/.test(c.hash),
          ) ||
          (entry.numChanges !== undefined && !validNumber(entry.numChanges)) ||
          (entry.heads &&
            (!Array.isArray(entry.heads) ||
              entry.heads.some((h) => typeof h !== "string")))
        )
          throw Error("Invalid SADDLE record extent");
      }
      return {
        generation: slot.generation,
        end: slot.end,
        index,
        slot: slot.slot,
      };
    }
    throw Error("SADDLE container has no intact commit");
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    let paths = queues.get(this.fs);
    if (!paths) queues.set(this.fs, (paths = new Map()));
    const prior = paths.get(this.container) ?? Promise.resolve();
    const next = prior.then(operation, operation);
    paths.set(this.container, next);
    void next
      .finally(() => {
        if (paths!.get(this.container) === next) paths!.delete(this.container);
      })
      .catch(() => {});
    return next;
  }
  read(name: string) {
    return this.serialize(() => this.readRecord(name));
  }
  private async readRecord(name: string) {
    filePath(name);
    const index = (await this.commit())?.index;
    const entry = index && Object.hasOwn(index, name) ? index[name] : undefined;
    if (!entry) return;
    const chunks: Uint8Array[] = [];
    for (const c of entry.chunks) {
      const bytes = await this.range(c.offset, c.length);
      if (
        !bytes ||
        bytes.length !== c.length ||
        (await digest(bytes)) !== c.hash
      )
        throw Error(`Damaged SADDLE record: ${name}`);
      chunks.push(bytes);
    }
    const result = new Uint8Array(chunks.reduce((n, b) => n + b.length, 0));
    let offset = 0;
    for (const bytes of chunks) {
      result.set(bytes, offset);
      offset += bytes.length;
    }
    return result;
  }
  heads(name: string) {
    return this.serialize(
      async () => (await this.commit())?.index[name]?.heads,
    );
  }
  /** Saved document statistics are in the small index, not in its content chunks. */
  documentChanges(name: string): Promise<number> {
    filePath(name);
    return this.serialize(async () => {
      const index = (await this.commit())?.index;
      const entry =
        index && Object.hasOwn(index, name) ? index[name] : undefined;
      if (!entry) return 0;
      if (entry.numChanges !== undefined) return entry.numChanges;
      // Raw archive writes have no document metadata. Derive once per content stamp.
      const stamp = entry.chunks.map((chunk) => chunk.hash).join(":");
      let cache = changeCounts.get(this.fs);
      if (!cache) changeCounts.set(this.fs, (cache = new Map()));
      const key = `${this.container}\0${name}`;
      const cached = cache.get(key);
      if (cached?.stamp === stamp) return cached.count;
      const bytes = await this.readRecord(name);
      if (!bytes) return 0;
      const doc = A.load(bytes);
      try {
        const count = A.stats(doc).numChanges;
        cache.set(key, { stamp, count });
        return count;
      } finally {
        A.free(doc);
      }
    });
  }
  async writeAtomic(name: string, bytes: Uint8Array) {
    await this.update(name, bytes);
  }
  async update(
    name: string,
    bytes:
      | Uint8Array
      | undefined
      | ((
          entry: RecordEntry | undefined,
        ) =>
          | ({ bytes: Uint8Array; append?: boolean } & DocumentIndex)
          | Promise<{ bytes: Uint8Array; append?: boolean } & DocumentIndex>),
    options: { append?: boolean } & DocumentIndex = {},
  ) {
    filePath(name);
    await this.serialize(async () => {
      const prior = await this.commit(),
        index: Index = Object.assign(Object.create(null), prior?.index),
        offset = prior?.end ?? headerSize;
      if (typeof bytes === "function") {
        const next = await bytes(index[name]);
        bytes = next.bytes;
        options = next;
      }
      if (bytes) {
        const hash = await digest(bytes),
          existing = index[name];
        if (
          options.append &&
          !bytes.length &&
          existing?.numChanges === options.numChanges &&
          JSON.stringify(existing?.heads) === JSON.stringify(options.heads)
        )
          return;
        if (
          !options.append &&
          existing?.chunks.length === 1 &&
          existing.chunks[0].hash === hash &&
          existing.numChanges === options.numChanges &&
          JSON.stringify(existing.heads) === JSON.stringify(options.heads)
        )
          return;
        index[name] = {
          chunks: [
            ...(options.append ? (existing?.chunks ?? []) : []),
            { offset, length: bytes.length, hash },
          ],
          ...(options.heads ? { heads: options.heads } : {}),
          ...(options.numChanges !== undefined
            ? { numChanges: options.numChanges }
            : {}),
        };
      } else {
        if (!index[name]) return;
        delete index[name];
      }
      const live = Object.values(index).reduce(
        (n, entry) =>
          n + entry.chunks.reduce((size, chunk) => size + chunk.length, 0),
        0,
      );
      // Deletion/epoch replacement must actually discard pruned history bytes.
      // Bounded waste compaction also prevents repeated metadata edits growing forever.
      if (
        prior &&
        (!bytes ||
          (name.endsWith(".automerge") && !options.append) ||
          (offset > 8 * 1024 * 1024 && live < offset / 2))
      ) {
        const records: Array<[string, Uint8Array, DocumentIndex]> = [];
        for (const [key, entry] of Object.entries(index)) {
          const chunks: Uint8Array[] = [];
          for (const chunk of entry.chunks) {
            const data =
              bytes && chunk.offset === offset
                ? bytes
                : await this.range(chunk.offset, chunk.length);
            if (
              !data ||
              data.length !== chunk.length ||
              (await digest(data)) !== chunk.hash
            )
              throw Error("Damaged record during compaction");
            chunks.push(data);
          }
          const data = new Uint8Array(
            chunks.reduce((n, chunk) => n + chunk.length, 0),
          );
          let at = 0;
          for (const chunk of chunks) {
            data.set(chunk, at);
            at += chunk.length;
          }
          records.push([
            key,
            data,
            { heads: entry.heads, numChanges: entry.numChanges },
          ]);
        }
        let at = headerSize;
        const compact: Index = Object.create(null);
        for (const [key, data, metadata] of records) {
          compact[key] = {
            chunks: [
              { offset: at, length: data.length, hash: await digest(data) },
            ],
            ...metadata,
          };
          at += data.length;
        }
        const encoded = utf8.encode(JSON.stringify(compact)),
          result = new Uint8Array(at + encoded.length),
          slot = new Uint8Array(slotSize),
          v = view(slot);
        result.set(magic);
        let cursor = headerSize;
        for (const [, data] of records) {
          result.set(data, cursor);
          cursor += data.length;
        }
        result.set(encoded, at);
        v.setBigUint64(0, BigInt(prior.generation + 1), true);
        v.setBigUint64(8, BigInt(at), true);
        v.setUint32(16, encoded.length, true);
        v.setBigUint64(20, BigInt(result.length), true);
        slot.set((await checksum(encoded)).subarray(0, 8), 28);
        slot.set(await checksum(slot.subarray(0, 36)), 36);
        result.set(slot, 8);
        await this.fs.writeAtomic(this.container, result);
        return;
      }
      const encoded = utf8.encode(JSON.stringify(index)),
        at = offset + (bytes?.length ?? 0),
        end = at + encoded.length;
      if (encoded.length > 16 * 1024 * 1024)
        throw Error("SADDLE record index is too large");
      const slot = new Uint8Array(slotSize),
        v = view(slot);
      v.setBigUint64(0, BigInt((prior?.generation ?? 0) + 1), true);
      v.setBigUint64(8, BigInt(at), true);
      v.setUint32(16, encoded.length, true);
      v.setBigUint64(20, BigInt(end), true);
      slot.set((await checksum(encoded)).subarray(0, 8), 28);
      slot.set(await checksum(slot.subarray(0, 36)), 36);
      const which = prior ? 1 - prior.slot : 0;
      if (prior && this.fs.writeAt) {
        // Data and index are flushed before the independently durable commit slot.
        const tail = new Uint8Array(end - offset);
        if (bytes) tail.set(bytes);
        tail.set(encoded, at - offset);
        await this.fs.writeAt(this.container, offset, tail);
        await this.fs.writeAt(this.container, 8 + which * slotSize, slot);
      } else {
        const result = new Uint8Array(end);
        if (prior) {
          const old = await this.fs.read(this.container);
          if (!old)
            throw Error("SADDLE container disappeared during update");
          result.set(old.subarray(0, offset));
        } else result.set(magic);
        if (bytes) result.set(bytes, offset);
        result.set(encoded, at);
        result.set(slot, 8 + which * slotSize);
        await this.fs.writeAtomic(this.container, result);
      }
    });
  }
  async updateJSON<T>(name: string, change: (value: T | undefined) => T) {
    await this.update(name, async () => {
      const previous = await this.readRecord(name);
      const value = change(
        previous ? (JSON.parse(text.decode(previous)) as T) : undefined,
      );
      return { bytes: utf8.encode(JSON.stringify(value, null, 2) + "\n") };
    });
  }
  async removeIfOnly(
    names: string[],
    allowed: (
      read: (name: string) => Promise<Uint8Array | undefined>,
    ) => Promise<boolean>,
  ) {
    return this.serialize(async () => {
      const commit = await this.commit();
      if (
        commit &&
        Object.keys(commit.index).every((name) => names.includes(name)) &&
        (await allowed((name) => this.readRecord(name)))
      ) {
        await this.fs.remove(this.container);
        return true;
      }
      return false;
    });
  }
  async saveDocument<T>(name: string, doc: A.Doc<T>) {
    await this.update(name, (entry) => {
      const append = !!entry?.heads && A.hasHeads(doc, entry.heads);
      return {
        bytes: append ? A.saveSince(doc, entry!.heads!) : A.save(doc),
        append,
        heads: A.getHeads(doc),
        numChanges: A.stats(doc).numChanges,
      };
    });
  }
  async remove(name: string) {
    await this.update(name, undefined);
  }
  list() {
    return this.serialize(async () =>
      Object.keys((await this.commit())?.index ?? {}),
    );
  }
  stat(name: string) {
    return this.serialize(() => this.recordStat(name));
  }
  private async recordStat(name: string) {
    const index = (await this.commit())?.index;
    const entry = index && Object.hasOwn(index, name) ? index[name] : undefined;
    return entry
      ? {
          path: name,
          kind: "file" as const,
          size: entry.chunks.reduce((n, c) => n + c.length, 0),
          stamp: entry.chunks.map((c) => c.hash).join(":"),
        }
      : undefined;
  }
}

/** A single raw sibling file, addressed by one fixed virtual name. */
export class SingleFile implements VaultFileSystem {
  constructor(
    private fs: VaultFileSystem,
    private path: string,
  ) {}
  private check(name: string) {
    if (name !== "container")
      throw Error("Invalid unit-container capability path");
  }
  async read(name: string) {
    this.check(name);
    return this.fs.read(this.path);
  }
  async writeAtomic(name: string, bytes: Uint8Array) {
    this.check(name);
    await this.fs.writeAtomic(this.path, bytes);
  }
  async remove(name: string) {
    this.check(name);
    await this.fs.remove(this.path);
  }
  async list() {
    return (await this.fs.stat?.(this.path)) ? ["container"] : [];
  }
  async stat(name: string) {
    this.check(name);
    const entry = await this.fs.stat?.(this.path);
    return entry && { ...entry, path: name };
  }
  get readRange() {
    return this.fs.readRange
      ? async (name: string, offset: number, length: number) => {
          this.check(name);
          return this.fs.readRange!(this.path, offset, length);
        }
      : undefined;
  }
  get writeAt() {
    return this.fs.writeAt
      ? async (name: string, offset: number, bytes: Uint8Array) => {
          this.check(name);
          await this.fs.writeAt!(this.path, offset, bytes);
        }
      : undefined;
  }
}
