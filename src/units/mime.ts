const types: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  csdb: "application/vnd.csdb",
  canvas: "application/vnd.canvas+json",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  txt: "text/plain",
  csv: "text/csv",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  ts: "text/typescript",
  tsx: "text/typescript",
  jsx: "text/javascript",
  py: "text/x-python",
  rs: "text/x-rust",
  c: "text/x-c",
  h: "text/x-c",
  cpp: "text/x-c++",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
  zip: "application/zip",
};
export const extension = (path: string) =>
  path.split("/").pop()!.split(".").pop()!.toLowerCase();
export function mimeType(path: string): string {
  return types[extension(path)] ?? "application/octet-stream";
}
export function textMime(mime: string) {
  return (
    mime.startsWith("text/") ||
    [
      "application/json",
      "application/yaml",
      "application/vnd.csdb",
      "application/vnd.canvas+json",
    ].includes(mime)
  );
}
