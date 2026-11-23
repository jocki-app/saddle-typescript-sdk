import { frontmatter, noteMetadata } from "./knowledge.js";
import { filePath } from "./contracts.js";

export type JSONValue =
  null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };
export type JSONObject = { [key: string]: JSONValue };
/** Frictionless Data Resource 2.0, including application-defined properties. */
export interface DataResource {
  [key: string]: JSONValue | undefined;
  name: string;
  path?: string | string[];
  data?: JSONValue;
  metadata?: JSONObject;
  saddle?: JSONObject;
}
export const resourceProfile =
  "https://datapackage.org/profiles/2.0/dataresource.json";
export function sidecarPath(path: string) {
  const parts = filePath(path).split("/");
  parts[parts.length - 1] = "." + parts.at(-1)! + ".saddle";
  return parts.join("/");
}
export const isSidecar = (path: string) => path.endsWith(".saddle");
const object = (value: unknown): value is JSONObject =>
  !!value && typeof value === "object" && !Array.isArray(value);
function json(value: unknown): asserts value is JSONValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach(json);
    return;
  }
  if (object(value)) {
    if (Object.hasOwn(value, "__proto__"))
      throw Error("Invalid metadata property __proto__");
    Object.values(value).forEach(json);
    return;
  }
  throw Error("Metadata must contain JSON values");
}
export function resourcePath(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value)
    throw Error("Resource path must be a nonempty string");
  if (/^https?:\/\//i.test(value)) {
    new URL(value);
    return;
  }
  // Frictionless paths are siblings/children, or fully qualified HTTP(S) URLs.
  if (/^[a-z][\w+.-]*:/i.test(value) || value.startsWith("//"))
    throw Error("Resource paths must be relative or HTTP(S) URLs");
  filePath(value.replace(/^\.\//, ""));
}
export function parseResource(source: string): DataResource {
  const value: unknown = JSON.parse(source);
  json(value);
  if (!object(value) || typeof value.name !== "string" || !value.name.trim())
    throw Error("A Data Resource requires a name");
  if (Object.hasOwn(value, "path") === Object.hasOwn(value, "data"))
    throw Error("A Data Resource requires exactly one of path or data");
  if (Object.hasOwn(value, "path")) {
    const paths = Array.isArray(value.path) ? value.path : [value.path];
    if (!paths.length) throw Error("Resource path must not be empty");
    paths.forEach(resourcePath);
    if (
      new Set(paths.map((path) => /^https?:\/\//i.test(path as string))).size >
      1
    )
      throw Error("Resource paths cannot mix local paths and URLs");
  }
  if (Object.hasOwn(value, "data")) {
    if (
      typeof value.data !== "string" &&
      !object(value.data) &&
      !Array.isArray(value.data)
    )
      throw Error("Inline resource data must be a string, array or object");
    if (typeof value.data === "string" && !value.format && !value.mediatype)
      throw Error("Inline text data requires format or mediatype");
  }
  for (const key of ["metadata", "saddle"])
    if (value[key] !== undefined && !object(value[key]))
      throw Error(`${key} must be a JSON object`);
  for (const key of [
    "title",
    "description",
    "format",
    "mediatype",
    "encoding",
    "$schema",
  ])
    if (value[key] !== undefined && typeof value[key] !== "string")
      throw Error(`${key} must be a string`);
  const contentType = (value.saddle as JSONObject | undefined)?.contentType;
  if (
    contentType !== undefined &&
    (typeof contentType !== "string" || !contentType.trim())
  )
    throw Error("saddle.contentType must be a nonempty string");
  return value as DataResource;
}
export function newResource(path: string): DataResource {
  const name = path.split("/").pop()!;
  return {
    $schema: resourceProfile,
    name:
      name
        .replace(/\.[^.]+$/, "")
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, "-") || "file",
    path: name,
  };
}
export const serializeResource = (value: DataResource) =>
  JSON.stringify(value, null, 2) + "\n";
/** Preserve explicit resource links; retarget the default self-reference on copy/move. */
export function relocatedResource(
  value: DataResource | null,
  from: string,
  to: string,
) {
  const next = value ? structuredClone(value) : null;
  if (next && next.path === from.split("/").pop())
    next.path = to.split("/").pop()!;
  return next;
}
export const resourceContentType = (
  value: DataResource | null,
): string | null =>
  typeof value?.saddle?.contentType === "string"
    ? value.saddle.contentType
    : null;
export function setResourceContentType(
  value: DataResource | null,
  path: string,
  contentType: string | null,
) {
  if (!value && !contentType) return null;
  const next = structuredClone(value ?? newResource(path));
  next.saddle ??= {};
  if (contentType) next.saddle.contentType = contentType;
  else delete next.saddle.contentType;
  return next;
}
export interface FileMetadata {
  resource: DataResource | null;
  properties: JSONObject;
  links: string[];
  terms: string[];
  contentType: string | null;
}
/** Markdown is converted to the same JSON metadata input before merging. */
export function importMetadata(
  path: string,
  mime: string,
  source: string,
  resource: DataResource | null,
): FileMetadata {
  const inline: JSONObject =
    mime === "text/markdown"
      ? (frontmatter(source).properties as JSONObject)
      : {};
  json(inline);
  const properties: JSONObject = Object.create(null);
  const add = (values: JSONObject) => {
    for (const [key, value] of Object.entries(values)) {
      if (Object.hasOwn(properties, key))
        throw Error(`Metadata conflict: ${key} is defined more than once`);
      properties[key] = value;
    }
  };
  if (resource) {
    parseResource(serializeResource(resource));
    add(
      Object.fromEntries(
        Object.entries(resource).filter(
          ([key, value]) =>
            value !== undefined && !["path", "data", "metadata"].includes(key),
        ),
      ) as JSONObject,
    );
    add(resource.metadata ?? {});
  }
  if (resource?.path && Object.hasOwn(inline, "path"))
    throw Error("Metadata conflict: path is defined more than once");
  add(
    Object.fromEntries(
      Object.entries(inline).filter(
        ([key]) => !["path", "metadata"].includes(key),
      ),
    ),
  );
  if (inline.metadata !== undefined) {
    if (!object(inline.metadata))
      throw Error("Inline metadata must be a JSON object");
    add(inline.metadata);
  }
  const links = resource?.path
    ? typeof resource.path === "string"
      ? [resource.path]
      : resource.path
    : [];
  if (inline.path !== undefined) {
    const paths = Array.isArray(inline.path) ? inline.path : [inline.path];
    paths.forEach(resourcePath);
    links.push(...(paths as string[]));
  }
  const terms: string[] = [];
  const flatten = (value: JSONValue, key: string) => {
    terms.push(key);
    if (Array.isArray(value)) value.forEach((item) => flatten(item, key));
    else if (object(value))
      Object.entries(value).forEach(([child, item]) =>
        flatten(item, key + "." + child),
      );
    else if (value !== null)
      terms.push(String(value), key + ":" + String(value));
  };
  Object.entries(properties).forEach(([key, value]) => flatten(value, key));
  if (mime === "text/markdown") terms.push(...noteMetadata(source).tags);
  return {
    resource,
    properties,
    links,
    terms: [...new Set(terms)],
    contentType: resourceContentType(resource),
  };
}
export interface MetadataDiagnostic {
  file: string;
  message: string;
  checkedAt: string;
}
/** Local diagnostics only. Never include this cache in file or share documents. */
export class MetadataErrors {
  readonly entries = new Map<string, MetadataDiagnostic>();
  clear(file: string) {
    this.entries.delete(file);
  }
  set(file: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (this.entries.get(file)?.message === message) return;
    this.entries.set(file, {
      file,
      message,
      checkedAt: new Date().toISOString(),
    });
  }
}
