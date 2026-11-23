import * as A from "@automerge/automerge";
import { fromHex } from "./crypto.js";
import {
  Repo,
  WebSocketEndpoint,
  type ManagedTransport,
  type DocHandle,
  type StorageAdapterInterface,
  type RepoConfig,
  stringifyAutomergeUrl,
  parseAutomergeUrl,
} from "@automerge/automerge-repo";
import "@automerge/automerge-subduction";
import type { Policy } from "@automerge/automerge-subduction";
import { unbase64 } from "./crypto.js";
import {
  GroupId,
  MemberedId,
  ChangeId,
  uint8ArrayToHex,
  Access,
  ContactCard,
  Identifier,
  DocumentId as KeyhiveDocumentId,
  initializeAutomergeRepoKeyhive,
  type AutomergeRepoKeyhive,
  type SyncServerSelection,
} from "@automerge/automerge-repo-keyhive";

/** Platform capabilities, supplied at startup. Documents never select transports or execute code. */
export interface RepositoryOptions {
  documents: StorageAdapterInterface;
  identity: StorageAdapterInterface;
  syncServer?: SyncServerSelection;
  endpoints?: string[];
  adapters?: RepoConfig["subductionAdapters"];
  remotePeerId?: RepoConfig["peerId"];
  label?: string;
  keyPair?: CryptoKeyPair;
}

/** Repo does not yet own transports whose Subduction handshake is unfinished. */
class RelayEndpoint extends WebSocketEndpoint {
  private stopped = false;
  private transports = new Set<ManagedTransport>();
  async connect(): Promise<ManagedTransport> {
    if (this.stopped) throw Error("Relay connection is closed");
    const transport = await super.connect();
    if (this.stopped) {
      await transport.disconnect();
      throw Error("Relay connection is closed");
    }
    this.transports.add(transport);
    void transport.closed().then(() => this.transports.delete(transport));
    return transport;
  }
  async shutdown() {
    this.stopped = true;
    await Promise.all(
      [...this.transports].map((transport) => transport.disconnect()),
    );
    this.transports.clear();
  }
}

/** SADDLE owns initialization and lifecycle; Repo and Keyhive own documents and synchronization. */
export class Repository {
  private constructor(
    readonly repo: Repo,
    readonly hive: AutomergeRepoKeyhive,
    readonly relayEnabled: boolean,
    private readonly endpoints: RelayEndpoint[],
  ) {}

  static async open(options: RepositoryOptions) {
    let resolveHive!: (hive: AutomergeRepoKeyhive) => void;
    const ready = new Promise<AutomergeRepoKeyhive>((resolve) => {
      resolveHive = resolve;
    });
    const permitted = async (
      peer: { toBytes(): Uint8Array },
      document: { toBytes(): Uint8Array },
      access: Access,
    ) => {
      const hive = await ready;
      const bytes = document.toBytes();
      if (bytes.length !== 32) return false;
      const granted = await hive.keyhive.bestAccessForDoc(
        new Identifier(peer.toBytes()),
        new KeyhiveDocumentId(bytes),
      );
      return granted?.atLeast(access) === true;
    };
    const policy: Policy = {
      async authorizeConnect() {},
      async authorizeFetch(peer, document) {
        if (!(await permitted(peer, document, Access.relay())))
          throw Error("Keyhive relay access is required");
      },
      async authorizePut(_requestor, author, document) {
        if (!(await permitted(author, document, Access.edit())))
          throw Error("Keyhive edit access is required");
      },
      async filterAuthorizedFetch(peer, ids) {
        const result = [];
        for (const id of ids)
          if (await permitted(peer, id, Access.relay())) result.push(id);
        return result;
      },
    };
    const canShare = async (
      peerId: import("@automerge/automerge-repo").PeerId,
      documentId?: import("@automerge/automerge-repo").DocumentId,
    ) => {
      if (!documentId) return true;
      try {
        const hive = await ready;
        const id = new Identifier(unbase64(peerId.split("-")[0]));
        return (
          (await hive.bestAccessForDoc(id, stringifyAutomergeUrl(documentId)))
            ?.isReader === true
        );
      } catch {
        return false;
      }
    };
    const sharing = { announce: canShare, access: canShare };
    const endpoints = (options.endpoints ?? []).map(
      (url) => new RelayEndpoint(url),
    );
    const { repo, hive } = await initializeAutomergeRepoKeyhive({
      createRepo: (config) => new Repo(config),
      storage: options.identity,
      keyPair: options.keyPair,
      peerIdSuffix: options.label ?? "saddle",
      // Naming a relay does not connect to it. Endpoints are always an explicit local setting.
      syncServer: options.syncServer ?? "keyhive",
      remotePeerId: options.remotePeerId,
      periodicallyRequestSync: Boolean(
        options.endpoints?.length || options.adapters?.length,
      ),
      shareConfigDebounceMs: 0,
      repo: {
        storage: options.documents,
        shareConfig: sharing,
        subductionWebsocketEndpoints: endpoints,
        subductionAdapters: options.adapters ?? [],
        subductionPolicy: policy,
      },
    });
    resolveHive(hive);
    return new Repository(
      repo,
      hive,
      Boolean(options.endpoints?.length),
      endpoints,
    );
  }

