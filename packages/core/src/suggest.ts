/**
 * Suggestions to combine: when a new export has a position where the configuration has a
 * different node at the same place, they may be the same thing renamed or translated (`date` and
 * `timestamp`, `Mijn activiteit` and `My Activity`). See docs/decisions/0012-names-and-matches.md.
 *
 * Suggestions are pairs of siblings: one the shape has and no config node matches, and one the
 * configuration has and the shape lacks, of the same kind. They are ranked by how alike their
 * structure and names are, and each node is suggested at most once. The researcher decides.
 */
import { buildTree, toConfig, type NodePath, type ProjectNode } from './decisions';
import { COLLAPSED_NAME, ITEM_NAME, type Shape } from './shape';

export interface CombineSuggestion {
  /** The unmatched (virtual) node of the new export. */
  from: NodePath;
  /** The config node it may be the same as. */
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
 * Suggest combining for a shape (a newly loaded export): pairs of siblings where the shape has a
 * position no config node matches (`from`, a virtual node) and the project has a node this shape
 * lacks (`into`: configured, or seen before), of the same kind. `tree` is the project tree the
 * researcher sees (the configuration over the seen structures, with or without this shape);
 * paths are in that tree once the shape is added to it.
 */
export function suggestCombines(tree: ProjectNode, shape: Shape): CombineSuggestion[] {
  const built = buildTree({ root: toConfig(tree) }, shape);
  const out: CombineSuggestion[] = [];
  const key = (n: ProjectNode) => (n.virtual ? `~${n.kind}\u0000${n.name}` : n.id);
  const inShape = (n: ProjectNode) => n.virtual || (built.sources.get(n)?.length ?? 0) > 0;
  const visit = (own: ProjectNode, node: ProjectNode, path: NodePath) => {
    if (node.collapsed) return;
    const present = new Map((node.children ?? []).filter(inShape).map((c) => [key(c), c]));
    const unknown = (node.children ?? []).filter((c) => c.virtual && !positional(c.name));
    const missing = (own.children ?? []).filter((c) => !positional(c.name) && !present.has(key(c)));
    const pairs: CombineSuggestion[] = [];
    for (const u of unknown) {
      const shapeOfU = built.sources.get(u)?.[0];
      for (const m of missing) {
        if (u.kind !== m.kind || !shapeOfU) continue;
        const score = similarity(shapeOfU, asShape(m));
        if (score >= MIN_SCORE) pairs.push({ from: [...path, u.id], into: [...path, m.id], score });
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
    for (const child of own.children ?? []) {
      const twin = present.get(key(child));
      if (twin) visit(child, twin, [...path, child.id]);
    }
  };
  visit(tree, built.tree, []);
  return out;
}

/** A project node as the shape the researcher saw: its key, structure and children. */
function asShape(node: ProjectNode): Node {
  return {
    kind: node.kind,
    name: node.keys?.[0] ?? node.name,
    ...(node.types ? { types: node.types } : {}),
    ...(node.formats ? { formats: node.formats } : {}),
    ...(node.children ? { children: node.children.map(asShape) as Shape[] } : {}),
  };
}
