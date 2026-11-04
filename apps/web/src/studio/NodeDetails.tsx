import {
  closedNodes,
  findPatternProblem,
  getNode,
  isDecidable,
  isItemNode,
  isKeysNode,
  isLeaf,
  matchOne,
  matchText,
  nodesNamed,
  regexProblem,
  type Match,
  type Name,
  type NodePath,
  type ProjectNode,
} from '@combray/core';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { LANGUAGES } from '../i18n';
import type { FieldValues as Values } from './api';
import { Conversion } from './Conversion';
import { FieldValues } from './FieldValues';
import { displayName, filterColumns, formsTable, nameText, type NodePatch, type RowInfo } from './model';
import { Help, SectionHead } from './Popover';
import { RowFilters } from './RowFilters';

export type DetailSection = 'values' | 'name' | 'read' | 'rows' | 'match' | 'platform';

export interface NameActions {
  set: (path: NodePath, nameId: string | undefined) => void;
  create: (path: NodePath, text: string) => void;
  edit: (nameId: string, change: (name: Name) => Name) => void;
}

export interface MatchActions {
  add: (path: NodePath, match: Match) => void;
  remove: (path: NodePath, match: Match) => void;
  split: (path: NodePath) => void;
  combine: (paths: NodePath[]) => void;
}

interface Props {
  tree: ProjectNode;
  path: NodePath;
  names: Name[];
  info: Map<ProjectNode, RowInfo>;
  /** The section last looked at, kept from row to row when the next row has it too. */
  section: DetailSection;
  onSection: (section: DetailSection) => void;
  values: Values | undefined;
  hasPackages: boolean;
  onPatch: (path: NodePath, patch: NodePatch) => void;
  onName: NameActions;
  onMatch: MatchActions;
  onKeysAreData: (path: NodePath) => void;
  onClose: () => void;
}

/** Set one language of a per-language text; empty texts are removed, and so is an empty map. */
function withLanguage(value: Record<string, string> | undefined, language: string, text: string): Record<string, string> | undefined {
  const base = { ...value };
  if (text.trim() === '') delete base[language];
  else base[language] = text;
  return Object.keys(base).length > 0 ? base : undefined;
}

