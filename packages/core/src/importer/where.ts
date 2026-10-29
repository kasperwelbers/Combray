/**
 * Row filters: a small expression language, parsed and evaluated without `eval`.
 *
 *   url ~ 'google\.com/search' and not (details != null)
 *
 * Operators: `==`, `!=`, `<`, `<=`, `>`, `>=`, `~` (regex), `~*` (regex, ignore case),
 * `!~`, `!~*`, `and`, `or`, `not`, parentheses. Operands: field names, 'strings' or
 * "strings", numbers, `null`, `true`, `false`. A bare operand is true when it is not null,
 * empty, `false` or 0.
 */

type Op = '==' | '!=' | '<' | '<=' | '>' | '>=' | '~' | '~*' | '!~' | '!~*';

export type WhereNode =
  | { type: 'field'; name: string }
  | { type: 'literal'; value: string | number | boolean | null }
  | { type: 'compare'; op: Op; left: WhereNode; right: WhereNode }
  | { type: 'and' | 'or'; left: WhereNode; right: WhereNode }
  | { type: 'not'; operand: WhereNode };

type Token =
  | { t: 'op'; v: Op }
  | { t: 'word'; v: string }
  | { t: 'string'; v: string }
  | { t: 'number'; v: number }
  | { t: '(' }
  | { t: ')' };

const OPS: Op[] = ['!~*', '~*', '!~', '==', '!=', '<=', '>=', '<', '>', '~'];

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (c === '(' || c === ')') {
      tokens.push({ t: c });
      i++;
    } else if (c === "'" || c === '"') {
      let value = '';
      i++;
      while (i < input.length && input[i] !== c) {
        // A backslash escapes the quote; other backslashes are kept for regexes.
        if (input[i] === '\\' && input[i + 1] === c) {
          value += c;
          i += 2;
        } else {
          value += input[i++];
        }
      }
      if (i >= input.length) throw new Error('unclosed string');
      i++;
      tokens.push({ t: 'string', v: value });
    } else {
      const op = OPS.find((o) => input.startsWith(o, i));
      if (op) {
        tokens.push({ t: 'op', v: op });
        i += op.length;
        continue;
      }
      const num = /^-?\d+(\.\d+)?/.exec(input.slice(i));
      if (num) {
        tokens.push({ t: 'number', v: Number(num[0]) });
        i += num[0].length;
        continue;
      }
      const word = /^[\p{L}\p{N}_.$-]+/u.exec(input.slice(i));
      if (!word) throw new Error(`unexpected '${c}'`);
      tokens.push({ t: 'word', v: word[0] });
      i += word[0].length;
    }
  }
  return tokens;
}

export function parseWhere(input: string): WhereNode {
  const tokens = tokenize(input);
  let pos = 0;
  const peek = () => tokens[pos];
  const isWord = (w: string) => {
    const tok = peek();
    return tok?.t === 'word' && tok.v.toLowerCase() === w;
  };

  function operand(): WhereNode {
    const tok = tokens[pos++];
    if (!tok) throw new Error('unexpected end of expression');
    switch (tok.t) {
      case '(': {
        const inner = or();
        if (tokens[pos++]?.t !== ')') throw new Error("missing ')'");
        return inner;
      }
      case 'string':
        return { type: 'literal', value: tok.v };
      case 'number':
        return { type: 'literal', value: tok.v };
      case 'word': {
        const lower = tok.v.toLowerCase();
        if (lower === 'null') return { type: 'literal', value: null };
        if (lower === 'true') return { type: 'literal', value: true };
        if (lower === 'false') return { type: 'literal', value: false };
        if (['and', 'or', 'not'].includes(lower)) throw new Error(`unexpected '${tok.v}'`);
        return { type: 'field', name: tok.v };
      }
      default:
        throw new Error(`unexpected '${tok.t === 'op' ? tok.v : tok.t}'`);
    }
  }

  function compare(): WhereNode {
    const left = operand();
    const tok = peek();
    if (tok?.t !== 'op') return left;
    pos++;
    const right = operand();
    if ((tok.v.includes('~')) && !(right.type === 'literal' && typeof right.value === 'string')) {
      throw new Error(`'${tok.v}' needs a quoted pattern on the right`);
    }
    if (tok.v.includes('~')) new RegExp((right as { value: string }).value);
    return { type: 'compare', op: tok.v, left, right };
  }

  function not(): WhereNode {
    if (isWord('not')) {
      pos++;
      return { type: 'not', operand: not() };
    }
    return compare();
  }

  function and(): WhereNode {
    let left = not();
    while (isWord('and')) {
      pos++;
      left = { type: 'and', left, right: not() };
    }
    return left;
  }

  function or(): WhereNode {
    let left = and();
    while (isWord('or')) {
      pos++;
      left = { type: 'or', left, right: and() };
    }
    return left;
  }

  const ast = or();
  if (pos < tokens.length) throw new Error('unexpected text after expression');
  return ast;
}

type Value = unknown;

function truthy(v: Value): boolean {
  return v !== null && v !== undefined && v !== false && v !== '' && v !== 0;
}

function asNumber(v: Value): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return undefined;
}

const regexCache = new Map<string, RegExp>();
function regex(pattern: string, flags: string): RegExp {
  const key = `${flags}/${pattern}`;
  let re = regexCache.get(key);
  if (!re) {
    re = new RegExp(pattern, flags);
    regexCache.set(key, re);
  }
  return re;
}

function evaluate(node: WhereNode, row: Record<string, Value>): Value {
  switch (node.type) {
    case 'field':
      return row[node.name] ?? null;
    case 'literal':
      return node.value;
    case 'not':
      return !truthy(evaluate(node.operand, row));
    case 'and':
      return truthy(evaluate(node.left, row)) && truthy(evaluate(node.right, row));
    case 'or':
      return truthy(evaluate(node.left, row)) || truthy(evaluate(node.right, row));
    case 'compare': {
      const left = evaluate(node.left, row);
      const right = evaluate(node.right, row);
      if (node.op.includes('~')) {
        const matched =
          left !== null && left !== undefined &&
          regex(String(right), node.op.endsWith('*') ? 'i' : '').test(String(left));
        return node.op.startsWith('!') ? !matched : matched;
      }
      if (node.op === '==' || node.op === '!=') {
        let equal: boolean;
        if (left === null || left === undefined || right === null || right === undefined) {
          equal = (left ?? null) === (right ?? null);
        } else {
          const a = asNumber(left);
          const b = asNumber(right);
          equal = a !== undefined && b !== undefined ? a === b : String(left) === String(right);
        }
        return node.op === '==' ? equal : !equal;
      }
      if (left === null || left === undefined || right === null || right === undefined) return false;
      const a = asNumber(left) ?? String(left);
      const b = asNumber(right) ?? String(right);
      if (typeof a !== typeof b) return false;
      switch (node.op) {
        case '<':
          return a < b;
        case '<=':
          return a <= b;
        case '>':
          return a > b;
        default:
          return a >= b;
      }
    }
  }
}

/** Compile an expression into a row predicate. */
export function compileWhere(input: string): (row: Record<string, unknown>) => boolean {
  const ast = parseWhere(input);
  return (row) => truthy(evaluate(ast, row));
}
