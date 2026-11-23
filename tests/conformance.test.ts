import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { RecordFiles } from "../src/units/record-container";
import { parseResource, importMetadata } from "../src/units/metadata";
import { CompanionFiles } from "./fixtures/companion-files";
const root = new URL("../conformance/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("source.json", root), "utf8"));
const load = (name: string) =>
  JSON.parse(readFileSync(new URL(`v1/${name}.json`, root), "utf8")).cases;
it("pins the canonical specification fixtures without network access", () => {
  expect(manifest.revision).toMatch(/^[0-9a-f]{40}$/);
  for (const [name, hash] of Object.entries(manifest.sha256))
    expect(
      createHash("sha256")
        .update(readFileSync(new URL(`v1/${name}`, root)))
        .digest("hex"),
    ).toBe(hash);
});
for (const c of load("containers"))
  it(`container conformance: ${c.name}`, async () => {
    const fs = new CompanionFiles();
    await fs.writeAtomic(
      ".fixture.saddle",
      new Uint8Array(Buffer.from(c.archive, "base64")),
    );
    const records = new RecordFiles(fs, ".fixture.saddle");
    const verify = async () => {
      const names = await records.list();
      for (const name of names) await records.read(name);
      return names;
    };
    if (!c.valid) {
      await expect(verify()).rejects.toThrow();
      return;
    }
    expect((await verify()).sort()).toEqual(Object.keys(c.records).sort());
    for (const [name, value] of Object.entries(c.records))
      expect(Buffer.from((await records.read(name))!).toString("base64")).toBe(
        value,
      );
    expect(await records.read("missing")).toBeUndefined();
  });
for (const c of load("resources"))
  it(`resource conformance: ${c.name}`, () => {
    if (c.valid)
      expect(parseResource(JSON.stringify(c.value))).toEqual(c.value);
    else expect(() => parseResource(JSON.stringify(c.value))).toThrow();
  });
for (const c of load("frontmatter"))
  it(`frontmatter conformance: ${c.name}`, () => {
    const run = () =>
      importMetadata(
        "note.md",
        "text/markdown",
        c.source,
        c.descriptor ?? null,
      );
    if (c.invalid) expect(run).toThrow();
    else expect(run().properties).toEqual(c.properties);
  });
