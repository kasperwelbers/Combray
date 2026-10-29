/**
 * Convert recipes from data-donation-importers (`src/recipes.js`) into importer specs.
 * The mapping is mechanical and best effort: anything that cannot be expressed is reported in
 * `warnings`, so a person can finish the spec by hand.
 */
import type { FieldSpec, ImporterSpec, Transform } from './spec';

export interface OldRecipe {
  name: string;
  file: string[];
  filetype: 'json' | 'csv' | 'html' | string;
  rows_selector: string | string[];
  columns: { name: string; selector: string | string[] }[];
  transformers?: {
    transformer: string;
    column?: string;
    new_column?: string;
    arguments?: Record<string, unknown>;
  }[];
}

export interface ConvertedRecipe {
  spec: ImporterSpec;
  warnings: string[];
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function alternatives(names: string[]): string {
  return names.length === 1 ? names[0]! : `{${names.join(',')}}`;
}

/** `subtitles[0].name` → `subtitles/[0]/name`. */
function jsonSelector(selector: string): string {
  return selector
    .replace(/^\$\.?/, '')
    .replace(/\[(\d+|\*)\]/g, '.[$1]')
    .split('.')
    .filter(Boolean)
    .join('/');
}

/**
 * A simple CSS selector to a path below the row: descendant combinators become `**`, child
 * combinators `/`. Returns the path and the attribute (`@href`) or `@INNER` marker, if any.
 */
function cssSelector(selector: string, warnings: string[]): { path: string; nth: number } {
  let nth = 0;
  const parts: string[] = [];
  let child = false;
  for (const token of selector.trim().split(/\s+/)) {
    if (token === '>') {
      child = true;
      continue;
    }
    let segment = token;
    const nthMatch = /:nth-of-type\((\d+)\)$/.exec(segment);
    if (nthMatch) {
      nth = Number(nthMatch[1]) - 1;
      segment = segment.slice(0, nthMatch.index);
    } else if (segment.includes(':')) {
      warnings.push(`unsupported CSS pseudo-class in '${selector}'`);
      segment = segment.slice(0, segment.indexOf(':'));
    }
    if (segment.startsWith('@')) {
      if (segment === '@INNER') {
        warnings.push(`'@INNER' (inner HTML) became the element's text in '${selector}'`);
        continue;
      }
      parts.push(segment);
      continue;
    }
    if (!child) parts.push('**');
    parts.push(segment);
    child = false;
  }
  return { path: parts.join('/'), nth };
}

function regexWhere(column: string, regex: string, remove: boolean, caseSensitive: boolean): string {
  const op = `${remove ? '!' : ''}~${caseSensitive ? '' : '*'}`;
  return `${column} ${op} '${regex.replace(/'/g, "\\'")}'`;
}

export function convertRecipe(recipe: OldRecipe): ConvertedRecipe {
  const warnings: string[] = [];
  const html = recipe.filetype === 'html';
  const csv = recipe.filetype === 'csv';
  const fields: Record<string, FieldSpec> = {};
  const where: string[] = [];

  const rowsSelector = (Array.isArray(recipe.rows_selector) ? recipe.rows_selector : [recipe.rows_selector])[0] ?? '';
  let rows: string;
  if (html) {
    rows = cssSelector(rowsSelector, warnings).path;
  } else {
    const base = jsonSelector(rowsSelector);
    rows = base === '' ? '[*]' : `${base}/[*]`;
  }

  for (const column of recipe.columns) {
    const selectors = Array.isArray(column.selector) ? column.selector : [column.selector];
    if (csv) {
      fields[column.name] = { path: alternatives(selectors) };
    } else if (html) {
      if (selectors.length > 1) warnings.push(`column ${column.name}: only the first selector was used`);
      const { path, nth } = cssSelector(selectors[0] ?? '', warnings);
      fields[column.name] = nth > 0 ? { path, nth } : { path };
    } else {
      const paths = selectors.map(jsonSelector);
      fields[column.name] = { path: paths.length === 1 ? paths[0]! : alternatives(paths) };
      if (paths.length > 1 && paths.some((p) => p.includes('/'))) {
        warnings.push(`column ${column.name}: alternatives with nested paths need checking`);
      }
    }
  }

  for (const t of recipe.transformers ?? []) {
    const args = t.arguments ?? {};
    const column = t.column ?? '';
    const target = t.new_column || column;
    const source = fields[column];
    const derive = (spec: Omit<FieldSpec, 'path' | 'from'>, transform?: Transform) => {
      if (!source) {
        warnings.push(`${t.transformer}: unknown column '${column}'`);
        return;
      }
      if (target === column) {
        Object.assign(source, spec);
        if (transform) source.transform = [...(source.transform ?? []), transform];
      } else {
        fields[target] = { from: column, ...spec, ...(transform ? { transform: [transform] } : {}) };
      }
    };
    switch (t.transformer) {
      case 'int_to_date': {
        const unit = String(args.unit ?? 'millisecond');
        const format = unit === 'microsecond' ? 'epoch-us' : unit === 'second' ? 'epoch-s' : 'epoch-ms';
        derive({ as: 'datetime', format });
        break;
      }
      case 'str_to_date': {
        const formats = Array.isArray(args.format) ? (args.format as string[]) : [];
        if (formats.length > 1) warnings.push(`str_to_date on ${column}: only the first format was kept`);
        derive(formats[0] ? { as: 'datetime', format: formats[0] } : { as: 'datetime' });
        break;
      }
      case 'replace':
        derive({}, {
          replace: {
            pattern: String(args.regex ?? ''),
            with: String(args.replacement ?? ''),
            ignore_case: !args['case sensitive'],
          },
        });
        break;
      case 'url_to_domain':
        derive({}, 'domain');
        break;
      case 'tokenize_string':
        derive({}, 'tokenize');
        break;
      case 'filter_regex':
        where.push(
          regexWhere(column, String(args.regex ?? ''), Boolean(args['rm selected']), Boolean(args['case sensitive'])),
        );
        break;
      case 'filter': {
        const expression = String(args.expression ?? '');
        where.push(args['rm selected'] ? `not (${expression})` : expression);
        break;
      }
      default:
        warnings.push(`unsupported transformer '${t.transformer}'`);
    }
  }

  // Fields derived with `from` must come after their source; JS objects keep insertion order.
  const spec: ImporterSpec = {
    id: `converted/${slug(recipe.name)}`,
    version: 1,
    name: recipe.name,
    match: { file: `**/${alternatives(recipe.file)}` },
    select: { rows, fields },
  };
  if (where.length > 0) spec.where = where.map((w) => (where.length > 1 ? `(${w})` : w)).join(' and ');
  return { spec, warnings };
}
