import { validateRewrite, type HistoryRewrite } from "./history-rewrite.js";
import * as A from "@automerge/automerge";
import {
  Access,
  Identifier,
  Signed,
  uint8ArrayToHex,
} from "@automerge/automerge-repo-keyhive";
import {
  isValidAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type DocHandleEphemeralMessagePayload,
} from "@automerge/automerge-repo";
import type { Repository } from "../repository.js";
import type { FileDocument } from "./contracts.js";
import { base64, canonical, text, unbase64, utf8, fromHex } from "../crypto.js";

export interface RetentionDocument extends Record<string, unknown> {
  format: "saddle-retention/1";
  file: string;
  owner: string;
  proposal: {
    token: string;
    epoch: number;
    heads: A.Heads;
    participants: string[];
    phase: "prepare" | "commit" | "abort";
    deadline: number;
    acknowledgements: Record<string, string>;
    next: AutomergeUrl | null;
    previous: AutomergeUrl;
    rewrite?: HistoryRewrite;
  } | null;
}
interface Ack {
  format: "saddle-retention-ack/1";
  url: AutomergeUrl;
  token: string;
  epoch: number;
  heads: A.Heads;
  status: "frozen" | "committed" | "refuse";
}

export interface RetentionTarget<T extends { id: string }> {
  doc(id: string): A.Doc<T>;
  historyEnabled(id: string): boolean;
  retainsHistory(id: string): boolean;
  hasDirtyDraft(id: string): boolean;
  getFreeze?(id: string): { token: string } | undefined;
  epoch(doc: A.Doc<T>): number;
  generation(doc: A.Doc<T>): string;
  freezeHistory(
    id: string,
    token: string,
    heads: A.Heads,
    rewrite?: HistoryRewrite,
  ): Promise<boolean>;
  unfreezeHistory(id: string, token: string): Promise<void>;
  acceptCheckpoint(id: string, bytes: Uint8Array, token: string): Promise<void>;
  historyPruned?(id: string): Promise<void>;
  prepareForPruning?(doc: A.Doc<T>): Promise<void>;
  validateHistoryRewrite?(id: string, operation: HistoryRewrite): void;
}

