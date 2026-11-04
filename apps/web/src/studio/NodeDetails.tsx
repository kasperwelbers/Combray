import {
  closedNodes,
  findPatternProblem,
  getNode,
  isDecidable,
  isLeaf,
  type Alias,
  type Localized,
  type NodePath,
  type ProjectNode,
} from '@combray/core';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { LANGUAGES } from '../i18n';
import type { FieldValues as Values } from './api';
import { Conversion } from './Conversion';
import { FieldValues } from './FieldValues';
import { displayName, filterColumns, formsTable, type NodePatch } from './model';
import { Help, SectionHead } from './Popover';
import { RowFilters } from './RowFilters';

export type DetailSection = 'values' | 'name' | 'read' | 'rows' | 'match' | 'platform';

interface Props {
  tree: ProjectNode;
  path: NodePath;
  /** The section last looked at, kept from row to row when the next row has it too. */
  section: DetailSection;
  onSection: (section: DetailSection) => void;
  values: Values | undefined;
  hasPackages: boolean;
  onPatch: (path: NodePath, patch: NodePatch) => void;
  onMerge: (from: NodePath, into: NodePath) => void;
  onKeysAreData: (path: NodePath) => void;
  onClose: () => void;
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

/** The sections a node has, in order. */
function sectionsOf(node: ProjectNode, path: NodePath): DetailSection[] {
  if (path.length === 0) return ['platform'];
  const out: DetailSection[] = [];
  if (isDecidable(node)) out.push('values');
  out.push('name');
  if (isDecidable(node) && node.kind !== 'blob') out.push('read');
  if ((node.name === '[*]' || node.name === '{*}') && !isLeaf(node)) out.push('rows');
  out.push('match');
  return out;
}

/** The settings of one row, in a few short sections; explanations behind a "?". */
export function NodeDetails(props: Props) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const { tree, path, onPatch, onClose } = props;
  const node = getNode(tree, path);
  if (!node) return null;
  const sections = sectionsOf(node, path);
  const section = sections.includes(props.section) ? props.section : sections[0]!;
  const name = path.length === 0 ? t('studio.platformSettings') : displayName(node.name, t);
  const patch = (p: NodePatch) => onPatch(path, p);

  return (
    <div className="node-details">
      <div className="node-details-head">
        <div>
          <strong>{name}</strong>
          {path.length > 0 && <PathToggle text={path.map((n) => displayName(n, t)).join(' / ')} />}
          {path.length > 0 && (
            <div className="meta">
              {t(`kind.${node.kind}`)}
              {node.types && ` · ${node.types.map((type) => t(`type.${type}`)).join(', ')}`}
              {node.repeat && ` · ${t(`studio.repeat.${node.repeat}`)}`}
            </div>
          )}
        </div>
        <button type="button" className="close-button" onClick={onClose}>
          <span aria-hidden="true">×</span>
          <span className="visually-hidden">{t('studio.details.close')}</span>
        </button>
      </div>

      {sections.length > 1 && (
        <div className="segmented details-tabs" role="group" aria-label={t('studio.details.label')}>
          {sections.map((s) => (
            <button key={s} type="button" className="seg" aria-pressed={s === section} onClick={() => props.onSection(s)}>
              {t(`studio.details.${s}`)}
            </button>
          ))}
        </div>
      )}

      <div className="details-body">
        {section === 'values' && <FieldValues values={props.values} hasPackages={props.hasPackages} />}
        {section === 'name' && <NameSection node={node} onPatch={patch} />}
        {section === 'read' && (
          <>
            <Conversion node={node} onPatch={patch} />
            {node.decision === 'donate' && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={node.raw === true}
                  onChange={(e) => patch({ raw: e.target.checked ? true : undefined })}
                />
                {t('studio.raw')}
              </label>
            )}
          </>
        )}
        {section === 'rows' && (
          <>
            {node.name === '[*]' && !path.slice(0, -1).some((n) => n === '[*]' || n === '{*}') && (
              <CheckWithHelp
                checked={node.headerRow === true}
                onChange={(checked) => patch({ headerRow: checked ? true : undefined })}
                label={t('studio.headerRow')}
                help={t('studio.headerRowHelp')}
              />
            )}
            <RowFilters node={node} columns={filterColumns(tree, path)} onPatch={patch} />
          </>
        )}
        {section === 'match' && <MatchSection {...props} node={node} />}
        {section === 'platform' && <PlatformSection {...props} node={node} />}
      </div>
    </div>
  );
}

