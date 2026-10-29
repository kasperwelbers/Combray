import {
  getNode,
  isDecidable,
  isLeaf,
  type Alias,
  type EffectiveState,
  type LeafDecision,
  type Localized,
  type NodePath,
  type ProjectNode,
} from '@combray/core';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { LANGUAGES } from '../i18n';
import { displayName, formsTable, type NodePatch } from './model';

const LEAF_DECISIONS: LeafDecision[] = ['undecided', 'ignore', 'show', 'donate'];

interface Props {
  tree: ProjectNode;
  path: NodePath;
  states: Map<ProjectNode, EffectiveState>;
  onDecide: (path: NodePath, decision: LeafDecision) => void;
  onDecideBelow: (path: NodePath, decision: 'show' | 'donate' | 'undecided', undecidedOnly: boolean) => void;
  onPatch: (path: NodePath, patch: NodePatch) => void;
  onMerge: (from: NodePath, into: NodePath) => void;
  onKeysAreData: (path: NodePath) => void;
}

function textOf(value: Localized | undefined, language: string): string {
  if (value === undefined) return '';
  return typeof value === 'string' ? (language === 'en' ? value : '') : (value[language] ?? '');
}

/** Set one language of a localized text; empty texts are removed. */
function withLanguage(value: Localized | undefined, language: string, text: string): Localized | undefined {
  const base: Record<string, string> =
    value === undefined ? {} : typeof value === 'string' ? { en: value } : { ...value };
  if (text.trim() === '') delete base[language];
  else base[language] = text;
  return Object.keys(base).length > 0 ? base : undefined;
}

function aliasText(alias: Alias): string {
  return typeof alias === 'string' ? alias : `/${alias.regex}/${alias.flags ?? ''}`;
}

