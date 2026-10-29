import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  deriveRows,
  deriveTables,
  extractShape,
  normalizeTree,
  parseFile,
  projectTreeFromShape,
  type Shape,
} from '../src';
import { activityHtml } from './fixtures';

const takeoutHtml = new URL(
  '../../../importers/fixtures/google-takeout-nl-html/input/Takeout/Mijn activiteit/Zoeken/MijnActiviteit.html',
  import.meta.url,
);

function names(shape: Shape, depth = 0, out: string[] = []): string[] {
  out.push(`${'  '.repeat(depth)}${shape.kind} ${shape.name}${shape.types ? ` (${shape.types.join(',')})` : ''}`);
  for (const c of shape.children ?? []) names(c, depth + 1, out);
  return out;
}

describe('normalizeTree', () => {
  it('turns text into typed positional values and links into @href', () => {
    const shape = extractShape(normalizeTree(activityHtml));
    const lines = names(shape).join('\n');
    expect(lines).toContain('value #text[0] (string)');
    expect(lines).toContain('value #text[1] (date-like)');
    expect(lines).toContain('value @href (url-like)');
    expect(lines).not.toContain('script');
    expect(lines).not.toContain(' text ');
  });

  it('finds repeated rows in Google Takeout HTML and keeps one name per position', () => {
    const tree = normalizeTree(parseFile('MijnActiviteit.html', new Uint8Array(readFileSync(takeoutHtml))));
    const html = readFileSync(takeoutHtml, 'utf8');
    const cells = html.match(/<div class="outer-cell[\s\S]*?<\/div><\/div><\/div>/g)!;
    const tripled = html.replace(cells.join(''), [...cells, ...cells, cells[0]].join(''));
    const shape = extractShape(normalizeTree(parseFile('MijnActiviteit.html', new TextEncoder().encode(tripled))));
    const lines = names(shape).join('\n');
    expect(lines).toMatch(/list div\.[^\n]*outer-cell/);
    expect(lines).toContain('value #text[1] (date-like)');
    expect(lines).not.toContain('br');
    expect(tree).toBeDefined();

    // The rows become an implicit table with the date as a column.
    const project = projectTreeFromShape({ ...shape, name: '' });
    const tables = deriveTables(project);
    const rows = tables.find((t) => t.rows?.at(-1) === '[*]')!;
    expect(rows).toBeDefined();
    const table = deriveRows(normalizeTree(parseFile('x.html', new TextEncoder().encode(tripled))), project, tables);
    const index = tables.indexOf(rows);
    expect(table[index]).toHaveLength(5);
    expect(deriveRows(tree, project, tables)[index]).toHaveLength(2);
    const values = JSON.stringify(table[index]![0]!.values);
    expect(values).toContain('5 mrt 2024, 11:00:00 CET');
    expect(values).toContain('https://www.google.com/search?q=meidoorn');
  });
});

describe('single elements where other files repeat them', () => {
  it('give their values to the list column', () => {
    const page = (n: number) =>
      `<div class="r"><p>a</p></div><div class="r">${Array.from({ length: n }, (_, i) => `<a href="https://e.com/${i}">x</a>`).join('')}</div>`;
    const many = normalizeTree(parseFile('a.html', new TextEncoder().encode(page(3))));
    const one = normalizeTree(parseFile('b.html', new TextEncoder().encode(page(1))));
    const project = projectTreeFromShape(extractShape(many));
    const tables = deriveTables(project);
    const rows = deriveRows(one, project, tables);
    const hrefs = rows.flat().flatMap((r) => Object.entries(r.values).filter(([k]) => k.endsWith('@href')).map(([, v]) => v));
    expect(hrefs).toContain('https://e.com/0');
  });
});
