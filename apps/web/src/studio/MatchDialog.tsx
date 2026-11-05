/**
 * The match dialog: what a part holds, its name, and its decision, in one step. A part that is
 * not matched gets matched. Only tables and fields have names; a name another part next to this
 * one has asks whether they are the same data (combine) or only share the name. Renaming a name
 * others share renames it for all of them, or splits this part off. Matches and regular
 * expressions are under "Advanced".
 */
import { getNode, isDecidable, nameProblem, toName, treeNames, typingName, type LeafDecision, type NodePath, type ProjectNode } from '@combray/core';
import { useId, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { FieldValues as Values } from './api';
import { FieldValues } from './FieldValues';
import { HelpButton } from './Help';
import { displayName, type RowInfo } from './model';
import { nameInfo, nameTaken, type MatchChoice } from './naming';
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
  info: RowInfo | undefined;
  values: Values | undefined;
  hasPackages: boolean;
  hints: MatchHint[];
  /** Something this part is in is ignored, so its own decision does not count. */
  ignoredAbove: boolean;
  /** Why this part cannot be combined with another, or undefined if it can. */
  mergeProblem: (target: NodePath) => string | undefined;
  onSave: (choice: MatchChoice) => void;
  onUnmatch: () => void;
  match: MatchListActions;
  onClose: () => void;
}

const LEAF_CHOICES: LeafDecision[] = ['show', 'donate', 'ignore'];

