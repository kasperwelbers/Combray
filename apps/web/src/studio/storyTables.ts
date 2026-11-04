/** The tables a story can show, from a platform's project tree, for the story editor. */
import { localize, type ColumnDef, type Localized, type TableDef } from '@combray/core';

/** A table participants can have, from one of the project's platforms. */
export interface StoryTable {
  platform: string;
  platformName: Localized;
  id: string;
  name: Localized;
  /** Columns with one value (or a list of values) per row; nested tables' columns as `table/column`. */
  columns: { id: string; name: string }[];
  /** Columns read as dates and times. The first one with the date role is the table's date. */
  dates: { id: string; name: string }[];
  date?: string;
}

const isDate = (c: ColumnDef) => c.role === 'date' || c.as === 'datetime';

/** The tables of a platform's tree that participants see, by id (tables that share a name are one). */
export function storyTables(platform: string, platformName: Localized, tables: TableDef[]): StoryTable[] {
  const out = new Map<string, StoryTable>();
  tables.forEach((table) => {
    if (table.parent !== undefined || table.rows === undefined) return;
    const entry = out.get(table.id) ?? { platform, platformName, id: table.id, name: table.name, columns: [], dates: [] };
    const add = (list: { id: string; name: string }[], id: string, name: string) => {
      if (!list.some((c) => c.id === id)) list.push({ id, name });
    };
    for (const column of table.columns) {
      const name = localize(column.name, 'en') || column.id;
      if (column.type === 'table') {
        // Nested tables count their values in each row, as the participant's views do.
        for (const nested of tables[column.table!]?.columns ?? []) {
          if (nested.type === 'value' || nested.type === 'list')
            add(entry.columns, `${column.id}/${nested.id}`, `${name} › ${localize(nested.name, 'en') || nested.id}`);
        }
        continue;
      }
      add(entry.columns, column.id, name);
      if (isDate(column)) {
        add(entry.dates, column.id, name);
        if (column.role === 'date' && entry.date === undefined) entry.date = column.id;
      }
    }
    entry.date ??= entry.dates[0]?.id;
    out.set(table.id, entry);
  });
  return [...out.values()];
}