function NameSection({ node, onPatch }: { node: ProjectNode; onPatch: (patch: NodePatch) => void }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const describable = isLeaf(node) || node.name === '{*}';
  return (
    <>
      <SectionHead title={t('studio.label')} help={`${t('studio.labelHelp')}${formsTable(node) ? ` ${t('studio.tableHelp')}` : ''}`} />
      {LANGUAGES.map((language) => (
        <label key={language} className="field compact">
          <span>{t(`studio.language.${language}`)}</span>
          <input
            value={textOf(node.label, language)}
            onChange={(e) => onPatch({ label: withLanguage(node.label, language, e.target.value) })}
          />
        </label>
      ))}
      {describable && (
        <>
          <SectionHead title={t('studio.description')} help={t('studio.descriptionHelp')} />
          {LANGUAGES.map((language) => (
            <label key={language} className="field compact">
              <span>{t(`studio.language.${language}`)}</span>
              <textarea
                rows={2}
                value={textOf(node.description, language)}
                onChange={(e) => onPatch({ description: withLanguage(node.description, language, e.target.value) })}
              />
            </label>
          ))}
        </>
      )}
    </>
  );
}

function NewChildrenSetting({ tree, path, node, onPatch }: { tree: ProjectNode; path: NodePath; node: ProjectNode; onPatch: (patch: NodePatch) => void }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const parent = getNode(tree, path.slice(0, -1));
  const inherited = path.length > 0 && parent && closedNodes(tree).has(parent) ? 'skip' : 'ask';
  return (
    <>
      <SectionHead title={t('studio.newChildren')} help={t('studio.newChildrenHelp')} />
      <select
        value={node.newChildren ?? ''}
        onChange={(e) => onPatch({ newChildren: e.target.value === '' ? undefined : (e.target.value as 'ask' | 'skip') })}
      >
        <option value="">{t('studio.newChildrenInherit', { state: t(`studio.newChildrenState.${inherited}`) })}</option>
        <option value="ask">{t('studio.newChildrenAsk')}</option>
        <option value="skip">{t('studio.newChildrenSkip')}</option>
      </select>
    </>
  );
}

