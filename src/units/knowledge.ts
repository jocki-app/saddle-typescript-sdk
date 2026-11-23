import YAML from "yaml";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import remarkMath from "remark-math";
import { visit } from "unist-util-visit";
import { toString } from "mdast-util-to-string";
import type { Definition } from "mdast";
import { LRUCache } from "vscode-jsonrpc";
import { filePath } from "./contracts.js";

export interface NoteLink {
  target: string;
  label?: string;
  embed: boolean;
  from: number;
  to: number;
  syntax: "wiki" | "markdown" | "definition";
  title?: string | null;
}
export interface Heading {
  text: string;
  level: number;
  line: number;
  offset: number;
}
export interface NoteMetadata {
  properties: Record<string, unknown>;
  aliases: string[];
  tags: string[];
  links: NoteLink[];
  headings: Heading[];
  blocks: Record<string, string>;
  footnotes: Record<string, string>;
}
export function frontmatter(source: string) {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
    source,
  );
  if (!match) return { properties: {} as Record<string, unknown>, length: 0 };
  const properties = YAML.parse(match[1], { maxAliasCount: 20 });
  if (
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  )
    throw Error("Markdown properties must be a YAML map");
  return {
    properties: properties as Record<string, unknown>,
    length: match[0].length,
  };
}
export function withProperties(
  source: string,
  properties: Record<string, unknown>,
) {
  const prior = frontmatter(source);
  return (
    "---\n" +
    YAML.stringify(properties).trimEnd() +
    "\n---\n" +
    source.slice(prior.length)
  );
}
const strings = (value: unknown) =>
  (Array.isArray(value) ? value : value ? [value] : []).filter(
    (v): v is string => typeof v === "string",
  );
const markdownParser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkFrontmatter, ["yaml"])
  .use(remarkMath);
