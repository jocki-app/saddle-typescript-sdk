import { readFileSync } from "node:fs";
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const tag = process.env.RELEASE_TAG;
if (
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ||
  tag !== `v${version}`
)
  throw Error("Release tag must equal package.json version");
console.log(`Verified ${tag}`);
