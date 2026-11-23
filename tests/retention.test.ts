import { expect, it } from "vitest";
import * as A from "@automerge/automerge";
import { FileVault } from "../src/units/vault";
import {
  Companions,
  companionPath,
  contentName,
} from "../src/units/companions";
import { folderName } from "../src/units/folder-document";
import { CompanionFiles } from "./fixtures/companion-files";
import { utf8 } from "../src/crypto";

it("immediately prunes unshared folder and file versions when history is disabled, with no stale counts", async () => {
  const fs = new CompanionFiles(),
    vault = await FileVault.open(fs, "one");
  await vault.configure({ history: true, sync: true });
  await vault.createFolder("templates");
  const id = await vault.create("templates/Note.md", utf8.encode("first"));
  for (const value of ["second", "third"]) {
    const draft = vault.draft(id);
    draft.text = value;
    vault.release(await vault.save(draft));
    vault.release(draft);
    await vault.setFolderResource("templates", {
      name: "templates",
      data: [],
      metadata: { value },
    });
  }
  expect(vault.folderHistory("templates").length).toBeGreaterThan(1);
  const before = vault.version;
  await vault.configureScope("folder", "templates", { history: false });
  expect(vault.version).toBeGreaterThan(before);
  expect(vault.folderHistory("templates")).toEqual([]);
  expect(vault.folderHistoryVersionCount("templates")).toBe(0);
  expect(await vault.historyVersionCount(id)).toBe(0);
  const companions = new Companions(fs);
  expect(
    A.stats(A.load((await companions.read("templates", folderName))!))
      .numChanges,
  ).toBe(1);
  expect(
    A.stats(A.load((await companions.read("templates/Note.md", contentName))!))
      .numChanges,
  ).toBe(1);
  const reopened = await FileVault.open(fs, "two");
  expect(reopened.folderHistory("templates")).toEqual([]);
  await reopened.configureScope("folder", "templates", { history: true });
  expect(reopened.folderHistory("templates").length).toBeLessThanOrEqual(2);
  expect(
    reopened
      .folderHistory("templates")
      .every(
        (version) =>
          !new TextDecoder().decode(version.bytes).includes('"second"'),
      ),
  ).toBe(true);
});

it("creates no companion for Unset alone and removes an override-only companion when unset", async () => {
  const fs = new CompanionFiles(),
    vault = await FileVault.open(fs, "one");
  await vault.createFolder("plain");
  const id = await vault.create("plain/note.md", utf8.encode("ordinary"));
  await vault.configureScope("folder", "plain", {
    history: undefined,
    sync: undefined,
  });
  await vault.configureScope("file", id, {
    history: undefined,
    sync: undefined,
  });
  expect(fs.values.has(companionPath("plain"))).toBe(false);
  expect(fs.values.has(companionPath("plain/note.md"))).toBe(false);
  await vault.configureScope("folder", "plain", {
    history: false,
    sync: false,
  });
  expect(fs.values.has(companionPath("plain"))).toBe(true);
  await vault.configureScope("folder", "plain", {
    history: undefined,
    sync: undefined,
  });
  expect(fs.values.has(companionPath("plain"))).toBe(false);
});

it("notifies a new snapshot version for folder-only metadata writes and cleanup", async () => {
  const vault = await FileVault.open(new CompanionFiles(), "one");
  await vault.createFolder("templates");
  await vault.configureScope("folder", "templates", { history: true });
  const seen: number[] = [];
  vault.subscribe(() => seen.push(vault.version));
  const before = vault.version;
  await vault.setFolderResource("templates", {
    name: "templates",
    data: [],
    metadata: { changed: true },
  });
  expect(vault.version).toBeGreaterThan(before);
  expect(seen.at(-1)).toBe(vault.version);
  await vault.configureScope("folder", "templates", { history: undefined });
  expect(vault.folderHistoryVersionCount("templates")).toBe(0);
  expect(seen.at(-1)).toBe(vault.version);
});

it("allows equal concurrent Disabled assignments to compact while retaining distinct conflicting data", async () => {
  const { hasDistinctConflicts } = await import("../src/units/history");
  const base = A.from({ retainHistory: true, text: "base" });
  const left = A.change(A.clone(base), (value) => {
    value.retainHistory = false;
  });
  const right = A.change(A.clone(base), (value) => {
    value.retainHistory = false;
  });
  const identical = A.merge(left, right);
  expect(Object.keys(A.getConflicts(identical, "retainHistory")!)).toHaveLength(
    2,
  );
  expect(hasDistinctConflicts(identical)).toBe(false);
  const a = A.change(A.clone(base), (value) => {
    value.text = "left";
  });
  const b = A.change(A.clone(base), (value) => {
    value.text = "right";
  });
  expect(hasDistinctConflicts(A.merge(a, b))).toBe(true);
});

it("cleans an explicitly disabled folder on reopen without relying on another feature edit", async () => {
  const fs = new CompanionFiles(),
    vault = await FileVault.open(fs, "one");
  await vault.configure({ history: true });
  await vault.createFolder("templates");
  await vault.setFolderResource("templates", {
    name: "templates",
    data: [],
    metadata: { revision: "one" },
  });
  await vault.setFolderResource("templates", {
    name: "templates",
    data: [],
    metadata: { revision: "two" },
  });
  expect(vault.folderHistory("templates").length).toBeGreaterThan(1);
  await vault.companions.updateDescriptor("templates", (previous) => ({
    ...previous!,
    features: { history: false },
  }));
  const reopened = await FileVault.open(fs, "two");
  expect(reopened.folderHistory("templates")).toEqual([]);
  expect(
    await reopened.companions.read("templates", folderName),
  ).toBeUndefined();
});

it("keeps distinct current data conflicts when history is disabled, then drops the archive after resolution", async () => {
  const vault = await FileVault.open(new CompanionFiles(), "one");
  await vault.configure({ history: true });
  const id = await vault.create("note.md", utf8.encode("content"));
  const base = vault.doc(id);
  const left = A.change(A.clone(base), (doc) => {
    doc.mime = "text/x-left";
  });
  const right = A.change(A.clone(base), (doc) => {
    doc.mime = "text/x-right";
  });
  await vault.receiveDocument(id, A.save(left));
  await vault.receiveDocument(id, A.save(right));
  expect(Object.keys(A.getConflicts(vault.doc(id), "mime")!)).toHaveLength(2);
  await vault.configureScope("file", id, { history: false });
  expect(await vault.companions.read("note.md", contentName)).toBeDefined();
  expect(await vault.historyVersionCount(id)).toBe(0);
  const resolved = A.change(A.clone(vault.doc(id)), (doc) => {
    doc.mime = "text/markdown";
  });
  await vault.receiveDocument(id, A.save(resolved));
  expect(await vault.companions.read("note.md", contentName)).toBeUndefined();
});