export function MatchDialog({ tree, path, info, values, hasPackages, hints, ignoredAbove, mergeProblem, onSave, onUnmatch, match, onClose }: Props) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const id = useId();
  const node = getNode(tree, path)!;
  const virtual = node.virtual === true;
  const decidable = isDecidable(node);
  const names = useMemo(() => treeNames(tree), [tree]);
  const named = useMemo(() => nameInfo(tree, path, names), [tree, path, names]);
  const current = named?.name ?? '';
  const [text, setText] = useState(current);
  const [decision, setDecision] = useState<LeafDecision | undefined>(node.decision);
  const [join, setJoin] = useState<'combine' | 'same-name'>('combine');
  const [renameAll, setRenameAll] = useState(true);
  const [moveReferences, setMoveReferences] = useState(false);

  const wanted = text.replace(/_+$/, '');
  const changed = named !== undefined && wanted !== current;
  const problem = changed ? nameProblem(tree, path, wanted, names) : undefined;
  const taken = useMemo(() => (changed && !problem ? nameTaken(tree, path, wanted, names) : undefined), [changed, problem, tree, path, wanted, names]);
  const combineProblem = taken?.sibling ? mergeProblem(taken.sibling) : undefined;
  const canCombine = taken?.sibling !== undefined && combineProblem === undefined;
  const joining = taken ? (canCombine ? join : 'same-name') : undefined;
  const sharedWith = (named?.group.length ?? 1) - 1;
  // Names this one could share: fields of the same table, or tables next to it.
  const suggestions = useMemo(() => {
    if (!named) return [];
    if (named.kind === 'field') {
      const table = names.fields.get(path.join('/'))?.table;
      return [...new Set([...names.fields.values()].filter((f) => f.table === table && f.id !== '{value}').map((f) => f.id))].sort();
    }
    return [...new Set(names.tables.slice(1).map((t) => t.id))].sort();
  }, [named, names, path]);
  // A field needs a decision to be matched; a folder or object is matched by its key alone.
  const needsDecision = decidable && (decision === undefined || decision === 'undecided');
  const blocked = (named !== undefined && (wanted === '' || problem !== undefined)) || (needsDecision && joining !== 'combine');
  const where = path.map((_, i) => displayName(getNode(tree, path.slice(0, i + 1))?.name ?? '', t)).join(' / ');

  function save(event: FormEvent) {
    event.preventDefault();
    if (blocked) return;
    onSave({
      ...(named ? { name: wanted } : {}),
      ...(joining ? { join: joining } : {}),
      ...(sharedWith > 0 && changed && !taken ? { renameAll, moveReferences } : {}),
      ...(joining === 'combine' ? {} : decidable ? (decision !== undefined ? { decision } : {}) : { decision: decision === 'ignore' ? 'ignore' : 'undecided' }),
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
          {named ? t(`studio.matchDialog.kind.${named.kind}`) : t(`kind.${node.kind}`)}
          {node.types && ` · ${node.types.map((type) => t(`type.${type}`)).join(', ')}`}
          {node.repeat && ` · ${t(`studio.repeat.${node.repeat}`)}`}
        </div>
      </PanelHead>

      {decidable && <FieldValues values={values} hasPackages={hasPackages} />}

      {named ? (
        <>
          <div className="section-head">
            <label htmlFor={`${id}-name`}>
              <strong>{t('studio.matchDialog.name')}</strong>
            </label>
            <HelpButton topic="names" />
          </div>
          <input
            id={`${id}-name`}
            className="name-input"
            list={`${id}-names`}
            value={text}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={problem !== undefined}
            aria-describedby={`${id}-name-note`}
            onChange={(e) => setText(typingName(e.target.value))}
          />
          <datalist id={`${id}-names`}>
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
          <p id={`${id}-name-note`} className={`meta${problem ? ' error' : ''}`}>
            {problem ?? (named.own || changed ? t('studio.matchDialog.nameRules') : t('studio.matchDialog.fromKey'))}
          </p>
          {sharedWith > 0 && !changed && <p className="meta">{t('studio.matchDialog.shared', { number: named.number, count: sharedWith + 1 })}</p>}
        </>
      ) : (
        <p className="meta">{t('studio.matchDialog.noName')}</p>
      )}
      {hints.length > 0 && !taken && named && (
        <ul className="match-hints">
          {hints.map((h) => (
            <li key={h.path.join('/')} className="meta">
              {t('studio.matchDialog.hint', { name: h.name, score: Math.round(h.score * 100) })}{' '}
              <button type="button" className="link-button" onClick={() => setText(toName(h.name))}>
                {t('studio.matchDialog.useHint')}
              </button>
            </li>
          ))}
        </ul>
      )}
      {sharedWith > 0 && changed && !problem && !taken && (
        <fieldset className="match-join">
          <legend>{t('studio.matchDialog.renameShared', { name: current, count: sharedWith + 1 })}</legend>
          <label className="check">
            <input type="radio" name={`${id}-rename`} checked={renameAll} onChange={() => setRenameAll(true)} />
            <span>
              {t('studio.matchDialog.renameAll', { count: sharedWith + 1 })}
              <span className="meta"> {t('studio.matchDialog.renameAllHelp')}</span>
            </span>
          </label>
          <label className="check">
            <input type="radio" name={`${id}-rename`} checked={!renameAll} onChange={() => setRenameAll(false)} />
            <span>
              {t('studio.matchDialog.renameOne')}
              <span className="meta"> {t('studio.matchDialog.renameOneHelp', { name: current })}</span>
            </span>
          </label>
          {!renameAll && (
            <label className="check">
              <input type="checkbox" checked={moveReferences} onChange={(e) => setMoveReferences(e.target.checked)} />
              {t('studio.matchDialog.moveReferences', { name: wanted })}
            </label>
          )}
        </fieldset>
      )}

      {taken && (
        <fieldset className="match-join">
          <legend>
            {t('studio.matchDialog.taken', { count: taken.count })} <HelpButton topic="same-name" />
          </legend>
          <label className="check">
            <input type="radio" name={`${id}-join`} checked={joining === 'combine'} disabled={!canCombine} onChange={() => setJoin('combine')} />
            <span>
              {t('studio.matchDialog.combine')}
              <span className="meta"> {canCombine ? t('studio.matchDialog.combineHelp') : (combineProblem ?? t('studio.matchDialog.combineElsewhere'))}</span>
            </span>
          </label>
          <label className="check">
            <input type="radio" name={`${id}-join`} checked={joining === 'same-name'} onChange={() => setJoin('same-name')} />
            <span>
              {t('studio.matchDialog.sameName')}
              <span className="meta"> {t(`studio.matchDialog.sameNameHelp.${named?.kind ?? 'field'}`)}</span>
            </span>
          </label>
        </fieldset>
      )}

      {joining !== 'combine' && (
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
        <button className="button" type="submit" disabled={blocked}>
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
      {needsDecision && joining !== 'combine' && <p className="meta">{t('studio.matchDialog.chooseDecision')}</p>}
    </form>
  );
}