const metadataCache = new LRUCache<string, NoteMetadata>(128);
export function noteMetadata(source: string): NoteMetadata {
  const cached = metadataCache.get(source);
  if (cached) return cached;
  let properties: Record<string, unknown> = {},
    length = 0;
  try {
    ({ properties, length } = frontmatter(source));
  } catch {
    /* Invalid YAML stays editable. */
  }
  const headings: Heading[] = [],
    blocks: Record<string, string> = {},
    footnotes: Record<string, string> = {};
  const tree = markdownParser.parse(source),
    links: NoteLink[] = [],
    tags = new Set(strings(properties.tags).map((t) => t.replace(/^#/, "")));
  const ignored: [number, number][] = [],
    definitions = new Map<string, Definition>(),
    references = new Set<string>();
  const internal = (target: string) =>
    !/^[a-z][\w+.-]*:/i.test(target) && !target.startsWith("//");
  visit(tree, (node) => {
    const from = node.position?.start.offset ?? 0,
      to = node.position?.end.offset ?? from;
    if (
      ["code", "inlineCode", "yaml", "math", "inlineMath", "html"].includes(
        node.type,
      )
    )
      ignored.push([from, to]);
    if (node.type === "definition")
      definitions.set(node.identifier.toLowerCase(), node);
    if (node.type === "linkReference" || node.type === "imageReference")
      references.add(node.identifier.toLowerCase());
    if ((node.type === "link" || node.type === "image") && internal(node.url))
      links.push({
        target: node.url,
        label: node.type === "image" ? (node.alt ?? undefined) : toString(node),
        embed: node.type === "image",
        from,
        to,
        syntax: "markdown",
        title: node.title,
      });
    if (node.type === "heading")
      headings.push({
        text: toString(node),
        level: node.depth,
        line: node.position!.start.line,
        offset: from,
      });
    if (node.type === "footnoteDefinition")
      footnotes[node.identifier] = toString(node);
    if (node.type === "paragraph" || node.type === "listItem") {
      const block = /\s\^([\w-]+)\s*$/.exec(source.slice(from, to));
      if (block)
        blocks[block[1]] = source.slice(from, to).replace(/\s\^[\w-]+\s*$/, "");
    }
    if (node.type === "text")
      for (const match of node.value.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu))
        tags.add(match[1]);
  });
  for (const reference of references) {
    const node = definitions.get(reference);
    if (node && internal(node.url))
      links.push({
        target: node.url,
        label: node.label ?? node.identifier,
        embed: false,
        from: node.position!.start.offset!,
        to: node.position!.end.offset!,
        syntax: "definition",
        title: node.title,
      });
  }
  // Wiki links and block IDs are SADDLE syntax layered on the Markdown AST.
  for (const match of source.matchAll(/(?<!\\)(!?)\[\[([^\]\n]+)\]\]/g)) {
    const from = match.index!,
      to = from + match[0].length;
    if (from < length || ignored.some(([a, b]) => from < b && to > a)) continue;
    const [target, label] = match[2].split("|");
    if (internal(target))
      links.push({
        target,
        label,
        embed: Boolean(match[1]),
        from,
        to,
        syntax: "wiki",
      });
  }
  const result = {
    properties,
    aliases: strings(properties.aliases ?? properties.alias),
    links,
    headings,
    blocks,
    footnotes,
    tags: [...tags],
  };
  metadataCache.set(source, result);
  return result;
}
export interface LinkableFile {
  id: string;
  path: string;
  text: string;
  vault: string;
  aliases?: string[];
  metadata?: Record<string, unknown>;
  metadataTerms?: string[];
  resourceLinks?: string[];
  kind?: "folder" | "metadata" | "external";
}
export function resolveLink(
  target: string,
  source: LinkableFile,
  files: LinkableFile[],
): LinkableFile[] {
  let path: string;
  try {
    path = decodeURIComponent(target.split("#")[0]);
  } catch {
    return [];
  }
  if (!path) return [source];
  const parts = source.path.split("/").slice(0, -1);
  for (const part of path.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== ".") parts.push(part);
  }
  const relative = parts.join("/");
  const matches = (actual: string, requested: string) =>
    actual === requested || actual === requested + ".md";
  const local = files.filter(
    (f) =>
      f.vault === source.vault &&
      (matches(f.path, relative) || matches(f.path, path.replace(/^\//, ""))),
  );
  if (local.length) return local;
  const name = path.replace(/\.md$/, "");
  return files.filter(
    (f) =>
      f.vault === source.vault &&
      (f.path.split("/").pop()!.replace(/\.md$/, "") === name ||
        (f.aliases ?? noteMetadata(f.text).aliases).includes(name)),
  );
}
export function embeddedText(source: string, subpath?: string) {
  if (!subpath) return source;
  const target = subpath.replace(/^#/, ""),
    meta = noteMetadata(source);
  if (target.startsWith("^")) return meta.blocks[target.slice(1)] ?? "";
  const index = meta.headings.findIndex(
    (h) => h.text.toLowerCase() === target.toLowerCase(),
  );
  if (index < 0) return "";
  const heading = meta.headings[index],
    end =
      meta.headings.slice(index + 1).find((h) => h.level <= heading.level)
        ?.offset ?? source.length;
  return source.slice(heading.offset, end);
}
export function rewriteMovedLinks(
  source: LinkableFile,
  moved: LinkableFile,
  newPath: string,
  files: LinkableFile[],
) {
  filePath(newPath);
  let result = source.text;
  for (const link of [...noteMetadata(source.text).links].sort(
    (a, b) => b.from - a.from,
  )) {
    const resolved = resolveLink(link.target, source, files);
    if (
      resolved.length !== 1 ||
      resolved[0].id !== moved.id ||
      resolved[0].vault !== moved.vault
    )
      continue;
    const fragment = link.target.includes("#")
      ? "#" + link.target.split("#").slice(1).join("#")
      : "";
    const target = newPath + fragment;
    const title = link.title ? " " + JSON.stringify(link.title) : "";
    const replacement =
      link.syntax === "wiki"
        ? `${link.embed ? "!" : ""}[[${target}${link.label ? "|" + link.label : ""}]]`
        : link.syntax === "definition"
          ? `[${link.label}]: ${encodeURI(target)}${title}`
          : `${link.embed ? "!" : ""}[${link.label ?? ""}](${encodeURI(target)}${title})`;
    result = result.slice(0, link.from) + replacement + result.slice(link.to);
  }
  return result;
}
export function graph(
  files: LinkableFile[],
  center?: string,
  depth = 1,
  options = { links: true, metadata: false, hierarchy: false },
) {
  const all = [...files];
  const edges: Array<{
    from: string;
    to: string;
    kind?: "metadata" | "hierarchy";
  }> = [];
  const nodes = new Map<string, LinkableFile>();
  const auxiliary = (
    vault: string,
    id: string,
    path: string,
    kind: "folder" | "metadata" | "external",
  ) => {
    const key = `${vault}/${id}`;
    if (!nodes.has(key)) {
      const value = { vault, id, path, text: "", kind };
      nodes.set(key, value);
      all.push(value);
    }
    return key;
  };
  for (const file of files) {
    const from = `${file.vault}/${file.id}`;
    if (options.links)
      for (const target of [
        ...noteMetadata(file.text).links.map((link) => link.target),
        ...(file.resourceLinks ?? []),
      ]) {
        if (/^https?:\/\//i.test(target))
          edges.push({
            from,
            to: auxiliary(file.vault, "external:" + target, target, "external"),
          });
        else
          for (const to of resolveLink(target, file, files))
            if (`${to.vault}/${to.id}` !== from)
              edges.push({ from, to: `${to.vault}/${to.id}` });
      }
    if (options.metadata)
      for (const term of file.metadataTerms ?? noteMetadata(file.text).tags)
        edges.push({
          from,
          to: auxiliary(file.vault, "metadata:" + term, term, "metadata"),
          kind: "metadata",
        });
    if (options.hierarchy) {
      const parts = file.path.split("/").slice(0, -1);
      let parent = auxiliary(file.vault, "folder:", "/", "folder");
      for (let index = 1; index <= parts.length; index++) {
        const path = parts.slice(0, index).join("/"),
          child = auxiliary(file.vault, "folder:" + path, path, "folder");
        if (
          !edges.some(
            (edge) =>
              edge.from === parent &&
              edge.to === child &&
              edge.kind === "hierarchy",
          )
        )
          edges.push({ from: parent, to: child, kind: "hierarchy" });
        parent = child;
      }
      edges.push({ from: parent, to: from, kind: "hierarchy" });
    }
  }
  if (!center) return { files: all, edges };
  const visible = new Set([center]);
  for (let level = 0; level < Math.min(depth, 20); level++) {
    const prior = new Set(visible);
    edges.forEach((e) => {
      if (prior.has(e.from) || prior.has(e.to)) {
        visible.add(e.from);
        visible.add(e.to);
      }
    });
  }
  return {
    files: all.filter((f) => visible.has(`${f.vault}/${f.id}`)),
    edges: edges.filter((e) => visible.has(e.from) && visible.has(e.to)),
  };
}
