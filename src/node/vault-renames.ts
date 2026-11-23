import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { digest, utf8 } from "../crypto.js";
import {
  filePath,
  type RenameMatcher,
  type RenameCandidate,
  type RenameMatch,
} from "../units/contracts.js";

/** Uses libgit2's real tree diff/find-similar engine, without a Git CLI or live repo. */
export class Libgit2RenameMatcher implements RenameMatcher {
  readonly name = "libgit2";
  constructor(readonly executable: string) {}
  async match(
    before: RenameCandidate[],
    after: RenameCandidate[],
  ): Promise<RenameMatch[]> {
    if (!before.length || !after.length) return [];
    // Duplicate content has no uniquely inferable identity, even if git would choose.
    const unique = async (files: RenameCandidate[]) => {
      const hashes = await Promise.all(files.map((f) => digest(f.bytes)));
      const counts = new Map<string, number>();
      hashes.forEach((hash) => counts.set(hash, (counts.get(hash) ?? 0) + 1));
      return files.filter((_, i) => counts.get(hashes[i]) === 1);
    };
    const left = await unique(before),
      right = await unique(after);
    const blocks: Buffer[] = [];
    const word = (value: number) => {
      const bytes = Buffer.alloc(4);
      bytes.writeUInt32BE(value);
      blocks.push(bytes);
    };
    for (const snapshot of [left, right]) {
      word(snapshot.length);
      for (const file of snapshot) {
        const name = utf8.encode(filePath(file.path));
        word(name.length);
        word(file.bytes.length);
        blocks.push(
          Buffer.from(name.buffer, name.byteOffset, name.byteLength),
          Buffer.from(
            file.bytes.buffer,
            file.bytes.byteOffset,
            file.bytes.byteLength,
          ),
        );
      }
    }
    const directory = await mkdtemp(path.join(tmpdir(), "saddle-renames-"));
    try {
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(this.executable, [directory], {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        let stdout = "",
          stderr = "";
        const timer = setTimeout(() => {
          child.kill();
          reject(Error("libgit2 rename scan timed out"));
        }, 30000);
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
          if (stdout.length > 8 * 1024 * 1024) child.kill();
        });
        child.stderr.on("data", (chunk) => {
          stderr = (stderr + chunk).slice(-4096);
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          code === 0
            ? resolve(stdout)
            : reject(Error(stderr || "libgit2 rename scan failed"));
        });
        child.stdin.on("error", () => {});
        void (async () => {
          for (const block of blocks)
            if (!child.stdin.write(block))
              await new Promise<void>((resolve, reject) => {
                const done = () => {
                  child.stdin.off("error", failed);
                  resolve();
                };
                const failed = (error: Error) => {
                  child.stdin.off("drain", done);
                  reject(error);
                };
                child.stdin.once("drain", done);
                child.stdin.once("error", failed);
              });
          child.stdin.end();
        })().catch((error) => {
          child.kill();
          reject(error);
        });
      });
      const matches = JSON.parse(output) as RenameMatch[];
      const sources = new Set(left.map((f) => f.path)),
        destinations = new Set(right.map((f) => f.path));
      const seenSources = new Set<string>(),
        seenDestinations = new Set<string>();
      if (
        !Array.isArray(matches) ||
        matches.some(
          (m) =>
            !sources.has(m.from) ||
            !destinations.has(m.to) ||
            !Number.isFinite(m.similarity) ||
            m.similarity < 70 ||
            m.similarity > 100,
        )
      )
        throw Error("Invalid libgit2 rename results");
      for (const match of matches) {
        if (seenSources.has(match.from) || seenDestinations.has(match.to))
          throw Error("Duplicate libgit2 rename results");
        seenSources.add(match.from);
        seenDestinations.add(match.to);
      }
      return matches;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
