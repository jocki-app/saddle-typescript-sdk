import { watch, type FSWatcher } from "chokidar";
import path from "node:path";
import type { FileSystemChange } from "../units/contracts.js";
const resourceError = (error: unknown) =>
  ["EMFILE", "ENFILE", "ENOSPC", "EPERM", "ENOTSUP"].includes(
    (error as NodeJS.ErrnoException).code ?? "",
  );

/** Group filesystem event bursts for content-based rename inference. */
export class VaultWatcher {
  private changes = new Map<string, FileSystemChange>();
  private pending?: ReturnType<typeof setTimeout>;
  private watcher?: FSWatcher;
  private switching?: Promise<void>;
  private closed = false;
  private constructor(
    private root: string,
    private changed: (changes?: FileSystemChange[]) => void,
    private report: (error: unknown) => void,
  ) {}
  static async open(
    root: string,
    changed: (changes?: FileSystemChange[]) => void,
    error: (error: unknown) => void = console.error,
  ) {
    const subscription = new VaultWatcher(root, changed, error);
    await subscription.start("auto");
    return subscription;
  }
  private schedule() {
    if (this.closed) return;
    clearTimeout(this.pending);
    this.pending = setTimeout(() => {
      const changes = [...this.changes.values()];
      this.changes.clear();
      this.changed(changes.length ? changes : undefined);
    }, 350);
  }
  private async start(backend: "auto" | "polling") {
    if (this.closed) return;
    const watcher = (this.watcher = watch(
      [
        this.root,
        path.join(
          path.dirname(this.root),
          "." + path.basename(this.root) + ".saddle",
        ),
      ],
      {
        backend,
        pollingInterval: 500,
        followSymlinks: false,
        ignoreInitial: true,
        atomic: 200,
        awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
        ignored: (file) =>
          path
            .relative(this.root, file)
            .split(path.sep)
            .some(
              (part) =>
                part === ".git" ||
                part.toLowerCase() === ".saddle" ||
                part.startsWith(".saddle-write-"),
            ),
      },
    ));
    watcher.on("all", (event, file) => {
      if (this.watcher !== watcher) return;
      const relative =
        file ===
        path.join(
          path.dirname(this.root),
          "." + path.basename(this.root) + ".saddle",
        )
          ? ""
          : path.relative(this.root, file).split(path.sep).join("/");
      this.changes.set(relative, {
        path: relative,
        type: event.startsWith("unlink")
          ? "remove"
          : event.startsWith("add")
            ? "add"
            : "change",
        directory: !relative || event.endsWith("Dir"),
      });
      this.schedule();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        let ready = false;
        watcher.once("ready", () => {
          ready = true;
          resolve();
        });
        watcher.on("error", (issue) => {
          if (this.closed || this.watcher !== watcher) return;
          if (backend === "auto" && resourceError(issue)) {
            this.switching ??= (async () => {
              await watcher.close();
              await this.start("polling");
              this.schedule();
            })().finally(() => {
              this.switching = undefined;
            });
            void this.switching.then(resolve, (failure) => {
              if (!ready) reject(failure);
              else this.report(failure);
            });
          } else if (!ready) reject(issue);
          else this.report(issue);
        });
      });
    } catch (error) {
      await watcher.close();
      throw error;
    }
  }
  async close() {
    this.closed = true;
    clearTimeout(this.pending);
    await this.watcher?.close();
    await this.switching?.catch(() => {});
  }
}
