import {
  CSDBDatabase,
  parseDocument,
  encodeValue,
  decodeCell,
  columnType,
  storedColumnNames,
  type CSDBMetadata,
  type SchemaDefinition,
  type TableSchema,
} from "@csvdatabase/csdb/portable";
import { canonical } from "../crypto.js";
export interface CSDBRowState {
  position: number;
  cells: Record<string, string | null>;
}
export interface CSDBTableState {
  schema: string;
  rows: Record<string, CSDBRowState>;
}
export interface CSDBState {
  metadata: string;
  schemas: Record<string, string>;
  tables: Record<string, CSDBTableState>;
}
/** Primary-keyed cells merge independently; CSDB commands produce the CSV projection. */
export function csdbState(
  source: string,
  previous?: CSDBState | null,
): CSDBState {
  const doc = parseDocument(source),
    tables: CSDBState["tables"] = {};
  for (const table of doc.tables.values()) {
    const rows: CSDBTableState["rows"] = {},
      used = new Set<string>();
    const prior = table.schema.primary_key
      ? []
      : Object.entries(previous?.tables[table.name]?.rows ?? {}).sort(
          (a, b) => a[1].position - b[1].position || a[0].localeCompare(b[0]),
        );
    const byCells = new Map<string, string[]>();
    for (const [key, candidate] of [...prior].reverse()) {
      const value = canonical(candidate.cells),
        keys = byCells.get(value) ?? [];
      keys.push(key);
      byCells.set(value, keys);
    }
    let priorCursor = 0;
    table.rows.forEach((row, position) => {
      const cells = Object.fromEntries(
        storedColumnNames(table.schema).map((column) => [
          column,
          row[column] === null
            ? null
            : encodeValue(
                column,
                columnType(table, column),
                row[column],
                table.schema.required.includes(column),
              ),
        ]),
      );
      let key: string;
      if (table.schema.primary_key)
        key =
          "key:" +
          JSON.stringify(
            table.schema.primary_key.columns.map((column) => cells[column]),
          );
      else {
        const candidates = byCells.get(canonical(cells));
        while (
          candidates?.length &&
          used.has(candidates[candidates.length - 1])
        )
          candidates.pop();
        while (priorCursor < prior.length && used.has(prior[priorCursor][0]))
          priorCursor++;
        key =
          candidates?.pop() ??
          prior[priorCursor]?.[0] ??
          "row:" + crypto.randomUUID();
      }
      used.add(key);
      rows[key] = { position, cells };
    });
    tables[table.name] = { schema: canonical(table.schema), rows };
  }
  return {
    metadata: canonical(doc.metadata),
    schemas: Object.fromEntries(
      [...doc.schemas].map(([name, schema]) => [name, canonical(schema)]),
    ),
    tables,
  };
}
export function csdbText(state: CSDBState) {
  const original = JSON.parse(state.metadata) as CSDBMetadata;
  const db = CSDBDatabase.create(original);
  const schemas: Record<string, SchemaDefinition> = Object.fromEntries(
    Object.entries(state.schemas).map(([name, value]) => [
      name,
      JSON.parse(value),
    ]),
  );
  const order = [...new Set([...original.schemas, ...Object.keys(schemas)])];
  for (const name of order) if (schemas[name]) db.createSchema(schemas[name]);
  const tableOrder = [
    ...original.tables.filter((name) => state.tables[name]),
    ...Object.keys(state.tables)
      .filter((name) => !original.tables.includes(name))
      .sort(),
  ];
  const definitions = tableOrder.map((key) => {
    const definition = JSON.parse(state.tables[key].schema) as TableSchema;
    // Restore references after every table and row exists, including cycles.
    db.createTable({ ...definition, foreign_keys: [] });
    return definition;
  });
  for (const [index, key] of tableOrder.entries()) {
    const stored = state.tables[key],
      definition = definitions[index];
    const name = `${definition.schema}.${definition.name}`;
    const table = db.document.tables.get(name)!;
    const rows = Object.entries(stored.rows)
      .sort((a, b) => a[1].position - b[1].position || a[0].localeCompare(b[0]))
      .map(([, stored]) =>
        Object.fromEntries(
          storedColumnNames(table.schema).map((column) => {
            const cell = stored.cells[column];
            return [
              column,
              decodeCell(
                column,
                columnType(table, column),
                { text: cell ?? "", quoted: cell === "" },
                table.schema.required.includes(column),
              ),
            ];
          }),
        ),
      );
    if (rows.length) db.table(name).insert(rows);
  }
  for (const definition of definitions)
    if (definition.foreign_keys?.length) db.alterTable(definition);
  return db.toString();
}
export function updateCSDB(target: CSDBState, next: CSDBState) {
  if (target.metadata !== next.metadata) target.metadata = next.metadata;
  for (const name of Object.keys(target.schemas))
    if (!next.schemas[name]) delete target.schemas[name];
  for (const [name, definition] of Object.entries(next.schemas))
    if (target.schemas[name] !== definition) target.schemas[name] = definition;
  for (const name of Object.keys(target.tables))
    if (!next.tables[name]) delete target.tables[name];
  for (const [name, table] of Object.entries(next.tables)) {
    if (!target.tables[name]) {
      target.tables[name] = table;
      continue;
    }
    const prior = target.tables[name];
    if (prior.schema !== table.schema) prior.schema = table.schema;
    for (const key of Object.keys(prior.rows))
      if (!table.rows[key]) delete prior.rows[key];
    for (const [key, row] of Object.entries(table.rows)) {
      if (!prior.rows[key]) {
        prior.rows[key] = row;
        continue;
      }
      const old = prior.rows[key];
      if (old.position !== row.position) old.position = row.position;
      for (const column of Object.keys(old.cells))
        if (!(column in row.cells)) delete old.cells[column];
      for (const [column, cell] of Object.entries(row.cells))
        if (old.cells[column] !== cell) old.cells[column] = cell;
    }
  }
}
