import type { Shape } from '@combray/core';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { DatasetSummary, NodeDetail, NodeSummary, SearchHit } from '../worker/api';
import { data } from '../worker/client';

const PAGE = 100;
const SEARCH_LIMIT = 200;

const ICONS: Record<NodeSummary['kind'], string> = {
  dir: '📁',
  map: '◇',
  list: '☰',
  value: '·',
  element: '‹›',
  text: '¶',
  blob: '🖼',
};

/** A readable path for a node, in the path language (list items as `[n]`). */
function pathOf(detail: NodeDetail): string {
  const chain = [...detail.ancestors, detail.node];
  return chain
    .slice(1)
    .map((node, i) => {
      if (chain[i]!.kind === 'list') return `[${node.name}]`;
      return /[/{}[\]()"]/.test(node.name) ? `"${node.name}"` : node.name;
    })
    .join('/');
}

function NodeRow({ node, onOpen }: { node: NodeSummary; onOpen: (index: number) => void }) {
  const { t } = useTranslation();
  const icon = <span aria-hidden="true">{ICONS[node.kind]}</span>;
  const kind = <span className="visually-hidden">{t(`kind.${node.kind}`)}: </span>;
  if (node.childCount > 0) {
    return (
      <button type="button" className="node" onClick={() => onOpen(node.index)}>
        {icon}
        <span className="name">
          {kind}
          {node.name}
        </span>
        <span className="preview">{t('explore.inside', { count: node.childCount })}</span>
      </button>
    );
  }
  const preview =
    node.kind === 'blob'
      ? `${node.mime} · ${Math.ceil((node.size ?? 0) / 1024)} KB`
      : (node.preview ?? (node.kind === 'value' || node.kind === 'text' ? '' : t('explore.empty')));
  return (
    <div className="node">
      {icon}
      <span className="name">
        {kind}
        {node.name}
      </span>
      <span className={`preview${node.type === 'url-like' ? ' url' : ''}`}>{preview}</span>
    </div>
  );
}

function TreeBrowser({ dataset }: { dataset: DatasetSummary }) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState(0);
  const [detail, setDetail] = useState<NodeDetail>();
  const [children, setChildren] = useState<NodeSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<{ total: number; items: SearchHit[] }>();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [d, page] = await Promise.all([
        data.getNode(dataset.id, current),
        data.getChildren(dataset.id, current, 0, PAGE),
      ]);
      if (cancelled) return;
      setDetail(d);
      setChildren(page.items);
      setTotal(page.total);
    })();
    return () => {
      cancelled = true;
    };
  }, [dataset.id, current]);

  const open = useCallback((index: number) => {
    setHits(undefined);
    setCurrent(index);
  }, []);

  async function more() {
    const page = await data.getChildren(dataset.id, current, children.length, PAGE);
    setChildren((c) => [...c, ...page.items]);
  }

  async function runSearch(event: FormEvent) {
    event.preventDefault();
    if (query.trim() === '') return setHits(undefined);
    setHits(await data.search(dataset.id, query, SEARCH_LIMIT));
  }

  async function openHit(hit: SearchHit) {
    if (hit.node.childCount > 0) return open(hit.node.index);
    const d = await data.getNode(dataset.id, hit.node.index);
    open(d.ancestors.at(-1)?.index ?? 0);
  }

  return (
    <>
      <form className="search" role="search" onSubmit={runSearch}>
        <label className="visually-hidden" htmlFor="search">
          {t('explore.search')}
        </label>
        <input
          id="search"
          type="search"
          placeholder={t('explore.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="button quiet" type="submit">
          🔍<span className="visually-hidden">{t('explore.search')}</span>
        </button>
      </form>

      {hits ? (
        <section aria-live="polite">
          <p className="meta">
            {t('explore.results', { count: hits.total })}
            {hits.total > hits.items.length && ` (${t('explore.showingFirst', { shown: hits.items.length })})`}
          </p>
          <ul className="nodes">
            {hits.items.map((hit) => (
              <li key={hit.node.index}>
                <button type="button" className="node" onClick={() => openHit(hit)}>
                  <span aria-hidden="true">{ICONS[hit.node.kind]}</span>
                  <span className="name">{hit.node.name}</span>
                  <span className="preview">
                    {hit.node.preview}
                    <span className="path" style={{ display: 'block' }}>
                      {hit.location.join(' › ')}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        detail && (
          <section>
            <nav aria-label={t('explore.breadcrumbs')}>
              <ol className="crumbs">
                {detail.ancestors.map((a) => (
                  <li key={a.index}>
                    <button type="button" className="link-button" onClick={() => open(a.index)}>
                      {a.name}
                    </button>
                  </li>
                ))}
                <li aria-current="location">
                  <strong>{detail.node.name}</strong>
                </li>
              </ol>
            </nav>
            {detail.location.length > 0 && (
              <p className="path">
                {t('explore.path')}: {pathOf(detail)}
              </p>
            )}
            {children.length === 0 ? (
              <p className="meta">{t('explore.empty')}</p>
            ) : (
              <ul className="nodes">
                {children.map((child) => (
                  <li key={child.index}>
                    <NodeRow node={child} onOpen={open} />
                  </li>
                ))}
              </ul>
            )}
            {children.length < total && (
              <p style={{ marginTop: '1rem' }}>
                <button className="button quiet" type="button" onClick={more}>
                  {t('explore.more')} ({children.length} / {total})
                </button>
              </p>
            )}
          </section>
        )
      )}
    </>
  );
}

function ShapeNode({ shape }: { shape: Shape }) {
  const { t } = useTranslation();
  return (
    <li>
      <span aria-hidden="true">{ICONS[shape.kind]} </span>
      <strong>{shape.name}</strong>
      <span className="tag">{t(`kind.${shape.kind}`)}</span>
      {shape.types?.map((type) => (
        <span key={type} className="tag">
          {type}
        </span>
      ))}
      {shape.count && <span className="tag">× {shape.count}</span>}
      {shape.collapsed && <span className="tag">{t('explore.collapsed')}</span>}
      {shape.mime && <span className="tag">{shape.mime}</span>}
      {shape.children && (
        <ul>
          {shape.children.map((c) => (
            <ShapeNode key={`${c.kind}:${c.name}`} shape={c} />
          ))}
        </ul>
      )}
    </li>
  );
}

function ShapeView({ dataset }: { dataset: DatasetSummary }) {
  const { t } = useTranslation();
  const [shape, setShape] = useState<Shape>();
  useEffect(() => {
    void data.getShape(dataset.id).then(setShape);
  }, [dataset.id]);
  return (
    <section className="shape">
      <p>{t('explore.shapeIntro')}</p>
      {shape && (
        <ul>
          <ShapeNode shape={shape} />
        </ul>
      )}
    </section>
  );
}

export function Explore({ dataset, onBack }: { dataset: DatasetSummary; onBack: () => void }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'browse' | 'structure'>('browse');
  return (
    <>
      <p>
        <button type="button" className="link-button" onClick={onBack}>
          ← {t('explore.back')}
        </button>
      </p>
      <h1>{dataset.name}</h1>
      <div className="tabs" role="tablist">
        {(['browse', 'structure'] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`panel-${id}`}
            onClick={() => setTab(id)}
          >
            {t(`explore.${id}`)}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'browse' ? <TreeBrowser dataset={dataset} /> : <ShapeView dataset={dataset} />}
      </div>
    </>
  );
}
