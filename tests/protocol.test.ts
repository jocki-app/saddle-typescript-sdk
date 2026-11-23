import { it, expect } from "vitest";
import { MessageChannel } from "node:worker_threads";
import { MessageChannelNetworkAdapter } from "@automerge/automerge-repo-network-messagechannel";
import type {
  StorageAdapterInterface,
  StorageKey,
} from "@automerge/automerge-repo";
import { Repository } from "../src/repository";
import { FileVault } from "../src/units/vault";
import { ProtectedFileSync } from "../src/units/protected-sync";
import { WorkspaceStore } from "../src/units/workspace";
import { shareLink } from "../src/units/share-invitation";
import { CompanionFiles } from "./fixtures/companion-files";
import { utf8 } from "../src/crypto";
class Store implements StorageAdapterInterface {
  values = new Map<string, Uint8Array>();
  async load(key: StorageKey) {
    return this.values.get(JSON.stringify(key))?.slice();
  }
  async save(key: StorageKey, data: Uint8Array) {
    this.values.set(JSON.stringify(key), data.slice());
  }
  async saveBatch(entries: Array<[StorageKey, Uint8Array]>) {
    for (const [key, data] of entries) await this.save(key, data);
  }
  async remove(key: StorageKey) {
    this.values.delete(JSON.stringify(key));
  }
  async loadRange(prefix: StorageKey) {
    return [...this.values].flatMap(([encoded, data]) => {
      const key = JSON.parse(encoded) as StorageKey;
      return prefix.every((v, i) => key[i] === v)
        ? [{ key, data: data.slice() }]
        : [];
    });
  }
  async removeRange(prefix: StorageKey) {
    for (const row of await this.loadRange(prefix)) await this.remove(row.key);
  }
}
function connect(a: Repository, b: Repository) {
  const { port1, port2 } = new MessageChannel();
  const left = a.hive.createKeyhiveNetworkAdapter(
    new MessageChannelNetworkAdapter(port1 as unknown as MessagePort),
    { periodicallyRequestSync: true, syncRequestInterval: 100 },
  );
  const right = b.hive.createKeyhiveNetworkAdapter(
    new MessageChannelNetworkAdapter(port2 as unknown as MessagePort),
    { periodicallyRequestSync: true, syncRequestInterval: 100 },
  );
  left.on("ingest-remote", () => a.repo.shareConfigChanged());
  right.on("ingest-remote", () => b.repo.shareConfigChanged());
  a.repo.networkSubsystem.addNetworkAdapter(left);
  b.repo.networkSubsystem.addNetworkAdapter(right);
  return () => {
    left.disconnect();
    right.disconnect();
    port1.close();
    port2.close();
  };
}
async function pair(run: (c: any) => Promise<void>) {
  const a = await Repository.open({
    documents: new Store(),
    identity: new Store(),
    endpoints: [],
  });
  const b = await Repository.open({
    documents: new Store(),
    identity: new Store(),
    endpoints: [],
  });
  const source = await FileVault.open(new CompanionFiles(), "one"),
    target = await FileVault.open(new CompanionFiles(), "two");
  await source.configure({ history: true });
  const errors: unknown[] = [];
  const one = await ProtectedFileSync.open(
    a,
    new CompanionFiles(),
    await WorkspaceStore.open(new CompanionFiles(), "one"),
    (e) => errors.push(e),
  );
  const two = await ProtectedFileSync.open(
    b,
    new CompanionFiles(),
    await WorkspaceStore.open(new CompanionFiles(), "two"),
    (e) => errors.push(e),
  );
  await one.attach(source);
  await two.attach(target);
  let disconnect = connect(a, b);
  try {
    await run({
      a,
      b,
      source,
      target,
      one,
      two,
      errors,
      disconnect: () => disconnect(),
      reconnect: () => {
        disconnect();
        disconnect = connect(a, b);
      },
    });
  } finally {
    disconnect();
    await one.close();
    await two.close();
    await a.close();
    await b.close();
  }
}
it(
  "exchanges file bytes and resource metadata under an explicit edit grant",
  async () =>
    pair(async ({ b, source, target, one, two, errors }) => {
      const id = await source.create("note.md", utf8.encode("first"));
      const invitation = await one.create(source, "file", "note.md");
      await one.grant(invitation, b.contactCard, "edit");
      await two.join(shareLink(invitation), target);
      const draft = source.draft(id);
      draft.text = "second";
      draft.resource = {
        name: "note",
        path: "note.md",
        metadata: { topic: "work" },
      };
      source.release(await source.save(draft));
      source.release(draft);
      await expect
        .poll(() => target.doc(id).text, { timeout: 15000 })
        .toBe("second");
      await expect
        .poll(() => target.doc(id).resource?.metadata?.topic, {
          timeout: 15000,
        })
        .toBe("work");
      expect(errors).toEqual([]);
    }),
  45000,
);
it(
  "binds invitations to the authenticated scope and refuses read-only history rewrites",
  async () =>
    pair(async ({ b, source, target, one, two }) => {
      const id = await source.create("note.md", utf8.encode("private"));
      const invitation = await one.create(source, "file", "note.md");
      await one.grant(invitation, b.contactCard, "read");
      await two.join(shareLink(invitation), target);
      await expect(
        two.join(shareLink({ ...invitation, kind: "workspace" }), target),
      ).rejects.toThrow();
      await expect(
        two.rewriteHistory(target, { id }, { kind: "reset", time: 100 }),
      ).rejects.toThrow("Editing access");
    }),
  45000,
);
it(
  "waits for an offline peer before pruning and converges after acknowledgement",
  async () =>
    pair(
      async ({
        b,
        source,
        target,
        one,
        two,
        disconnect,
        reconnect,
        errors,
      }) => {
        const id = await source.create("note.md", utf8.encode("first"));
        const draft = source.draft(id);
        draft.text = "second";
        source.release(await source.save(draft));
        source.release(draft);
        const invitation = await one.create(source, "file", "note.md");
        await one.grant(invitation, b.contactCard, "read");
        await two.join(shareLink(invitation), target);
        disconnect();
        await one.rewriteHistory(source, { id }, { kind: "reset", time: 100 });
        expect(source.history(id).length).toBeGreaterThan(1);
        reconnect();
        await expect
          .poll(() => source.history(id).length, { timeout: 15000 })
          .toBe(1);
        await expect
          .poll(() => target.doc(id).generation, { timeout: 15000 })
          .toBe(source.doc(id).generation);
        await one.flush();
        await two.flush();
        expect(target.doc(id).text).toBe("second");
        expect(errors).toEqual([]);
      },
    ),
  45000,
);
