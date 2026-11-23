import {
  CSDBDatabase,
  parseDocument,
  serializeDocument,
  resolveType,
  type QueryPlan,
} from "@csvdatabase/csdb/portable";
import type { ContentType } from "./contracts.js";
import { canonical } from "../crypto.js";

export {
  parseDocument as parseCSDB,
  serializeDocument as serializeCSDB,
  CSDBDatabase,
};
export type {
  CSDBDocument,
  Row,
  RowValue,
  TableSchema,
  ColumnType,
  QueryPlan,
} from "@csvdatabase/csdb/portable";
/** The official CSDB in-memory command API; FileVault owns durable Save. */
export class CSDBDraft extends CSDBDatabase {
  constructor(value: string) {
    super(parseDocument(value));
  }
}
export const taskTable = "public.tasks";
export interface CSDBRowSelection {
  /** Header saves may also persist this file's portable view metadata. */
  metadata?: boolean;
  table: string;
  ids: string[];
}
/** Exact, stable comparison of SDK values, including bigint cells. */
export function csdbComparable(value: unknown): string {
  return canonical(
    JSON.parse(
      JSON.stringify(value ?? null, (_key, item) =>
        typeof item === "bigint" ? { "$csdb.bigint": item.toString() } : item,
      ),
    ),
  );
}
/** Apply selected row edits through CSDB commands, leaving other draft rows private. */
export function selectedCSDBRows(
  original: string,
  working: string,
  selection: CSDBRowSelection,
) {
  const db = new CSDBDraft(original),
    source = parseDocument(working);
  const before = db.document.tables.get(selection.table),
    after = source.tables.get(selection.table);
  if (
    !before ||
    !after ||
    csdbComparable(before.schema) !== csdbComparable(after.schema) ||
    csdbComparable([...db.document.schemas]) !==
      csdbComparable([...source.schemas]) ||
    csdbComparable(db.document.metadata) !== csdbComparable(source.metadata)
  )
    throw Error("Save column and table changes before saving individual rows");
  if (before.schema.primary_key?.columns.join() !== "id")
    throw Error("Saving individual rows requires ID as the primary key");
  const plans: QueryPlan[] = [];
  const previousRows = new Map(before.rows.map((row) => [row.id, row])),
    nextRows = new Map(after.rows.map((row) => [row.id, row]));
  for (const id of new Set(selection.ids)) {
    const prior = previousRows.get(id),
      next = nextRows.get(id);
    if (!prior && !next) throw Error("A selected task is no longer available");
    if (csdbComparable(prior ?? null) === csdbComparable(next ?? null))
      continue;
    const where: import("@csvdatabase/csdb/portable").Expr = {
      type: "comparison",
      op: "=",
      left: { type: "identifier", name: "id" },
      right: { type: "literal", value: id },
    };
    if (!next) plans.push({ kind: "delete", table: selection.table, where });
    else if (!prior)
      plans.push({ kind: "insert", table: selection.table, rows: [next] });
    else
      plans.push({ kind: "update", table: selection.table, set: next, where });
  }
  if (plans.length) db.batch(plans);
  return db.toString();
}