  get contactCard() {
    return this.hive.active.contactCard.toJson();
  }
  get identityId() {
    return uint8ArrayToHex(this.hive.active.individual.id.toBytes());
  }
  async documentAccess(
    url: import("@automerge/automerge-repo").AutomergeUrl,
  ): Promise<"edit" | "read" | undefined> {
    const access = await this.hive.bestAccessForDoc(
      this.hive.active.individual.id,
      url,
    );
    return access?.atLeast(Access.edit())
      ? "edit"
      : access?.isReader
        ? "read"
        : undefined;
  }
  async groupCanRead(
    group: string,
    url: import("@automerge/automerge-repo").AutomergeUrl,
  ) {
    return (
      (
        await this.hive.bestAccessForDoc(
          new GroupId(fromHex(group)).toIdentifier(),
          url,
        )
      )?.isReader === true
    );
  }
  async isDocumentAdmin(
    key: Uint8Array,
    url: import("@automerge/automerge-repo").AutomergeUrl,
  ) {
    return (
      (await this.hive.bestAccessForDoc(new Identifier(key), url))?.atLeast(
        Access.fromString("admin"),
      ) === true
    );
  }

  async waitForAccess(
    url: import("@automerge/automerge-repo").AutomergeUrl,
    timeout = 30000,
    signal?: AbortSignal,
  ) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const access = await this.hive.bestAccessForDoc(
        this.hive.active.individual.id,
        url,
      );
      if (access?.isReader) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw Error(
      !this.relayEnabled && !this.repo.isSubductionConnected()
        ? "No sync connection is available. Turn Broadcast on and use the same relay on both devices, then retry the invitation."
        : "Keyhive access has not arrived. Approve a current request from this device, keep the approving workspace online, and use the same sync relay on both devices.",
    );
  }

  async create<T>(value: T): Promise<DocHandle<T>> {
    const handle = await this.repo.create2(value);
    await this.enableRelay(handle);
    await this.flush();
    return handle;
  }

  /** A grant can arrive before its document is available from the peer. Keep
   * observing native Repo progress and retry only that initial unavailable fetch. */
  async load<T>(
    url: import("@automerge/automerge-repo").AutomergeUrl,
    signal = AbortSignal.timeout(30000),
  ): Promise<DocHandle<T>> {
    await this.waitForAccess(url, 30000, signal);
    signal.throwIfAborted();
    const progress = this.repo.findWithProgress<T>(url);
    return new Promise((resolve, reject) => {
      let retry: ReturnType<typeof setInterval> | undefined;
      const cleanup = () => {
        unsubscribe();
        if (retry) clearInterval(retry);
        signal.removeEventListener("abort", abort);
      };
      const abort = () => {
        cleanup();
        reject(signal.reason);
      };
      const check = () => {
        const state = progress.peek();
        if (state.state === "ready") {
          cleanup();
          resolve(state.handle);
        } else if (state.state === "failed") {
          cleanup();
          reject(state.error);
        } else if (state.state === "unavailable" && !retry) {
          const resync = () => {
            if (progress.peek().state === "unavailable")
              this.repo.resyncSubduction(progress.documentId);
          };
          retry = setInterval(resync, 1000);
          resync();
        }
      };
      const unsubscribe = progress.subscribe(check);
      signal.addEventListener("abort", abort, { once: true });
      check();
    });
  }

  async createGroup(parents: string[] = []) {
    const group = await this.hive.keyhive.generateGroup(
      parents.map((id) => new GroupId(fromHex(id)).toIdentifier()),
    );
    if (this.relayEnabled) await this.hive.addSyncServerRelayToGroup(group);
    await this.flush();
    return uint8ArrayToHex(group.toBytes());
  }
  async createGrouped<T>(value: T, groupId: string): Promise<DocHandle<T>> {
    // Set the workspace group as a native Keyhive coparent at creation. Repo's
    // default factory creates a separate access group for each document.
    const id = await this.hive.keyhive.generateDocument(
      [new GroupId(fromHex(groupId)).toIdentifier()],
      new ChangeId(crypto.getRandomValues(new Uint8Array(10))),
      [],
    );
    return this.importWithId<T>(
      A.save(A.from(value as Record<string, unknown>)),
      id.toBytes(),
    );
  }
  /** Protect an existing CRDT without recreating its state or losing its history. */
  async importProtected<T>(bytes: Uint8Array): Promise<DocHandle<T>> {
    const id = await this.hive.keyhive.generateDocument(
      [],
      new ChangeId(crypto.getRandomValues(new Uint8Array(10))),
      [],
    );
    return this.importWithId<T>(bytes, id.toBytes());
  }
  private async importWithId<T>(
    bytes: Uint8Array,
    id: Uint8Array,
  ): Promise<DocHandle<T>> {
    const handle = this.repo.import<T>(bytes, {
      docId: parseAutomergeUrl(
        stringifyAutomergeUrl(
          id as import("@automerge/automerge-repo").BinaryDocumentId,
        ),
      ).documentId,
    });
    await this.enableRelay(handle);
    await this.flush();
    return handle;
  }
  async grantDocumentGroup(
    handle: DocHandle<unknown>,
    groupId: string,
    access: "read" | "edit",
  ) {
    await this.hive.keyhive.addMember(
      new GroupId(fromHex(groupId)).toIdentifier(),
      MemberedId.document(
        new KeyhiveDocumentId(parseAutomergeUrl(handle.url).binaryDocumentId),
      ),
      Access.fromString(access),
      [],
    );
    await this.flush();
  }
  async enableGroupRelay(groupId: string) {
    if (!this.relayEnabled) return;
    const group = new GroupId(fromHex(groupId));
    const server = uint8ArrayToHex(
      unbase64(this.hive.networkAdapter.remotePeerId.split("-")[0]),
    );
    const members =
      (await (await this.hive.keyhive.getGroup(group))?.transitiveMembers()) ??
      [];
    if (
      !members.some(
        (member) =>
          uint8ArrayToHex(member.who.id.toBytes()) === server &&
          member.can.atLeast(Access.relay()),
      )
    )
      await this.hive.addSyncServerRelayToGroup(group);
    await this.flush();
  }
  async grantGroup(groupId: string, card: string, access: "read" | "edit") {
    const contact = ContactCard.fromJson(card);
    await this.hive.receiveContactCard(contact);
    await this.hive.keyhive.addMember(
      contact.id,
      MemberedId.group(new GroupId(fromHex(groupId))),
      Access.fromString(access),
      [],
    );
    await this.flush();
    return uint8ArrayToHex(contact.id.toBytes());
  }
  async shareMembers(url: import("@automerge/automerge-repo").AutomergeUrl) {
    return (await this.hive.listMembers(url))
      .filter((m) => !m.isSyncServer)
      .map((m) => ({
        id: m.id,
        self: m.isSelf,
        access: m.access.atLeast(Access.fromString("admin"))
          ? ("admin" as const)
          : m.access.atLeast(Access.edit())
            ? ("edit" as const)
            : ("read" as const),
      }));
  }
  async revokeGroup(groupId: string, member: string) {
    await this.hive.keyhive.revokeMember(
      new Identifier(fromHex(member)),
      false,
      MemberedId.group(new GroupId(fromHex(groupId))),
    );
    await this.flush();
  }
  async setGroupAccess(
    groupId: string,
    member: string,
    access: "read" | "edit",
  ) {
    // A new lower grant does not cancel an earlier stronger capability.
    await this.hive.keyhive.revokeMember(
      new Identifier(fromHex(member)),
      false,
      MemberedId.group(new GroupId(fromHex(groupId))),
    );
    await this.hive.keyhive.addMember(
      new Identifier(fromHex(member)),
      MemberedId.group(new GroupId(fromHex(groupId))),
      Access.fromString(access),
      [],
    );
    await this.flush();
  }

  async enableRelay(handle: {
    url: import("@automerge/automerge-repo").AutomergeUrl;
  }) {
    if (!this.relayEnabled) return;
    const access = await this.hive.bestAccessForDoc(
      this.hive.active.individual.id,
      handle.url,
    );
    if (access?.toString().toLowerCase() !== "admin") return;
    const members = await this.hive.listMembers(handle.url);
    if (
      !members.some(
        (member) =>
          member.isSyncServer && member.access.atLeast(Access.relay()),
      )
    )
      await this.hive.addSyncServerRelayToDoc(handle.url);
  }

  async grant(
    handle: DocHandle<unknown>,
    card: string,
    access: "read" | "edit" | "admin",
  ) {
    await this.hive.addMemberToDoc(
      handle.url,
      ContactCard.fromJson(card),
      Access.fromString(access),
    );
    await this.flush();
  }

  async flush() {
    await this.hive.keyhiveStorage.saveKeyhiveWithHash(this.hive.keyhive);
    await this.hive.keyhiveStorage.savePrekeySecrets(this.hive.keyhive);
    await this.repo.flush();
  }

  /** Repo.delete detaches handles but does not await its storage removal. */
  async removeDocument(url: import("@automerge/automerge-repo").AutomergeUrl) {
    const { documentId } = parseAutomergeUrl(url);
    await this.repo.flush([documentId]);
    this.repo.delete(url);
    // Removal is idempotent. Await it explicitly before releasing retention guards.
    await this.repo.storageSubsystem?.removeDoc(documentId);
  }

  private closing?: Promise<void>;
  close() {
    return (this.closing ??= (async () => {
      // Stop incoming grants before saving the final identity archive.
      await Promise.all(this.endpoints.map((endpoint) => endpoint.shutdown()));
      this.hive.networkAdapter.disconnect();
      this.repo.networkSubsystem.disconnect();
      try {
        // Direct Subduction transports are outside NetworkSubsystem. End them
        // before shutdown waits for in-flight synchronization to settle.
        await (await this.repo.subduction).disconnectAll();
        await this.flush();
      } finally {
        try {
          await this.repo.shutdown();
        } finally {
          this.hive.close();
        }
      }
    })());
  }
}
