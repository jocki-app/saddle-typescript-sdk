import { expect, it, vi } from "vitest";
import * as A from "@automerge/automerge";
import { RecordFiles } from "../src/units/record-container";
import { CompanionFiles } from "./fixtures/companion-files";
import { text, utf8 } from "../src/crypto";

it("keeps named binary records independent, preserves unknown records and serializes writers", async () => {
  const fs = new CompanionFiles(),
    a = new RecordFiles(fs, ".note.md.saddle"),
    b = new RecordFiles(fs, ".note.md.saddle");
  await Promise.all([
    a.writeAtomic("descriptor.json", utf8.encode("descriptor")),
    b.writeAtomic("plugin/example", new Uint8Array([0, 255])),
  ]);
  expect(text.decode(await a.read("descriptor.json"))).toBe("descriptor");
  expect(await b.read("plugin/example")).toEqual(new Uint8Array([0, 255]));
  expect(
    text.decode((await fs.read(".note.md.saddle"))!.subarray(0, 8)),
  ).toBe("SADDLE01");
  await a.remove("descriptor.json");
  expect(await a.list()).toEqual(["plugin/example"]);
});
it("recovers the previous commit after a torn slot, and rejects damaged payloads and foreign formats", async () => {
  const fs = new CompanionFiles(),
    records = new RecordFiles(fs, ".f.saddle");
  await records.writeAtomic("metadata", utf8.encode("first"));
  await records.writeAtomic("metadata", utf8.encode("second"));
  const bytes = fs.values.get(".f.saddle")!;
  bytes[8 + 68 + 36] ^= 1;
  expect(text.decode(await records.read("metadata"))).toBe("first");
  bytes[144] ^= 1;
  await expect(records.read("metadata")).rejects.toThrow("Damaged");
  await fs.writeAtomic(".foreign.saddle", utf8.encode('{"format":1}'));
  await expect(
    new RecordFiles(fs, ".foreign.saddle").list(),
  ).rejects.toThrow("Invalid SADDLE binary");
});
it("appends Automerge changes, reads only requested ranges and durably prunes deleted history", async () => {
  const fs = new CompanionFiles(),
    records = new RecordFiles(fs, ".file.saddle");
  let doc = A.from({ text: "a".repeat(30000) });
  await records.saveDocument("content.automerge", doc);
  const initial = fs.values.get(".file.saddle")!.length;
  const fullRead = vi.spyOn(fs, "read"),
    positioned = vi.spyOn(fs, "writeAt");
  doc = A.change(doc, (d) => A.splice(d, ["text"], 10, 0, "more"));
  await records.saveDocument("content.automerge", doc);
  expect(positioned).toHaveBeenCalledTimes(2);
  expect(fullRead).not.toHaveBeenCalled();
  expect(
    A.load<{ text: string }>((await records.read("content.automerge"))!).text,
  ).toBe(doc.text);
  const size = fs.values.get(".file.saddle")!.length;
  await records.saveDocument("content.automerge", doc);
  expect(fs.values.get(".file.saddle")!.length).toBe(size);
  await records.remove("content.automerge");
  expect(await records.list()).toEqual([]);
  expect(fs.values.get(".file.saddle")!.length).toBeLessThan(initial);
});
it("acknowledges only after both durable writes and leaves the previous index intact on failure", async () => {
  const fs = new CompanionFiles(),
    records = new RecordFiles(fs, ".file.saddle");
  await records.writeAtomic("value", utf8.encode("before"));
  const write = fs.writeAt.bind(fs);
  let writes = 0;
  fs.writeAt = async (...args) => {
    if (++writes === 2) throw Error("Interrupted commit");
    await write(...args);
  };
  await expect(
    records.writeAtomic("value", utf8.encode("after")),
  ).rejects.toThrow("Interrupted commit");
  expect(
    text.decode(await new RecordFiles(fs, ".file.saddle").read("value")),
  ).toBe("before");
});

it("keeps version counts atomic with saved archives and reads them without content chunks", async () => {
  const fs = new CompanionFiles(),
    records = new RecordFiles(fs, ".count.saddle");
  let doc = A.from({ text: "large".repeat(10000) });
  await records.saveDocument("content.automerge", doc);
  doc = A.change(doc, (d) => {
    d.text += "second";
  });
  await records.saveDocument("content.automerge", doc);
  const read = vi.spyOn(fs, "readRange");
  expect(await records.documentChanges("content.automerge")).toBe(2);
  expect(read.mock.calls.every(([, offset]) => offset !== 144)).toBe(true);
  expect(read.mock.calls).toHaveLength(2); // Header and index only.
  await records.writeAtomic("metadata", utf8.encode("temporary"));
  await records.remove("metadata"); // Compaction must preserve the statistic.
  expect(await records.documentChanges("content.automerge")).toBe(2);
  const write = fs.writeAt.bind(fs);
  let writes = 0;
  fs.writeAt = async (...args) => {
    if (++writes === 2) throw Error("Interrupted commit");
    await write(...args);
  };
  doc = A.change(doc, (d) => {
    d.text += "uncommitted";
  });
  await expect(records.saveDocument("content.automerge", doc)).rejects.toThrow(
    "Interrupted commit",
  );
  expect(
    await new RecordFiles(fs, ".count.saddle").documentChanges(
      "content.automerge",
    ),
  ).toBe(2);
  fs.writeAt = write;
  await records.saveDocument("content.automerge", A.from({ text: "pruned" }));
  expect(await records.documentChanges("content.automerge")).toBe(1);
  await records.remove("content.automerge");
  expect(await records.documentChanges("content.automerge")).toBe(0);
});

it("caches raw archive counts per content stamp and invalidates on replacement", async () => {
  const fs = new CompanionFiles(),
    records = new RecordFiles(fs, ".raw.saddle");
  let doc = A.from({ text: "first" });
  await records.writeAtomic("content.automerge", A.save(doc));
  expect(await records.documentChanges("content.automerge")).toBe(1);
  const read = vi.spyOn(fs, "readRange");
  expect(
    await new RecordFiles(fs, ".raw.saddle").documentChanges(
      "content.automerge",
    ),
  ).toBe(1);
  expect(read.mock.calls).toHaveLength(2);
  doc = A.change(doc, (d) => {
    d.text = "next";
  });
  await records.writeAtomic("content.automerge", A.save(doc));
  expect(await records.documentChanges("content.automerge")).toBe(2);
});