function MatchSection({ tree, path, node, onPatch, onMerge, onKeysAreData }: Props & { node: ProjectNode }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const [alias, setAlias] = useState('');
  const [regex, setRegex] = useState(false);
  const [aliasError, setAliasError] = useState(false);
  const [mergeTarget, setMergeTarget] = useState('');
  const parent = getNode(tree, path.slice(0, -1));
  const siblings = (parent?.children ?? []).filter((c) => c !== node && c.kind === node.kind);
  const patch = (p: NodePatch) => onPatch(path, p);

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
    patch({ aliases: [...(node.aliases ?? []), next] });
    setAlias('');
  }

  return (
    <>
      <CheckWithHelp
        checked={node.required === true}
        onChange={(checked) => patch({ required: checked ? true : undefined })}
        label={t('studio.required')}
        help={t('studio.requiredHelp')}
      />

      {!isLeaf(node) && <NewChildrenSetting tree={tree} path={path} node={node} onPatch={patch} />}

      <SectionHead title={t('studio.aliasesTitle')} help={t('studio.aliasesHelp')} />
      {node.aliases && node.aliases.length > 0 && (
        <ul className="alias-list">
          {node.aliases.map((a, i) => (
            <li key={`${aliasText(a)}:${i}`}>
              <code>{aliasText(a)}</code>
              <button
                type="button"
                className="link-button"
                onClick={() => patch({ aliases: node.aliases!.filter((_, j) => j !== i) })}
              >
                {t('studio.remove')}
                <span className="visually-hidden"> {aliasText(a)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="alias-form" onSubmit={addAlias}>
        <input aria-label={t('studio.newAlias')} value={alias} placeholder={t('studio.newAlias')} onChange={(e) => setAlias(e.target.value)} />
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

      {siblings.length > 0 && (
        <>
          <SectionHead title={t('studio.mergeTitle')} help={t('studio.mergeHelp')} />
          <div className="alias-form">
            <select aria-label={t('studio.mergeInto')} value={mergeTarget} onChange={(e) => setMergeTarget(e.target.value)}>
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
        </>
      )}

      {(node.kind === 'map' || node.kind === 'dir') && (
        <>
          <SectionHead title={t('studio.keysTitle')} help={t('studio.keysHelp')} />
          {node.collapsed ? (
            <p className="meta">{t('studio.keysAreData')}</p>
          ) : (
            <button className="button quiet" type="button" onClick={() => onKeysAreData(path)}>
              {t('studio.makeKeysData')}
            </button>
          )}
        </>
      )}
      {node.name === '{*}' && <p className="meta">{t('studio.keysDecisionHelp')}</p>}
    </>
  );
}

/** Settings of the whole platform tree: what participants see of undecided parts, and finding the export. */
function PlatformSection({ tree, path, node, onPatch }: Props & { node: ProjectNode }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const [pattern, setPattern] = useState('');
  const [problem, setProblem] = useState<string>();
  const patch = (p: NodePatch) => onPatch(path, p);

  function addPattern(event: FormEvent) {
    event.preventDefault();
    const text = pattern.trim();
    const found = findPatternProblem(text);
    setProblem(found);
    if (found) return;
    patch({ find: [...(node.find ?? []), text] });
    setPattern('');
  }

  return (
    <>
      <CheckWithHelp
        checked={node.undecided === 'show'}
        onChange={(checked) => patch({ undecided: checked ? 'show' : undefined })}
        label={t('studio.undecidedShown')}
        help={t('studio.undecidedShownHelp')}
      />

      <SectionHead title={t('studio.findTitle')} help={t('studio.findHelp')} />
      {node.find && node.find.length > 0 && (
        <ul className="alias-list">
          {node.find.map((p, i) => (
            <li key={`${p}:${i}`}>
              <code>{p}</code>
              <button type="button" className="link-button" onClick={() => patch({ find: node.find!.filter((_, j) => j !== i) })}>
                {t('studio.remove')}
                <span className="visually-hidden"> {p}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="alias-form" onSubmit={addPattern}>
        <input aria-label={t('studio.newPattern')} value={pattern} placeholder={t('studio.newPattern')} onChange={(e) => setPattern(e.target.value)} />
        <button className="button quiet" type="submit">
          {t('studio.add')}
        </button>
      </form>
      {problem && (
        <p className="message error" role="alert">
          {t('studio.badPattern', { problem })}
        </p>
      )}

      <NewChildrenSetting tree={tree} path={path} node={node} onPatch={patch} />
    </>
  );
}

/** A checkbox with its explanation behind a "?" (outside the label, so "?" does not toggle it). */
function CheckWithHelp({ checked, onChange, label, help }: { checked: boolean; onChange: (checked: boolean) => void; label: string; help: string }) {
  return (
    <div className="section-head check-row">
      <label className="check">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        {label}
      </label>
      <Help topic={label}>{help}</Help>
    </div>
  );
}

/** Where the node is in the file: long for HTML, so shown only on request. */
function PathToggle({ text }: { text: string }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const [open, setOpen] = useState(false);
  return (
    <div className="path-toggle">
      <button type="button" className="link-button meta" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? t('studio.details.hidePath') : t('studio.details.showPath')}
      </button>
      {open && <div className="meta path">{text}</div>}
    </div>
  );
}