/** Two-phase, durable freeze barrier. It never interprets messages as app commands. */
export class HistoryRetention<T extends { id: string } = FileDocument> {
  private retired = false;
  private completed = new Set<string>();
  private busy = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private retryBegin: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(
    readonly repository: Repository,
    readonly vault: RetentionTarget<T>,
    public file: DocHandle<T>,
    readonly control: DocHandle<RetentionDocument>,
    readonly rotate: (
      old: DocHandle<T>,
      token: string,
      rewrite?: HistoryRewrite,
    ) => Promise<DocHandle<T>>,
    readonly error: (error: unknown) => void,
    readonly published: () => Promise<void>,
  ) {}
  static async open<T extends { id: string }>(
    repository: Repository,
    vault: RetentionTarget<T>,
    file: DocHandle<T>,
    control: DocHandle<RetentionDocument>,
    rotate: HistoryRetention<T>["rotate"],
    error: (error: unknown) => void,
    published: () => Promise<void> = async () => {},
  ) {
    if (
      control.doc().format !== "saddle-retention/1" ||
      control.doc().file !== file.doc().id
    )
      throw Error("Invalid history control document");
    const retention = new HistoryRetention(
      repository,
      vault,
      file,
      control,
      rotate,
      error,
      published,
    );
    control.on("change", retention.changed);
    control.on("ephemeral-message", retention.receive);
    file.on("change", retention.changed);
    void retention.schedule(() => retention.apply());
    return retention;
  }
  get owner() {
    return (
      uint8ArrayToHex(this.repository.hive.active.individual.id.toBytes()) ===
      this.control.doc().owner
    );
  }
  private schedule(work: () => Promise<void>) {
    const next = this.queue.then(work);
    this.queue = next.catch(this.error);
    return next;
  }
  private changed = () => {
    void this.schedule(() => this.apply());
  };
  private receive = ({
    message,
  }: DocHandleEphemeralMessagePayload<RetentionDocument>) => {
    void this.schedule(() => this.requested(message));
  };
  async rewrite(operation: HistoryRewrite) {
    validateRewrite(operation);
    if (this.vault.hasDirtyDraft(this.file.doc().id))
      throw Error("Save or discard drafts before editing history");
    if (this.control.doc().proposal?.phase === "commit" && !this.canRetire)
      await new Promise<void>((resolve, reject) => {
        const changed = () => {
          if (!this.canRetire) return;
          finish();
          resolve();
        };
        const timer = setTimeout(() => {
          finish();
          reject(Error("A history operation is waiting for other computers"));
        }, 30000);
        const finish = () => {
          clearTimeout(timer);
          this.control.off("change", changed);
        };
        this.control.on("change", changed);
        changed();
      });
    const pending = this.control.doc().proposal;
    if (
      pending?.phase === "prepare" ||
      (pending?.phase === "commit" && !this.canRetire)
    )
      throw Error("A history operation is waiting for other computers");
    if ((await this.repository.documentAccess(this.file.url)) !== "edit")
      throw Error("Editing access is required to change history");
    if (this.owner) return this.schedule(() => this.beginInternal(operation));
    const request = {
      format: "saddle-history-request/1",
      url: this.control.url,
      operation,
      epoch: this.vault.epoch(this.file.doc()),
      heads: A.getHeads(this.vault.doc(this.file.doc().id)),
    };
    const signed = base64(
      (
        await this.repository.hive.keyhive.trySign(
          utf8.encode(canonical(request)),
        )
      ).toBytes(),
    );
    await new Promise<void>((resolve, reject) => {
      const changed = () => {
        const proposal = this.control.doc().proposal;
        if (
          proposal &&
          proposal.phase !== "abort" &&
          canonical(proposal.rewrite) === canonical(operation) &&
          canonical(proposal.heads) === canonical(request.heads)
        ) {
          finish();
          resolve();
        }
      };
      const send = () =>
        this.control.broadcast({ saddle: "history-request", signed });
      const timeout = setTimeout(() => {
        finish();
        reject(
          Error(
            "Connect the share administrator to request this history change",
          ),
        );
      }, 30000);
      const retry = setInterval(send, 1000);
      const finish = () => {
        clearTimeout(timeout);
        clearInterval(retry);
        this.control.off("change", changed);
      };
      this.control.on("change", changed);
      send();
      changed();
    });
  }
  private async requested(input: unknown) {
    if (
      !input ||
      typeof input !== "object" ||
      (input as { saddle?: string }).saddle !== "history-request"
    )
      return this.acknowledge(input);
    if (!this.owner || this.retired) return;
    const envelope = input as { signed?: string };
    if (typeof envelope.signed !== "string" || envelope.signed.length > 65536)
      return;
    const signed = Signed.fromBytes(unbase64(envelope.signed));
    if (!signed.verify()) throw Error("Invalid history request signature");
    const request = JSON.parse(text.decode(signed.payload())) as {
      format: string;
      url: string;
      operation: HistoryRewrite;
      epoch: number;
      heads: A.Heads;
    };
    if (
      request.format !== "saddle-history-request/1" ||
      request.url !== this.control.url ||
      request.epoch !== this.vault.epoch(this.file.doc()) ||
      canonical(request.heads) !==
        canonical(A.getHeads(this.vault.doc(this.file.doc().id)))
    )
      return;
    const access = await this.repository.hive.bestAccessForDoc(
      new Identifier(fromHex(uint8ArrayToHex(signed.verifyingKey))),
      this.file.url,
    );
    if (!access?.atLeast(Access.edit())) return;
    const prior = this.control.doc().proposal;
    if (
      prior?.phase === "prepare" ||
      (prior?.phase === "commit" && !this.canRetire)
    )
      return;
    await this.beginInternal(request.operation);
  }
  private async members() {
    return [
      ...new Set(
        (await this.repository.hive.listMembers(this.file.url))
          .filter(
            (m) =>
              !m.isSyncServer && !m.isPublic && m.access.atLeast(Access.read()),
          )
          .map((m) => m.id),
      ),
    ].sort();
  }
  begin() {
    return this.schedule(() => this.beginInternal());
  }
  private async beginInternal(rewrite?: HistoryRewrite) {
    if (rewrite) {
      validateRewrite(rewrite);
      // Retries read this value from the control document. Copy its scalars;
      // an Automerge object cannot be assigned into another change.
      rewrite =
        rewrite.kind === "drop"
          ? { kind: "drop", hash: rewrite.hash }
          : { kind: "reset", time: rewrite.time };
    }
    if (
      this.retired ||
      !this.owner ||
      (!rewrite &&
        (this.vault.historyEnabled(this.file.doc().id) ||
          this.vault.retainsHistory(this.file.doc().id))) ||
      this.control.doc().proposal?.phase === "prepare" ||
      (this.control.doc().proposal?.phase === "commit" && !this.canRetire) ||
      (this.control.doc().proposal?.phase === "abort" && !!this.retryBegin)
    )
      return;
    if (!rewrite) await this.vault.prepareForPruning?.(this.file.doc());
    const participants = await this.members(),
      token = crypto.randomUUID(),
      heads = A.getHeads(this.vault.doc(this.file.doc().id));
    if (rewrite)
      this.vault.validateHistoryRewrite?.(this.file.doc().id, rewrite);
    if (
      !(await this.vault.freezeHistory(
        this.file.doc().id,
        token,
        heads,
        rewrite,
      ))
    ) {
      if (rewrite)
        throw Error(
          "Save or discard drafts and reconcile external edits before changing history",
        );
      return;
    }
    if (this.retired) {
      await this.vault.unfreezeHistory(this.file.doc().id, token);
      return;
    }
    this.control.change((d) => {
      d.proposal = {
        token,
        epoch: this.vault.epoch(this.file.doc()),
        heads,
        participants,
        phase: "prepare",
        deadline: Date.now() + 30000,
        acknowledgements: {},
        next: null,
        previous: this.file.url,
        ...(rewrite ? { rewrite } : {}),
      };
    });
    await this.repository.flush();
    await this.apply();
  }
  private async send(status: Ack["status"], p = this.control.doc().proposal) {
    if (!p || this.control.doc().proposal?.token !== p.token) return;
    const ack: Ack = {
      format: "saddle-retention-ack/1",
      url: this.control.url,
      token: p.token,
      epoch: p.epoch,
      heads: p.heads,
      status,
    };
    const signed = base64(
      (
        await this.repository.hive.keyhive.trySign(utf8.encode(canonical(ack)))
      ).toBytes(),
    );
    const envelope = { saddle: "retention", signed };
    if (this.owner) await this.acknowledge(envelope);
    else this.control.broadcast(envelope);
  }
  private async acknowledge(input: unknown) {
    if (this.retired) return;
    if (!this.owner || !input || typeof input !== "object") return;
    const envelope = input as { saddle?: string; signed?: string };
    if (
      envelope.saddle !== "retention" ||
      typeof envelope.signed !== "string" ||
      envelope.signed.length > 65536
    )
      return;
    const signed = Signed.fromBytes(unbase64(envelope.signed));
    if (!signed.verify())
      throw Error("Invalid checkpoint acknowledgement signature");
    const id = uint8ArrayToHex(signed.verifyingKey),
      ack = JSON.parse(text.decode(signed.payload())) as Ack;
    const proposal = this.control.doc().proposal;
    if (
      !proposal ||
      ack.format !== "saddle-retention-ack/1" ||
      ack.url !== this.control.url ||
      ack.token !== proposal.token ||
      ack.epoch !== proposal.epoch ||
      canonical(ack.heads) !== canonical(proposal.heads) ||
      !proposal.participants.includes(id)
    )
      return;
    if (
      ack.status === "refuse" ||
      canonical(await this.members()) !== canonical(proposal.participants)
    ) {
      await this.abort();
      return;
    }
    if (proposal.acknowledgements[id] === envelope.signed) return;
    this.control.change((d) => {
      d.proposal!.acknowledgements[id] = envelope.signed!;
    });
    await this.repository.flush();
    const all = (status: Ack["status"]) =>
      proposal.participants.every((member) => {
        const bytes = this.control.doc().proposal!.acknowledgements[member];
        if (!bytes) return false;
        const signed = Signed.fromBytes(unbase64(bytes));
        const ack = JSON.parse(text.decode(signed.payload())) as Ack;
        return (
          signed.verify() &&
          uint8ArrayToHex(signed.verifyingKey) === member &&
          ack.format === "saddle-retention-ack/1" &&
          ack.url === this.control.url &&
          ack.status === status &&
          ack.token === proposal.token &&
          ack.epoch === proposal.epoch &&
          canonical(ack.heads) === canonical(proposal.heads)
        );
      });
    if (proposal.phase === "prepare" && all("frozen")) await this.commit();
    else if (proposal.phase === "commit" && all("committed")) {
      await this.complete();
    }
  }
  private async complete() {
    if (this.retired) return;
    const proposal = this.control.doc().proposal;
    if (
      proposal?.phase !== "commit" ||
      !this.canRetire ||
      this.completed.has(proposal.token)
    )
      return;
    await this.repository.removeDocument(proposal.previous);
    await this.vault.historyPruned?.(this.file.doc().id);
    this.completed.add(proposal.token);
  }
  private async abort() {
    this.control.change((d) => {
      if (d.proposal) d.proposal.phase = "abort";
    });
    await this.repository.flush();
    await this.apply();
    if (this.owner && !this.retired && !this.retryBegin)
      this.retryBegin = setTimeout(() => {
        this.retryBegin = undefined;
        void this.schedule(() =>
          this.beginInternal(this.control.doc().proposal?.rewrite),
        ).catch(this.error);
      }, 1000);
  }
  private async commit() {
    if (this.busy || this.retired) return;
    this.busy = true;
    try {
      const proposal = this.control.doc().proposal!;
      if (
        canonical(await this.members()) !== canonical(proposal.participants)
      ) {
        await this.abort();
        return;
      }
      const next = await this.rotate(
        this.file,
        proposal.token,
        proposal.rewrite,
      );
      if (this.vault.epoch(next.doc()) !== proposal.epoch + 1) {
        await this.abort();
        return;
      }
      this.control.change((d) => {
        d.proposal!.phase = "commit";
        d.proposal!.next = next.url;
        d.proposal!.acknowledgements = {};
      });
      await this.repository.flush();
      this.bind(next);
      await this.published();
    } catch (error) {
      await this.abort();
      throw error;
    } finally {
      this.busy = false;
    }
    await this.apply();
  }
  private async apply() {
    if (this.retired) return;
    const proposal = this.control.doc().proposal;
    if (
      !proposal ||
      (proposal.phase === "commit" && this.completed.has(proposal.token))
    )
      return;
    if (this.retired) {
      await this.vault.unfreezeHistory(this.file.doc().id, proposal.token);
      return;
    }
    await this.repository.flush();
    if (this.control.doc().proposal?.token !== proposal.token) return;
    const id = this.file.doc().id;
    if (proposal.rewrite) validateRewrite(proposal.rewrite);
    if (proposal.phase === "abort") {
      await this.vault.unfreezeHistory(id, proposal.token);
      // A restart between abort and retry must not lose an accepted request.
      if (proposal.rewrite && this.owner && !this.retryBegin)
        this.retryBegin = setTimeout(() => {
          this.retryBegin = undefined;
          void this.schedule(() =>
            this.beginInternal(this.control.doc().proposal?.rewrite),
          );
        }, 1000);
      return;
    }
    if (proposal.phase === "prepare") {
      if (this.owner && Date.now() > proposal.deadline) {
        await this.abort();
        return;
      }
      if (this.owner && !this.timer)
        this.timer = setTimeout(
          () => {
            this.timer = undefined;
            void this.schedule(() => this.apply());
          },
          Math.max(1, proposal.deadline - Date.now()),
        );
      if (
        (!!proposal.rewrite || !this.vault.historyEnabled(id)) &&
        !this.vault.hasDirtyDraft(id) &&
        A.hasHeads(this.file.doc(), proposal.heads)
      )
        if (!proposal.rewrite)
          await this.vault.prepareForPruning?.(
            A.view(this.file.doc(), proposal.heads),
          );
      if (
        (!!proposal.rewrite || !this.vault.historyEnabled(id)) &&
        !this.vault.hasDirtyDraft(id) &&
        A.hasHeads(this.vault.doc(id), proposal.heads) &&
        canonical(A.getHeads(this.vault.doc(id))) !== canonical(proposal.heads)
      ) {
        await this.send("refuse", proposal);
        return;
      }
      if (
        (!!proposal.rewrite ||
          !this.vault.historyEnabled(this.file.doc().id)) &&
        !this.vault.hasDirtyDraft(id) &&
        canonical(A.getHeads(this.vault.doc(id))) !==
          canonical(proposal.heads) &&
        Date.now() < proposal.deadline
      ) {
        if (!this.retry)
          this.retry = setTimeout(() => {
            this.retry = undefined;
            void this.schedule(() => this.apply());
          }, 200);
        return; // The proposal may arrive before the final file changes.
      }
      if (this.control.doc().proposal?.token !== proposal.token) return;
      const priorFreeze = this.vault.getFreeze?.(id);
      if (priorFreeze && priorFreeze.token !== proposal.token)
        await this.vault.unfreezeHistory(id, priorFreeze.token);
      const frozen = await this.vault.freezeHistory(
        id,
        proposal.token,
        proposal.heads,
        proposal.rewrite,
      );
      if (this.control.doc().proposal?.token !== proposal.token) {
        if (frozen) await this.vault.unfreezeHistory(id, proposal.token);
        return;
      }
      await this.send(frozen ? "frozen" : "refuse", proposal);
    } else if (proposal.next && isValidAutomergeUrl(proposal.next)) {
      const next = await this.repository.load<T>(proposal.next);
      if (
        this.vault.generation(this.vault.doc(id)) !==
        this.vault.generation(next.doc())
      )
        await this.vault.acceptCheckpoint(
          id,
          A.save(next.doc()),
          proposal.token,
        );
      this.bind(next);
      await this.send("committed", proposal);
      await this.complete();
    }
  }
  close() {
    this.retired = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.retry) clearTimeout(this.retry);
    if (this.retryBegin) clearTimeout(this.retryBegin);
    this.control.off("change", this.changed);
    this.control.off("ephemeral-message", this.receive);
    this.file.off("change", this.changed);
  }
  get canRetire() {
    const proposal = this.control.doc().proposal;
    if (!proposal || proposal.phase === "abort") return true;
    if (proposal.phase !== "commit") return false;
    return proposal.participants.every((member) => {
      try {
        const signed = Signed.fromBytes(
            unbase64(proposal.acknowledgements[member]),
          ),
          ack = JSON.parse(text.decode(signed.payload())) as Ack;
        return (
          signed.verify() &&
          uint8ArrayToHex(signed.verifyingKey) === member &&
          ack.url === this.control.url &&
          ack.status === "committed" &&
          ack.token === proposal.token &&
          ack.epoch === proposal.epoch &&
          canonical(ack.heads) === canonical(proposal.heads)
        );
      } catch {
        return false;
      }
    });
  }
  cancelForRetirement() {
    return this.schedule(async () => {
      if (this.control.doc().proposal?.phase === "prepare") {
        if (this.owner) await this.abort();
        else await this.send("refuse");
      }
    });
  }
  private bind(file: DocHandle<T>) {
    if (file.url === this.file.url) return;
    this.file.off("change", this.changed);
    this.file = file;
    file.on("change", this.changed);
  }
  async acceptCommitted(bytes: Uint8Array) {
    const incoming = A.load<T>(bytes);
    if (
      this.vault.generation(this.vault.doc(incoming.id)) ===
      this.vault.generation(incoming)
    )
      return;
    const proposal = await new Promise<
      NonNullable<RetentionDocument["proposal"]>
    >((resolve, reject) => {
      const finish = () => {
        const value = this.control.doc().proposal;
        if (value?.phase === "commit") {
          clearTimeout(timeout);
          this.control.off("change", finish);
          resolve(value);
        }
      };
      const timeout = setTimeout(() => {
        this.control.off("change", finish);
        reject(Error("Waiting for the authenticated history checkpoint"));
      }, 30000);
      this.control.on("change", finish);
      finish();
    });
    if (this.vault.epoch(incoming) !== proposal.epoch + 1)
      throw Error("Checkpoint epoch mismatch");
    await this.vault.acceptCheckpoint(incoming.id, bytes, proposal.token);
  }
}
