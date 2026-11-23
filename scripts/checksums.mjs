import { readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const dir = process.argv[2] ?? "release";
const files = (await readdir(dir)).filter((n) => n !== "SHA256SUMS.txt").sort();
const rows = await Promise.all(
  files.map(
    async (n) =>
      `${createHash("sha256")
        .update(await readFile(`${dir}/${n}`))
        .digest("hex")}  ${n}`,
  ),
);
await writeFile(`${dir}/SHA256SUMS.txt`, rows.join("\n") + "\n");
