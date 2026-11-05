import {
  ROLES,
  type FieldType,
  type ProjectNode,
  type Role,
  type Transform,
} from '@combray/core';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { SectionHead } from './Popover';
import type { NodePatch } from './model';

/** Types a researcher can read a field as, in the order the menu shows them. */
const READ_AS: FieldType[] = ['datetime', 'int', 'float', 'bool', 'url', 'domain', 'duration'];

type TransformKind = 'trim' | 'lowercase' | 'remove' | 'keep';

function transformText(transform: Transform, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (typeof transform === 'string') return t(`studio.transform.${transform}`);
  if ('replace' in transform) return t('studio.transform.removeText', { pattern: transform.replace.pattern });
  if ('match' in transform) return t('studio.transform.keepText', { pattern: transform.match.pattern });
  return t('studio.transform.split', { by: transform.split.by });
}

/**
 * How a field is read: cleaning steps, then a type (a date with the format it is written in, a
 * number, a link's website), and what it is for in participant views. Participants see and
 * donate the converted value.
 */
export function Conversion({ node, onPatch }: { node: ProjectNode; onPatch: (patch: NodePatch) => void }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const [kind, setKind] = useState<TransformKind>('trim');
  const [pattern, setPattern] = useState('');
  const [error, setError] = useState(false);
  const transforms = node.transform ?? [];
  const needsPattern = kind === 'remove' || kind === 'keep';

  function addTransform(event: FormEvent) {
    event.preventDefault();
    let next: Transform;
    if (needsPattern) {
      try {
        new RegExp(pattern);
      } catch {
        setError(true);
        return;
      }
      if (pattern === '') return;
      // "Keep" keeps the first group if the pattern has one, else the whole match.
      next =
        kind === 'remove'
          ? { replace: { pattern, with: '' } }
          : { match: { pattern, group: new RegExp(`${pattern}|`).exec('')!.length > 1 ? 1 : 0 } };
    } else {
      next = kind;
    }
    setError(false);
    setPattern('');
    onPatch({ transform: [...transforms, next] });
  }

  return (
    <div className="panel-group">
      <SectionHead title={t('studio.readAs')} topic="read-as" />
      <label className="field">
        <span>{t('studio.type')}</span>
        <select
          value={node.as ?? ''}
          onChange={(e) => {
            const as = (e.target.value || undefined) as FieldType | undefined;
            onPatch({ as, ...(as !== 'datetime' ? { format: undefined } : {}) });
          }}
        >
          <option value="">{t('studio.as.text')}</option>
          {READ_AS.map((as) => (
            <option key={as} value={as}>
              {t(`studio.as.${as}`)}
            </option>
          ))}
        </select>
      </label>
      {node.as === 'datetime' && <DateFormats node={node} onPatch={onPatch} />}
      <label className="field">
        <span>{t('studio.role')}</span>
        <select value={node.role ?? ''} onChange={(e) => onPatch({ role: (e.target.value || undefined) as Role | undefined })}>
          <option value="">{t('studio.roles.none')}</option>
          {ROLES.map((role) => (
            <option key={role} value={role}>
              {t(`studio.roles.${role}`)}
            </option>
          ))}
        </select>
      </label>

      <SectionHead title={t('studio.cleanTitle')} topic="clean" />
      {transforms.length > 0 && (
        <ol className="item-list">
          {transforms.map((transform, i) => (
            <li key={`${JSON.stringify(transform)}:${i}`}>
              <span>{transformText(transform, t)}</span>
              <button
                type="button"
                className="link-button"
                onClick={() => onPatch({ transform: transforms.filter((_, j) => j !== i) })}
              >
                {t('studio.remove')}
                <span className="visually-hidden"> {transformText(transform, t)}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
      <form className="inline-form" onSubmit={addTransform}>
        <label className="visually-hidden" htmlFor="transform-kind">
          {t('studio.cleanStep')}
        </label>
        <select id="transform-kind" value={kind} onChange={(e) => setKind(e.target.value as TransformKind)}>
          {(['trim', 'lowercase', 'remove', 'keep'] as const).map((k) => (
            <option key={k} value={k}>
              {t(`studio.cleanKind.${k}`)}
            </option>
          ))}
        </select>
        {needsPattern && (
          <>
            <label className="visually-hidden" htmlFor="transform-pattern">
              {t('studio.pattern')}
            </label>
            <input
              id="transform-pattern"
              value={pattern}
              placeholder={t('studio.pattern')}
              onChange={(e) => setPattern(e.target.value)}
            />
          </>
        )}
        <button className="button quiet" type="submit">
          {t('studio.add')}
        </button>
      </form>
      {error && (
        <p className="message error" role="alert">
          {t('studio.badRegex')}
        </p>
      )}
    </div>
  );
}

/**
 * How dates are written: automatic, or one or more formats, tried in order (the first that reads
 * a value wins), for a field whose format changed between versions of a package.
 */
function DateFormats({ node, onPatch }: { node: ProjectNode; onPatch: (patch: NodePatch) => void }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const chosen = node.format === undefined ? [] : Array.isArray(node.format) ? node.format : [node.format];
  const known = [...new Set([...(node.formats ?? []), ...chosen])];
  const set = (list: string[]) => onPatch({ format: list.length === 0 ? undefined : list.length === 1 ? list[0] : list });
  const rest = known.filter((f) => !chosen.includes(f));
  if (chosen.length === 0) {
    return (
      <label className="field">
        <span>{t('studio.writtenAs')}</span>
        <select value="" onChange={(e) => e.target.value && set([e.target.value])}>
          <option value="">{t('studio.formatAuto')}</option>
          {known.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <fieldset className="field date-formats">
      <legend>{t('studio.writtenAs')}</legend>
      <ol>
        {chosen.map((f, i) => (
          <li key={f}>
            <select value={f} onChange={(e) => set(chosen.map((c, j) => (j === i ? e.target.value : c)))}>
              {[f, ...rest].map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            <button type="button" className="link-button" onClick={() => set(chosen.filter((_, j) => j !== i))}>
              {t('studio.formatRemove')}
              <span className="visually-hidden"> {f}</span>
            </button>
          </li>
        ))}
      </ol>
      {rest.length > 0 && (
        <select value="" aria-label={t('studio.formatAnother')} onChange={(e) => e.target.value && set([...chosen, e.target.value])}>
          <option value="">{t('studio.formatAnother')}</option>
          {rest.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      )}
      {chosen.length > 1 && <p className="meta">{t('studio.formatsInOrder')}</p>}
    </fieldset>
  );
}
