import { it, expect, vi } from "vitest";
import { mkdtemp, writeFile, readFile, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as A from "@automerge/automerge";
import { operate } from "../src/node/operations";
import { NodeVaultFiles } from "../src/node/vault-files";
import { RecordFiles } from "../src/units/record-container";
it("keeps private runtime profiles out of an opened folder's history", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "saddle-operations-")),
    root = path.join(parent, "files"),
    profile = path.join(root, "private");
  const fs = await NodeVaultFiles.open(root);
  try {
    await writeFile(path.join(root, "note.md"), "hello");
    await operate({
      method: "history.configure",
      target: root,
      state: "enabled",
      profile,
    });
    const records = new RecordFiles(
      await NodeVaultFiles.open(parent),
      ".files.saddle",
    );
    const folder = A.load<{ children: Record<string, { name: string }> }>(
      (await records.read("folder.automerge"))!,
    );
    try {
      expect(Object.values(folder.children).map((child) => child.name)).toEqual(
        ["note.md"],
      );
    } finally {
      A.free(folder);
    }
    expect((await lstat(profile)).isDirectory()).toBe(true);
    expect(
      (
        (await operate({
          method: "unit.inspect",
          target: path.join(root, "note.md"),
          profile,
        })) as any
      ).features.history,
    ).toBe(false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

it("serves external edits until cancellation, excludes private profiles and releases its writer lease", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "saddle-serving-")),
    root = path.join(parent, "files"),
    profile = path.join(root, "private");
  const fs = await NodeVaultFiles.open(root),
    controller = new AbortController();
  let serving: Promise<unknown> | undefined;
  try {
    await writeFile(path.join(root, "note.md"), "before");
    await operate({
      method: "history.configure",
      target: root,
      state: "enabled",
      profile,
    });
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    serving = operate(
      { method: "sharing.serve", target: root, profile },
      { signal: controller.signal, onReady: ready },
    );
    await Promise.race([
      started,
      serving.then(() => {
        throw Error("Service exited before ready");
      }),
    ]);
    await writeFile(path.join(root, "note.md"), "after");
    const records = new RecordFiles(fs, ".note.md.saddle");
    await expect
      .poll(
        async () => {
          const bytes = await records.read("content.automerge");
          if (!bytes) return null;
          const doc = A.load<{ text: string }>(bytes);
          try {
            return doc.text;
          } finally {
            A.free(doc);
          }
        },
        { timeout: 10000 },
      )
      .toBe("after");
    controller.abort();
    await serving;
    expect(
      await records.documentChanges("content.automerge"),
    ).toBeGreaterThanOrEqual(2);
    const unlock = await fs.acquireWriter();
    await unlock();
  } finally {
    controller.abort();
    await serving;
    await rm(parent, { recursive: true, force: true });
  }
}, 20000);
it("returns a public contact without enabling a file feature and rejects malformed archive input", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "saddle-contact-"));
  try {
    const target = path.join(parent, "note.md");
    await writeFile(target, "hello");
    const result = (await operate({
      method: "sharing.contact",
      target,
      profile: path.join(parent, "profile"),
    })) as { contact: string };
    expect(typeof result.contact).toBe("string");
    expect(
      (
        (await operate({
          method: "unit.inspect",
          target,
          profile: path.join(parent, "profile"),
        })) as any
      ).features.sync,
    ).toBe(false);
    await expect(
      operate({
        method: "archive.put",
        target,
        record: "resource.json",
        bytes: "invalid%",
      }),
    ).rejects.toThrow("base64");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

it("rejects unknown operations before opening a filesystem capability", async () => {
  await expect(
    operate({
      method: "execute",
      target: "/unavailable-target",
      profile: "/unavailable-profile",
    }),
  ).rejects.toThrow("Unknown SADDLE operation");
});
it("opens a selected file without scanning any sibling tree", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "saddle-file-scan-"));
  const original = NodeVaultFiles.prototype.scan;
  const scan = vi
    .spyOn(NodeVaultFiles.prototype, "scan")
    .mockImplementation(async function (this: NodeVaultFiles, ...args) {
      if (this.root === parent) throw Error("Unexpected sibling tree scan");
      return original.apply(this, args);
    });
  try {
    const target = path.join(parent, "note.md");
    await writeFile(target, "hello");
    const result = (await operate({
      method: "unit.inspect",
      target,
      profile: path.join(parent, "profile"),
    })) as any;
    expect(result.kind).toBe("file");
    expect(scan.mock.contexts.every((files) => files.root !== parent)).toBe(
      true,
    );
  } finally {
    scan.mockRestore();
    await rm(parent, { recursive: true, force: true });
  }
});
