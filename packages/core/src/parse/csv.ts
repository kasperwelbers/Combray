import Papa from 'papaparse';

import type { ListNode, MapNode } from '../tree';
import { valueNode } from './text';

/** CSV / TSV: a list of maps keyed by header. The delimiter is sniffed. */
export function parseCsv(name: string, text: string): ListNode {
  const result = Papa.parse<string[]>(text.replace(/^﻿/, ''), {
    header: false,
    skipEmptyLines: 'greedy',
    delimiter: name.toLowerCase().endsWith('.tsv') ? '\t' : '',
  });
  const [header, ...rows] = result.data;
  if (!header) return { kind: 'list', name, children: [] };
  const keys = uniqueKeys(header);
  const children: MapNode[] = rows.map((row, i) => ({
    kind: 'map',
    name: String(i),
    children: keys.map((key, j) => valueNode(key, row[j] ?? '')),
  }));
  return { kind: 'list', name, children };
}

/** Empty headers become `column_N`; duplicates get a numeric suffix. */
function uniqueKeys(header: string[]): string[] {
  const seen = new Map<string, number>();
  return header.map((raw, i) => {
    const base = raw.trim() || `column_${i + 1}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}_${n + 1}`;
  });
}
