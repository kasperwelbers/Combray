/**
 * The settings of one row, each in its own small panel next to the button that opens it: how its
 * values are read, which rows a table keeps, and the rarer settings under "More". The name and
 * decision are in the match dialog (`MatchDialog.tsx`); the whole platform's settings sit behind
 * a button above the tree.
 */
import {
  closedNodes,
  textNamesOf,
  findPatternProblem,
  getNode,
  isLeaf,
  matchOne,
  matchText,
  regexProblem,
  type Match,
  type NodePath,
  type ProjectNode,
} from '@combray/core';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Conversion } from './Conversion';
import { HelpButton, type HelpTopic } from './Help';
import { filterColumns, type NodePatch, type RowInfo } from './model';
import { SectionHead } from './Popover';
import { RowFilters } from './RowFilters';

/** The panels a row can open. */
export type RowPanel = 'name' | 'read' | 'rows' | 'more' | 'platform';

/** Rows of a table (a list's items, or keys that are data) with more than plain values. */
export const isTableRows = (node: ProjectNode) => (node.name === '[*]' || node.name === '{*}') && !isLeaf(node);

/** A panel's title, with a button to close it. */
export function PanelHead({ title, onClose, children }: { title: string; onClose: () => void; children?: ReactNode }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  return (
    <div className="node-details-head">
      <div>
        <strong>{title}</strong>
        {children}
      </div>
      <button type="button" className="close-button" onClick={onClose}>
        <span aria-hidden="true">×</span>
        <span className="visually-hidden">{t('studio.details.close')}</span>
      </button>
    </div>
  );
}

/** How a field's values are read, and whether the value as it is in the file is donated too. */
export function ReadPanel({ node, onPatch }: { node: ProjectNode; onPatch: (patch: NodePatch) => void }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  return (
    <>
      <Conversion node={node} onPatch={onPatch} />
      {node.decision === 'donate' && (node.as || node.transform?.length) ? (
        <label className="check">
          <input type="checkbox" checked={node.raw === true} onChange={(e) => onPatch({ raw: e.target.checked ? true : undefined })} />
          {t('studio.raw')}
        </label>
      ) : null}
    </>
  );
}

/** Which rows of a table are kept, and whether its first row holds the column names. */
export function RowsPanel({ tree, path, node, onPatch }: { tree: ProjectNode; path: NodePath; node: ProjectNode; onPatch: (patch: NodePatch) => void }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const topTable = node.name === '[*]' && !path.slice(0, -1).some((_, i) => ['[*]', '{*}'].includes(getNode(tree, path.slice(0, i + 1))?.name ?? ''));
  return (
    <>
      <RowFilters node={node} columns={filterColumns(tree, path)} onPatch={onPatch} />
      {topTable && (
        <CheckWithHelp
          checked={node.headerRow === true}
          onChange={(checked) => onPatch({ headerRow: checked ? true : undefined })}
          label={t('studio.headerRow')}
          topic="header-row"
        />
      )}
    </>
  );
}

/** Set one language of a per-language text; empty texts are removed, and so is an empty map. */
export interface MoreActions {
  keysAreData: (path: NodePath) => void;
}