/** Settings of the selected node: label, description, aliases, merging, keys as data. */
export function NodePanel({ tree, path, states, onDecide, onDecideBelow, onPatch, onMerge, onKeysAreData }: Props) {
  const { t } = useTranslation();
  const [undecidedOnly, setUndecidedOnly] = useState(true);
  const node = getNode(tree, path);
  const parent = getNode(tree, path.slice(0, -1));
  const [alias, setAlias] = useState('');
  const [regex, setRegex] = useState(false);
  const [aliasError, setAliasError] = useState(false);
  const [mergeTarget, setMergeTarget] = useState('');
  if (!node) return null;

  const leaf = isLeaf(node);
  const state = states.get(node) ?? 'show';
  const siblings = (parent?.children ?? []).filter((c) => c !== node && c.kind === node.kind);

  function addAlias(event: FormEvent) {
    event.preventDefault();
    const text = alias.trim();
    if (text === '') return;
    let next: Alias = text;
    if (regex) {
      try {
        new RegExp(text);
      } catch {
        setAliasError(true);
        return;
      }
      next = { regex: text };
    }
    setAliasError(false);
    onPatch(path, { aliases: [...(node!.aliases ?? []), next] });
    setAlias('');
  }

  return (
    <section className="card node-panel" aria-labelledby="node-panel-title">
      <h2 id="node-panel-title">{displayName(node.name, t)}</h2>
      <p className="path">{path.length > 0 ? path.map((n) => displayName(n, t)).join(' / ') : t('studio.root')}</p>
      <p className="meta">
        {t(`kind.${node.kind}`)}
        {node.types && ` · ${node.types.map((type) => t(`type.${type}`)).join(', ')}`}
        {node.count && ` · × ${node.count}`} · {t(`studio.state.${state}`)}
      </p>
      {node.formats && (
        <p className="meta">
          {t('studio.formats')} <Formats formats={node.formats} />
        </p>
      )}
      {node.keyTypes && (
        <p className="meta">
          {t('studio.keyTypes', { types: node.keyTypes.map((type) => t(`type.${type}`)).join(', ') })}
          {node.keyFormats && (
            <>
              {' '}
              <Formats formats={node.keyFormats} />
            </>
          )}
        </p>
      )}

      {isDecidable(node) ? (
        <div className="panel-group">
          <span className="segmented" role="group" aria-label={t('studio.decisionFor', { name: displayName(node.name, t) })}>
            {LEAF_DECISIONS.map((d, i) => (
              <button
                key={d}
                type="button"
                className={`seg seg-${d}`}
                aria-pressed={(node.decision ?? 'undecided') === d}
                aria-keyshortcuts={String(i + 1)}
                onClick={() => onDecide(path, d)}
              >
                {t(`studio.decision.${d}`)}
              </button>
            ))}
          </span>
          {state === 'ignore' && node.decision !== 'ignore' && <p className="meta">{t('studio.ignoredAbove')}</p>}
        </div>
      ) : (
        <div className="panel-group">
          <button
            type="button"
            className="button quiet"
            aria-pressed={node.decision === 'ignore'}
            aria-keyshortcuts="2"
            onClick={() => onDecide(path, node.decision === 'ignore' ? 'undecided' : 'ignore')}
          >
            {node.decision === 'ignore' ? t('studio.unignore') : t('studio.ignoreAll')}
          </button>
          {node.decision !== 'ignore' && (
            <fieldset className="panel-group">
              <legend>{t('studio.fieldsBelow')}</legend>
              <div className="actions">
                <button type="button" className="button quiet" onClick={() => onDecideBelow(path, 'show', undecidedOnly)}>
                  {t('studio.showAll')}
                </button>
                <button type="button" className="button quiet" onClick={() => onDecideBelow(path, 'donate', undecidedOnly)}>
                  {t('studio.donateAll')}
                </button>
                <button type="button" className="button quiet" onClick={() => onDecideBelow(path, 'undecided', false)}>
                  {t('studio.clearAll')}
                </button>
              </div>
              <label className="check">
                <input type="checkbox" checked={undecidedOnly} onChange={(e) => setUndecidedOnly(e.target.checked)} />
                {t('studio.undecidedOnly')}
              </label>
            </fieldset>
          )}
        </div>
      )}
      <p className="meta">
        {leaf ? t('studio.leafHelp') : formsTable(node) ? t('studio.tableHelp') : t('studio.innerHelp')}{' '}
        {t('studio.shortcuts')}
      </p>

      <fieldset className="panel-group">
        <legend>{t('studio.label')}</legend>
        {LANGUAGES.map((language) => (
          <label key={language} className="field">
            <span>{t(`studio.language.${language}`)}</span>
            <input
              value={textOf(node.label, language)}
              onChange={(e) => onPatch(path, { label: withLanguage(node.label, language, e.target.value) })}
            />
          </label>
        ))}
      </fieldset>

      {(leaf || node.name === '{*}') && (
        <fieldset className="panel-group">
          <legend>{t('studio.description')}</legend>
          <p className="meta">{t('studio.descriptionHelp')}</p>
          {LANGUAGES.map((language) => (
            <label key={language} className="field">
              <span>{t(`studio.language.${language}`)}</span>
              <textarea
                rows={2}
                value={textOf(node.description, language)}
                onChange={(e) =>
                  onPatch(path, { description: withLanguage(node.description, language, e.target.value) })
                }
              />
            </label>
          ))}
        </fieldset>
      )}

      {isDecidable(node) && node.decision === 'donate' && (
        <label className="check">
          <input
            type="checkbox"
            checked={node.raw === true}
            onChange={(e) => onPatch(path, { raw: e.target.checked ? true : undefined })}
          />
          {t('studio.raw')}
        </label>
      )}

      {(node.kind === 'map' || node.kind === 'dir') && (
        <fieldset className="panel-group">
          <legend>{t('studio.keysTitle')}</legend>
          {node.collapsed ? (
            <p className="meta">{t('studio.keysAreData')}</p>
          ) : (
            <>
              <p className="meta">{t('studio.keysHelp')}</p>
              <button className="button quiet" type="button" onClick={() => onKeysAreData(path)}>
                {t('studio.makeKeysData')}
              </button>
            </>
          )}
        </fieldset>
      )}

      {node.name === '{*}' && <p className="meta">{t('studio.keysDecisionHelp')}</p>}

      <fieldset className="panel-group">
        <legend>{t('studio.aliasesTitle')}</legend>
        <p className="meta">{t('studio.aliasesHelp')}</p>
        {node.aliases && node.aliases.length > 0 && (
          <ul className="alias-list">
            {node.aliases.map((a, i) => (
              <li key={`${aliasText(a)}:${i}`}>
                <code>{aliasText(a)}</code>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => onPatch(path, { aliases: node.aliases!.filter((_, j) => j !== i) })}
                >
                  {t('studio.remove')}
                  <span className="visually-hidden"> {aliasText(a)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <form className="alias-form" onSubmit={addAlias}>
          <label className="visually-hidden" htmlFor="alias-input">
            {t('studio.newAlias')}
          </label>
          <input
            id="alias-input"
            value={alias}
            placeholder={t('studio.newAlias')}
            onChange={(e) => setAlias(e.target.value)}
          />
          <label className="check">
            <input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} />
            {t('studio.regex')}
          </label>
          <button className="button quiet" type="submit">
            {t('studio.add')}
          </button>
        </form>
        {aliasError && (
          <p className="message error" role="alert">
            {t('studio.badRegex')}
          </p>
        )}
      </fieldset>

      {path.length > 0 && siblings.length > 0 && (
        <fieldset className="panel-group">
          <legend>{t('studio.mergeTitle')}</legend>
          <p className="meta">{t('studio.mergeHelp')}</p>
          <div className="alias-form">
            <label className="visually-hidden" htmlFor="merge-target">
              {t('studio.mergeInto')}
            </label>
            <select id="merge-target" value={mergeTarget} onChange={(e) => setMergeTarget(e.target.value)}>
              <option value="">{t('studio.chooseNode')}</option>
              {siblings.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
            <button
              className="button quiet"
              type="button"
              disabled={mergeTarget === ''}
              onClick={() => {
                onMerge(path, [...path.slice(0, -1), mergeTarget]);
                setMergeTarget('');
              }}
            >
              {t('studio.mergeInto')}
            </button>
          </div>
        </fieldset>
      )}
    </section>
  );
}

function Formats({ formats }: { formats: string[] }) {
  return (
    <>
      {formats.map((f, i) => (
        <span key={f}>
          {i > 0 && ', '}
          <code>{f}</code>
        </span>
      ))}
    </>
  );
}
