import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
const number = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const snapshot = (name, text) => {
  const p = Buffer.from(name),
    b = Buffer.from(text);
  return Buffer.concat([number(1), number(p.length), number(b.length), p, b]);
};
const directory = await mkdtemp(join(tmpdir(), "saddle-native-check-"));
try {
  const text = Array.from(
    { length: 100 },
    (_, i) => `line ${i} original content`,
  ).join("\n");
  const input = Buffer.concat([
    snapshot("original.md", text),
    snapshot("renamed.md", text.replace("line 20", "updated line 20")),
  ]);
  const result = spawnSync(
    join(
      "build/native-renames/package",
      `saddle-renames${process.platform === "win32" ? ".exe" : ""}`,
    ),
    [directory],
    { input, encoding: "utf8", timeout: 10000 },
  );
  assert.equal(result.status, 0, result.stderr);
  const moves = JSON.parse(result.stdout);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].from, "original.md");
  assert.equal(moves[0].to, "renamed.md");
  assert(moves[0].similarity >= 70);
  console.log("Verified libgit2 rename with edited contents");
} finally {
  await rm(directory, { recursive: true, force: true });
}