/** A name with one field set, or removed when it is empty. */
function withField(name: Name, key: 'label' | 'description', value: Record<string, string> | undefined): Name {
  const out = { ...name };
  if (value === undefined) delete out[key];
  else out[key] = value;
  return out;
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
          {path.length > 0 && (
            <PathToggle text={path.map((_, i) => displayName(getNode(tree, path.slice(0, i + 1))?.name ?? '', t)).join(' / ')} />
          )}
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
        {section === 'name' && <NameSection {...props} node={node} />}
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
            {node.name === '[*]' &&
              !path.slice(0, -1).some((_, i) => ['[*]', '{*}'].includes(getNode(tree, path.slice(0, i + 1))?.name ?? '')) && (
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

/**
 * The row's name: what participants see, shared by every row with the same name (ADR 0012).
 * Rows with one name are one table or column for participants; each keeps its own settings.
 */
function NameSection({ tree, path, node, names, onName }: Props & { node: ProjectNode }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const [text, setText] = useState(node.name === '[*]' || node.name === '{*}' ? '' : node.name);
  const name = node.nameId === undefined ? undefined : names.find((n) => n.id === node.nameId);
  const describable = isLeaf(node) || node.name === '{*}';
  const others = name ? nodesNamed(tree, name.id).length - 1 : 0;
  const choose = (
    <label className="field compact">
      <span>{name ? t('studio.name.useOther') : t('studio.name.useExisting')}</span>
      <select value="" onChange={(e) => e.target.value && onName.set(path, e.target.value)}>
        <option value="">{t('studio.chooseNode')}</option>
        {names
          .filter((n) => n.id !== name?.id)
          .map((n) => (
            <option key={n.id} value={n.id}>
              {nameText(n)}
            </option>
          ))}
      </select>
    </label>
  );

  if (!name) {
    return (
      <>
        <SectionHead title={t('studio.name.title')} help={`${t('studio.name.help')}${formsTable(node) ? ` ${t('studio.tableHelp')}` : ''}`} />
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            onName.create(path, text);
          }}
        >
          <input aria-label={t('studio.name.new')} value={text} placeholder={t('studio.name.new')} onChange={(e) => setText(e.target.value)} />
          <button className="button quiet" type="submit" disabled={text.trim() === ''}>
            {t('studio.name.give')}
          </button>
        </form>
        {names.length > 0 && choose}
      </>
    );
  }

  return (
    <>
      <SectionHead title={t('studio.name.title')} help={`${t('studio.name.help')}${formsTable(node) ? ` ${t('studio.tableHelp')}` : ''}`} />
      {others > 0 && <p className="meta">{t('studio.name.shared', { count: others })}</p>}
      {LANGUAGES.map((language) => (
        <label key={language} className="field compact">
          <span>{t(`studio.language.${language}`)}</span>
          <input
            value={language === 'en' ? name.text : (name.label?.[language] ?? '')}
            onChange={(e) => {
              const value = e.target.value;
              onName.edit(name.id, (n) => (language === 'en' ? { ...n, text: value } : withField(n, 'label', withLanguage(n.label, language, value))));
            }}
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
                value={name.description?.[language] ?? ''}
                onChange={(e) => {
                  const value = e.target.value;
                  onName.edit(name.id, (n) => withField(n, 'description', withLanguage(n.description, language, value)));
                }}
              />
            </label>
          ))}
        </>
      )}
      {names.length > 1 && choose}
      <button type="button" className="link-button" onClick={() => onName.set(path, undefined)}>
        {t('studio.name.remove')}
      </button>
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

/**
 * How the row finds its data: its matches (exact keys, or regular expressions), and joining or
 * splitting rows (ADR 0012). Every match is tested against the keys seen, so a researcher sees
 * what each one covers.
 */
function MatchSection({ tree, path, node, info, onPatch, onMatch, onKeysAreData }: Props & { node: ProjectNode }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const [text, setText] = useState('');
  const [regex, setRegex] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [combineWith, setCombineWith] = useState('');
  const parent = getNode(tree, path.slice(0, -1));
  const positional = isItemNode(node) || isKeysNode(node);
  const siblings = positional ? [] : (parent?.children ?? []).filter((c) => c !== node && c.kind === node.kind && !isItemNode(c) && !isKeysNode(c));
  const patch = (p: NodePatch) => onPatch(path, p);
  const keys = node.keys ?? [];
  const notes = info.get(node);

  function add(event: FormEvent) {
    event.preventDefault();
    const value = text.trim();
    if (value === '') return;
    const found = regex ? regexProblem(value) : undefined;
    setProblem(found);
    if (found) return;
    onMatch.add(path, regex ? { regex: value } : value);
    setText('');
  }

  return (
    <>
      {!positional && (
        <>
          <SectionHead title={t('studio.match.title')} help={t('studio.match.help')} />
          {node.virtual && <p className="meta">{t('studio.match.virtual')}</p>}
          <ul className="item-list">
            {node.match.map((m) => {
              const covers = keys.filter((k) => matchOne(m, k));
              return (
                <li key={matchText(m)}>
                  <code>{matchText(m)}</code>
                  {typeof m !== 'string' && (
                    <span className="meta"> {covers.length > 0 ? t('studio.match.covers', { keys: covers.join(', ') }) : t('studio.match.coversNothing')}</span>
                  )}
                  {!node.virtual && (
                    <button type="button" className="link-button" onClick={() => onMatch.remove(path, m)}>
                      {t('studio.remove')}
                      <span className="visually-hidden"> {matchText(m)}</span>
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          <form className="inline-form" onSubmit={add}>
            <input aria-label={t('studio.match.new')} value={text} placeholder={t('studio.match.new')} onChange={(e) => setText(e.target.value)} />
            <label className="check">
              <input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} />
              {t('studio.regex')}
            </label>
            <button className="button quiet" type="submit">
              {t('studio.add')}
            </button>
          </form>
          {problem && (
            <p className="message error" role="alert">
              {t('studio.match.bad', { problem })}
            </p>
          )}
          {keys.length > 1 && (
            <div className="section-head check-row">
              <span className="meta">{t('studio.match.keys', { count: keys.length, keys: keys.join(', ') })}</span>
              <button type="button" className="button quiet" onClick={() => onMatch.split(path)}>
                {t('studio.match.split')}
              </button>
            </div>
          )}
          {notes?.conflicts && <p className="message error">{t('studio.conflictHelp')}</p>}
          {notes?.alsoMatchedBy && <p className="meta">{t('studio.match.shared', { names: notes.alsoMatchedBy.join(', ') })}</p>}
        </>
      )}

      {siblings.length > 0 && (
        <>
          <SectionHead title={t('studio.combine.title')} help={t('studio.combine.help')} />
          <div className="inline-form">
            <select aria-label={t('studio.combine.with')} value={combineWith} onChange={(e) => setCombineWith(e.target.value)}>
              <option value="">{t('studio.chooseNode')}</option>
              {siblings.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <button
              className="button quiet"
              type="button"
              disabled={combineWith === ''}
              onClick={() => {
                onMatch.combine([path, [...path.slice(0, -1), combineWith]]);
                setCombineWith('');
              }}
            >
              {t('studio.combine.action')}
            </button>
          </div>
        </>
      )}

      <CheckWithHelp
        checked={node.required === true}
        onChange={(checked) => patch({ required: checked ? true : undefined })}
        label={t('studio.required')}
        help={t('studio.requiredHelp')}
      />

      {!isLeaf(node) && <NewChildrenSetting tree={tree} path={path} node={node} onPatch={patch} />}

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
        <ul className="item-list">
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
      <form className="inline-form" onSubmit={addPattern}>
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
