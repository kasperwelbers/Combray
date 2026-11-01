/**
 * Merge suggestions: when a new export has a node where the project tree has a different one
 * at the same place, they may be the same thing renamed or translated (`date` and
 * `timestamp`, `Mijn activiteit` and `My Activity`). See docs/tree-decisions.md#aliases-and-merging.
 *
 * Suggestions are pairs of siblings: one the shape has and the tree does not know, and one
 * the tree has and the shape lacks, of the same kind. They are ranked by how alike their
 * structure and names are, and each node is suggested at most once. The researcher decides.
 */
import { getNode, matchChild, type NodePath, type ProjectNode } from './decisions';
import { COLLAPSED_NAME, ITEM_NAME, type Shape } from './shape';

export interface MergeSuggestion {
  /** The node the shape added (after `mergeShape`, this path exists in the tree). */
  from: NodePath;
  /** The known node it may be the same as. */
  into: NodePath;
  /** 0 to 1: how alike they are. */
  score: number;
}

/** Below this, a pair is not suggested. */
export const MIN_SCORE = 0.35;

type Node = Pick<Shape, 'kind' | 'name' | 'types' | 'formats' | 'children'>;

/** Character pairs of a name, for comparing names (Dice coefficient). */
function bigrams(name: string): Map<string, number> {
  const s = name.toLowerCase().replace(/\.[a-z0-9]{1,5}$/, '');
  const out = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) out.set(s.slice(i, i + 2), (out.get(s.slice(i, i + 2)) ?? 0) + 1);
  return out;
}

function nameSimilarity(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  let shared = 0;
  let total = 0;
  for (const [k, n] of x) shared += Math.min(n, y.get(k) ?? 0);
  for (const n of x.values()) total += n;
  for (const n of y.values()) total += n;
  return total === 0 ? (a === b ? 1 : 0) : (2 * shared) / total;
}

/**
 * What is below a node: each leaf with the last steps of its path and its types. Only the
 * last steps count, so a renamed folder higher up does not hide that the leaves are the same.
 */
function signature(node: Node, out = new Set<string>(), steps: string[] = []): Set<string> {
  for (const child of node.children ?? []) {
    const path = [...steps, `${child.kind}:${child.name}`];
    if (!child.children) out.add(`${path.slice(-3).join('/')}=${(child.types ?? []).join(',')}`);
    else signature(child, out, path);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / (a.size + b.size - shared);
}

/** How alike two nodes of the same kind are, from 0 to 1. Leaves need a type in common. */
function similarity(a: Node, b: Node): number {
  const names = nameSimilarity(a.name, b.name);
  if (!a.children && !b.children) {
    const types = new Set(a.types ?? []);
    if (a.types && b.types && !b.types.some((t) => types.has(t))) return 0;
    const sameTypes = jaccard(new Set(a.types ?? []), new Set(b.types ?? []));
    const formats = a.formats && b.formats ? jaccard(new Set(a.formats), new Set(b.formats)) : sameTypes;
    return 0.4 * sameTypes + 0.2 * formats + 0.4 * names;
  }
  // Folders and objects: names count for more, since a translated export often differs inside too.
  return 0.5 * jaccard(signature(a), signature(b)) + 0.5 * names;
}

const positional = (name: string) => name === ITEM_NAME || name === COLLAPSED_NAME;

/**
 * After merging `from` into `into`, the children of both sit side by side under `into`. Suggest
 * merges between them, with full paths. Call it before `mergeNodes`.
 */
export function suggestAfterMerge(root: ProjectNode, from: NodePath, into: NodePath): MergeSuggestion[] {
  const source = getNode(root, from);
  const target = getNode(root, into);
  if (!source || !target) return [];
  return suggestMerges(target, source).map((s) => ({ ...s, from: [...into, ...s.from], into: [...into, ...s.into] }));
}

/**
 * Suggest merges for a shape about to be added to a project tree. Call it before
 * `mergeShape`: it needs to know which known nodes the shape lacks.
 */
export function suggestMerges(root: ProjectNode, shape: Shape): MergeSuggestion[] {
  const out: MergeSuggestion[] = [];
  const visit = (node: ProjectNode, s: Shape, path: NodePath) => {
    if (node.collapsed) return;
    const seen = new Set<ProjectNode>();
    const unknown: Shape[] = [];
    for (const child of s.children ?? []) {
      const match = matchChild(node, child.kind, child.name);
      if (match) {
        seen.add(match);
        visit(match, child, [...path, match.name]);
      } else if (!positional(child.name)) unknown.push(child);
    }
    const missing = (node.children ?? []).filter((c) => !seen.has(c) && !positional(c.name));
    const pairs: MergeSuggestion[] = [];
    for (const u of unknown) {
      for (const m of missing) {
        if (u.kind !== m.kind) continue;
        const score = similarity(u, m);
        if (score >= MIN_SCORE) pairs.push({ from: [...path, u.name], into: [...path, m.name], score });
      }
    }
    // Best pairs first, each node in at most one.
    const used = new Set<string>();
    for (const pair of pairs.sort((a, b) => b.score - a.score)) {
      const from = `f:${pair.from.at(-1)}`;
      const into = `i:${pair.into.at(-1)}`;
      if (used.has(from) || used.has(into)) continue;
      used.add(from);
      used.add(into);
      out.push({ ...pair, score: Math.round(pair.score * 100) / 100 });
    }
  };
  visit(root, shape, []);
  return out;
}
