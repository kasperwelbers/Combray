/**
 * The match dialog: what a part holds, its name, and its decision, in one step. A part that is
 * not matched gets matched; a name another part has asks whether they are the same data (merge)
 * or only share the name. Matches and regular expressions are under "Advanced".
 */
import { getNode, isDecidable, nodesNamed, type LeafDecision, type Name, type NodePath, type ProjectNode } from '@combray/core';
import { useId, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { FieldValues as Values } from './api';
import { FieldValues } from './FieldValues';
import { HelpButton } from './Help';
import { displayName, type RowInfo } from './model';
import { nameTaken, rowName, type MatchChoice } from './naming';
import { MatchList, PanelHead, type MatchListActions } from './RowPanels';

/** A part that may be the same as this one (from the suggestions when a package was added). */
export interface MatchHint {
  path: NodePath;
  name: string;
  score: number;
}

interface Props {
  tree: ProjectNode;
  path: NodePath;
  names: Name[];
  info: RowInfo | undefined;
  values: Values | undefined;
  hasPackages: boolean;
  hints: MatchHint[];
  /** Something this part is in is ignored, so its own decision does not count. */
  ignoredAbove: boolean;
  /** Why this part cannot be merged into another, or undefined if it can. */
  mergeProblem: (target: NodePath) => string | undefined;
  onSave: (choice: MatchChoice) => void;
  onUnmatch: () => void;
  match: MatchListActions;
  onClose: () => void;
}

const LEAF_CHOICES: LeafDecision[] = ['show', 'donate', 'ignore'];

export function MatchDialog({ tree, path, names, info, values, hasPackages, hints, ignoredAbove, mergeProblem, onSave, onUnmatch, match, onClose }: Props) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const id = useId();
  const node = getNode(tree, path)!;
  const virtual = node.virtual === true;
  const decidable = isDecidable(node);
  const current = rowName(node, names, t);
  const [text, setText] = useState(current);
  const [decision, setDecision] = useState<LeafDecision | undefined>(node.decision);
  const [join, setJoin] = useState<'merge' | 'same-name'>('merge');
  const [renameAll, setRenameAll] = useState(true);

  const taken = useMemo(() => (text.trim() === current ? undefined : nameTaken(tree, path, names, text, t)), [tree, path, names, text, current, t]);
  const problem = taken?.sibling ? mergeProblem(taken.sibling) : undefined;
  const canMerge = taken?.sibling !== undefined && problem === undefined;
  const joining = taken ? (canMerge ? join : 'same-name') : undefined;
  const ownName = node.nameId === undefined ? undefined : names.find((n) => n.id === node.nameId);
  const sharedWith = ownName ? nodesNamed(tree, ownName.id).length - 1 : 0;
  const suggestions = useMemo(() => [...new Set(names.map((n) => n.text))].sort(), [names]);
  // A field needs a decision to be matched; a folder or object is matched by its name alone.
  const needsDecision = decidable && (decision === undefined || decision === 'undecided');
  const where = path.map((_, i) => displayName(getNode(tree, path.slice(0, i + 1))?.name ?? '', t)).join(' / ');

  function save(event: FormEvent) {
    event.preventDefault();
    if (text.trim() === '' || (needsDecision && joining !== 'merge')) return;
    onSave({
      text,
      ...(joining ? { join: joining } : {}),
      ...(sharedWith > 0 ? { renameAll } : {}),
      ...(joining === 'merge' ? {} : decidable ? (decision !== undefined ? { decision } : {}) : { decision: decision === 'ignore' ? 'ignore' : 'undecided' }),
    });
  }

  return (
    <form className="match-dialog" onSubmit={save}>
      <PanelHead title={virtual ? t('studio.matchDialog.titleNew') : t('studio.matchDialog.title')} onClose={onClose}>
        <details className="match-where">
          <summary className="meta">{t('studio.details.where')}</summary>
          <div className="meta path">{where}</div>
        </details>
        <div className="meta">
          {t(`kind.${node.kind}`)}
          {node.types && ` · ${node.types.map((type) => t(`type.${type}`)).join(', ')}`}
          {node.repeat && ` · ${t(`studio.repeat.${node.repeat}`)}`}
        </div>
      </PanelHead>

      {decidable && <FieldValues values={values} hasPackages={hasPackages} />}

      <div className="section-head">
        <label htmlFor={`${id}-name`}>
          <strong>{t('studio.matchDialog.name')}</strong>
        </label>
        <HelpButton topic="names" />
      </div>
      <input id={`${id}-name`} list={`${id}-names`} value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />
      <datalist id={`${id}-names`}>
        {suggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      {hints.length > 0 && !taken && (
        <ul className="match-hints">
          {hints.map((h) => (
            <li key={h.path.join('/')} className="meta">
              {t('studio.matchDialog.hint', { name: h.name, score: Math.round(h.score * 100) })}{' '}
              <button type="button" className="link-button" onClick={() => setText(h.name)}>
                {t('studio.matchDialog.useHint')}
              </button>
            </li>
          ))}
        </ul>
      )}
      {sharedWith > 0 && !taken && text.trim() !== current && (
        <label className="check">
          <input type="checkbox" checked={renameAll} onChange={(e) => setRenameAll(e.target.checked)} />
          {t('studio.matchDialog.renameAll', { count: sharedWith })}
        </label>
      )}

      {taken && (
        <fieldset className="match-join">
          <legend>
            {t('studio.matchDialog.taken', { count: taken.count })} <HelpButton topic="same-name" />
          </legend>
          <label className="check">
            <input type="radio" name={`${id}-join`} checked={joining === 'merge'} disabled={!canMerge} onChange={() => setJoin('merge')} />
            <span>
              {t('studio.matchDialog.merge')}
              <span className="meta"> {canMerge ? t('studio.matchDialog.mergeHelp') : (problem ?? t('studio.matchDialog.mergeElsewhere'))}</span>
            </span>
          </label>
          <label className="check">
            <input type="radio" name={`${id}-join`} checked={joining === 'same-name'} onChange={() => setJoin('same-name')} />
            <span>
              {t('studio.matchDialog.sameName')}
              <span className="meta"> {t('studio.matchDialog.sameNameHelp')}</span>
            </span>
          </label>
        </fieldset>
      )}

      {joining !== 'merge' && (
        <fieldset className="match-decision">
          <legend>
            {t('studio.matchDialog.decision')} <HelpButton topic="decisions" />
          </legend>
          {decidable ? (
            <div className="segmented" role="group">
              {LEAF_CHOICES.map((d) => (
                <button key={d} type="button" className={`seg seg-${d}`} aria-pressed={decision === d} onClick={() => setDecision(d)}>
                  {t(`studio.decision.${d}`)}
                </button>
              ))}
            </div>
          ) : (
            <div className="segmented" role="group">
              <button type="button" className="seg" aria-pressed={decision !== 'ignore'} onClick={() => setDecision(undefined)}>
                {t('studio.matchDialog.perPart')}
              </button>
              <button type="button" className="seg seg-ignore" aria-pressed={decision === 'ignore'} onClick={() => setDecision('ignore')}>
                {t('studio.matchDialog.ignoreAll')}
              </button>
            </div>
          )}
        </fieldset>
      )}

      {ignoredAbove && <p className="meta">{t('studio.ignoredAbove')}</p>}

      {!virtual && (
        <details className="match-advanced">
          <summary>{t('studio.matchDialog.advanced')}</summary>
          <MatchList path={path} node={node} info={info} actions={match} />
        </details>
      )}

      <div className="actions">
        <button className="button" type="submit" disabled={text.trim() === '' || (needsDecision && joining !== 'merge')}>
          {virtual ? t('studio.matchDialog.match') : t('studio.matchDialog.save')}
        </button>
        <button type="button" className="button quiet" onClick={onClose}>
          {t('studio.matchDialog.cancel')}
        </button>
        {!virtual && path.length > 0 && (
          <button type="button" className="link-button" onClick={onUnmatch}>
            {t('studio.matchDialog.unmatch')}
          </button>
        )}
      </div>
      {needsDecision && joining !== 'merge' && <p className="meta">{t('studio.matchDialog.chooseDecision')}</p>}
    </form>
  );
}
