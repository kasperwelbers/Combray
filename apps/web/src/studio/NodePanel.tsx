import {
  getNode,
  isLeaf,
  type Alias,
  type EffectiveState,
  type Localized,
  type NodePath,
  type ProjectNode,
} from '@combray/core';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { LANGUAGES } from '../i18n';
import { isRepeatedName, type NodePatch } from './model';

interface Props {
  tree: ProjectNode;
  path: NodePath;
  states: Map<ProjectNode, EffectiveState>;
  onPatch: (path: NodePath, patch: NodePatch) => void;
  onMerge: (from: NodePath, into: NodePath) => void;
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

/** Settings of the selected node: label, description, aliases, merging, unnesting. */
export function NodePanel({ tree, path, states, onPatch, onMerge }: Props) {
  const { t } = useTranslation();
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
      <h2 id="node-panel-title">{node.name || t('studio.root')}</h2>
      <p className="path">{path.length > 0 ? path.join(' / ') : t('studio.root')}</p>
      <p className="meta">
        {t(`kind.${node.kind}`)}
        {node.types && ` · ${node.types.map((type) => t(`type.${type}`)).join(', ')}`}
        {node.count && ` · × ${node.count}`} · {t(`studio.state.${state}`)}
      </p>
      <p className="meta">{leaf ? t('studio.leafHelp') : t('studio.innerHelp')}</p>

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

      {leaf && (
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

      {leaf && node.decision === 'donate' && (
        <label className="check">
          <input
            type="checkbox"
            checked={node.raw === true}
            onChange={(e) => onPatch(path, { raw: e.target.checked ? true : undefined })}
          />
          {t('studio.raw')}
        </label>
      )}

      {!leaf && isRepeatedName(node.name) && (
        <label className="field">
          <span>{t('studio.unnest')}</span>
          <select
            value={node.unnest ?? 'count'}
            onChange={(e) => onPatch(path, { unnest: e.target.value as NonNullable<ProjectNode['unnest']> })}
          >
            {(['count', 'longer', 'wider'] as const).map((u) => (
              <option key={u} value={u}>
                {t(`studio.unnestOption.${u}`)}
              </option>
            ))}
          </select>
        </label>
      )}

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