/** The rarer settings of a row: whether uploads need it, new parts below it, and keys that are data. */
export function MorePanel({
  tree,
  path,
  node,
  onPatch,
  actions,
}: {
  tree: ProjectNode;
  path: NodePath;
  node: ProjectNode;
  onPatch: (patch: NodePatch) => void;
  actions: MoreActions;
}) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  // Offered on elements with one list of pairs or two lists of labels and values.
  const textNames = textNamesOf(node);
  return (
    <>
      <CheckWithHelp
        checked={node.required === true}
        onChange={(checked) => onPatch({ required: checked ? true : undefined })}
        label={t('studio.required')}
        topic="required"
      />
      {!isLeaf(node) && <NewChildrenSetting tree={tree} path={path} node={node} onPatch={onPatch} />}
      {(node.kind === 'map' || node.kind === 'dir') && (
        <>
          <SectionHead title={t('studio.keysTitle')} topic="keys-are-data" />
          {node.collapsed ? (
            <p className="meta">{t('studio.keysAreData')}</p>
          ) : (
            <button className="button quiet" type="button" onClick={() => actions.keysAreData(path)}>
              {t('studio.makeKeysData')}
            </button>
          )}
        </>
      )}
      {(node.textNames || textNames) && (
        <>
          <SectionHead title={t('studio.textsTitle')} topic="texts-are-names" />
          {node.textNames ? (
            <>
              <p className="meta">{t(`studio.textsAreNames.${node.textNames}`)}</p>
              <button className="button quiet" type="button" onClick={() => onPatch({ textNames: undefined })}>
                {t('studio.textsBackToValues')}
              </button>
            </>
          ) : (
            <button className="button quiet" type="button" onClick={() => onPatch({ textNames })}>
              {t('studio.makeTextsNames')}
            </button>
          )}
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
      <SectionHead title={t('studio.newChildren')} topic="skip-new" />
      <select
        aria-label={t('studio.newChildren')}
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

export interface MatchListActions {
  add: (path: NodePath, match: Match) => void;
  remove: (path: NodePath, match: Match) => void;
  split: (path: NodePath) => void;
}

/**
 * The keys a node matches: exact keys, or regular expressions, each tested against the keys seen
 * so a researcher sees what it covers (ADR 0012). For the match dialog's "Advanced".
 */
export function MatchList({ path, node, info, actions }: { path: NodePath; node: ProjectNode; info: RowInfo | undefined; actions: MatchListActions }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const [text, setText] = useState('');
  const [regex, setRegex] = useState(false);
  const [problem, setProblem] = useState<string>();
  const keys = node.keys ?? [];

  // Not a form of its own: the list sits inside the match dialog's form.
  function add() {
    const value = text.trim();
    if (value === '') return;
    const found = regex ? regexProblem(value) : undefined;
    setProblem(found);
    if (found) return;
    actions.add(path, regex ? { regex: value } : value);
    setText('');
  }

  return (
    <>
      <SectionHead title={t('studio.match.title')} topic="matches" />
      <ul className="item-list">
        {node.match.map((m) => {
          const covers = keys.filter((k) => matchOne(m, k));
          return (
            <li key={matchText(m)}>
              <code>{matchText(m)}</code>
              {typeof m !== 'string' && (
                <span className="meta"> {covers.length > 0 ? t('studio.match.covers', { keys: covers.join(', ') }) : t('studio.match.coversNothing')}</span>
              )}
              {node.match.length > 1 && (
                <button type="button" className="link-button" onClick={() => actions.remove(path, m)}>
                  {t('studio.remove')}
                  <span className="visually-hidden"> {matchText(m)}</span>
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <div className="inline-form" role="group" aria-label={t('studio.match.new')}>
        <input
          aria-label={t('studio.match.new')}
          value={text}
          placeholder={t('studio.match.new')}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            add();
          }}
        />
        <label className="check">
          <input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} />
          {t('studio.regex')}
        </label>
        <button className="button quiet" type="button" onClick={add}>
          {t('studio.add')}
        </button>
      </div>
      {problem && (
        <p className="message error" role="alert">
          {t('studio.match.bad', { problem })}
        </p>
      )}
      {keys.length > 1 && (
        <div className="section-head check-row">
          <span className="meta">{t('studio.match.keys', { count: keys.length, keys: keys.join(', ') })}</span>
          <button type="button" className="button quiet" onClick={() => actions.split(path)}>
            {t('studio.match.split')}
          </button>
        </div>
      )}
      {info?.conflicts && (
        <p className="message error">
          {t('studio.conflict', { count: info.conflicts })} <HelpButton topic="conflict" />
        </p>
      )}
      {info?.alsoMatchedBy && <p className="meta">{t('studio.match.shared', { names: info.alsoMatchedBy.join(', ') })}</p>}
    </>
  );
}

/** Settings of the whole platform: what participants see of parts not decided, and finding the package. */
export function PlatformPanel({ tree, node, onPatch }: { tree: ProjectNode; node: ProjectNode; onPatch: (patch: NodePatch) => void }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const [pattern, setPattern] = useState('');
  const [problem, setProblem] = useState<string>();

  function addPattern(event: FormEvent) {
    event.preventDefault();
    const text = pattern.trim();
    const found = findPatternProblem(text);
    setProblem(found);
    if (found) return;
    onPatch({ find: [...(node.find ?? []), text] });
    setPattern('');
  }

  return (
    <>
      <CheckWithHelp
        checked={node.undecided === 'show'}
        onChange={(checked) => onPatch({ undecided: checked ? 'show' : undefined })}
        label={t('studio.undecidedShown')}
        topic="undecided-shown"
      />

      <SectionHead title={t('studio.findTitle')} topic="find" />
      {node.find && node.find.length > 0 && (
        <ul className="item-list">
          {node.find.map((p, i) => (
            <li key={`${p}:${i}`}>
              <code>{p}</code>
              <button type="button" className="link-button" onClick={() => onPatch({ find: node.find!.filter((_, j) => j !== i) })}>
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

      <NewChildrenSetting tree={tree} path={[]} node={node} onPatch={onPatch} />
    </>
  );
}

/** A checkbox with a "?" to its explanation (outside the label, so "?" does not toggle it). */
export function CheckWithHelp({
  checked,
  onChange,
  label,
  topic,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  topic: HelpTopic;
}) {
  return (
    <div className="section-head check-row">
      <label className="check">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        {label}
      </label>
      <HelpButton topic={topic} />
    </div>
  );
}
