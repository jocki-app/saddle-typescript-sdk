import { spawnSync } from "node:child_process";
import { mkdir, copyFile, chmod, readFile, stat } from "node:fs/promises";
const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
const cache = await readFile(
  "build/native-renames/CMakeCache.txt",
  "utf8",
).catch((error) => {
  if (error.code !== "ENOENT") throw error;
  return "";
});
const source = cache.match(
  /^FETCHCONTENT_SOURCE_DIR_LIBGIT2:[^=]+=([^\r\n]+)/m,
)?.[1];
const configureArgs = [];
if (source) {
  const directory = await stat(source).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (!directory?.isDirectory()) {
    console.warn(`Clearing missing cached libgit2 source override: ${source}`);
    configureArgs.push("-U", "FETCHCONTENT_SOURCE_DIR_LIBGIT2");
  }
}
run("cmake", [
  "-S",
  "native/renames",
  "-B",
  "build/native-renames",
  "-DCMAKE_BUILD_TYPE=Release",
  // Clear only stale cache entries; explicit options below still take precedence.
  ...configureArgs,
  ...process.argv.slice(2),
]);
run("cmake", [
  "--build",
  "build/native-renames",
  "--config",
  "Release",
  "--parallel",
  "4",
]);
await mkdir("build/native-renames/package", { recursive: true });
const executable =
  "saddle-renames" + (process.platform === "win32" ? ".exe" : "");
await copyFile(
  "build/native-renames/" +
    (process.platform === "win32" ? "Release/" : "") +
    executable,
  "build/native-renames/package/" + executable,
);
if (process.platform !== "win32")
  await chmod("build/native-renames/package/" + executable, 0o755);
