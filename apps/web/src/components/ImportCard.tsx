import { localize, type RootChoice } from '@combray/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ImportProgress, ImportResult, Upload, UploadPoint } from '../worker/api';
import { chooseRoots, data, importFiles } from '../worker/client';
import { Dropzone } from './Dropzone';

interface Props {
  /** The platform this card adds data for; without one, the YAML importers run. */
  point?: UploadPoint;
  /** Another card is importing: the worker handles one import at a time. */
  disabled: boolean;
  onBusy: (busy: boolean) => void;
  onDone: () => Promise<void>;
}

type Problem = Exclude<ImportResult['status'], 'done' | 'choose'> | 'failed';

/**
 * Adding data for one platform: one uploader per upload point
 * (docs/tree-decisions.md#finding-the-export-in-an-upload), and one upload: a new one replaces the
 * one before (ADR 0015). When more than one place in the
 * upload fits, the participant chooses; paths are shown here only and never stored.
 */
export function ImportCard({ point, disabled, onBusy, onDone }: Props) {
  const { t, i18n } = useTranslation();
  const [progress, setProgress] = useState<ImportProgress>();
  const [problem, setProblem] = useState<Problem>();
  const [choice, setChoice] = useState<{ choices: RootChoice[]; multiple: boolean }>();
  const [picked, setPicked] = useState<number[]>([]);
  const name = point?.name ? localize(point.name, i18n.language) : point ? point.id : t('import.yourData');
  const id = `import-${point?.id ?? 'any'}`;

  async function step(work: () => Promise<ImportResult>) {
    setProblem(undefined);
    setChoice(undefined);
    setProgress({ step: 'looking' });
    onBusy(true);
    // Other cards wait while this one waits for a choice: the worker keeps one import open.
    let waiting = false;
    try {
      const result = await work();
      if (result.status === 'done') await onDone();
      else if (result.status === 'choose') {
        setChoice(result);
        setPicked([]);
        waiting = true;
      } else setProblem(result.status);
    } catch {
      setProblem('failed');
    } finally {
      setProgress(undefined);
      onBusy(waiting);
    }
  }

  const run = (files: Upload[]) => (files.length === 0 ? Promise.resolve() : step(() => importFiles(files, setProgress, point)));

  function cancel() {
    setChoice(undefined);
    onBusy(false);
    void data.cancelImport();
  }

  const toggle = (choiceId: number, on: boolean) =>
    setPicked((p) => (choice?.multiple ? (on ? [...p, choiceId] : p.filter((x) => x !== choiceId)) : [choiceId]));

  return (
    <section className="card" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{point ? t('import.titleFor', { name }) : t('import.title')}</h2>
      <p>{point ? t('import.introFor', { name }) : t('import.intro')}</p>
      {point && <p className="meta">{t('import.replaces', { name })}</p>}
      {choice ? (
        <fieldset className="panel-group">
          <legend>{t('import.choose.title', { name })}</legend>
          <p className="meta">{choice.multiple ? t('import.choose.several') : t('import.choose.one')}</p>
          {choice.choices.map((c) => (
            <label key={c.id} className="check">
              <input
                type={choice.multiple ? 'checkbox' : 'radio'}
                name={`${id}-choice`}
                checked={picked.includes(c.id)}
                onChange={(e) => toggle(c.id, e.target.checked)}
              />
              <code>{c.path}</code>
            </label>
          ))}
          <div className="actions">
            <button
              className="button"
              type="button"
              disabled={picked.length === 0}
              onClick={() => void step(() => chooseRoots(picked, setProgress))}
            >
              {t('import.choose.add')}
            </button>
            <button className="button quiet" type="button" onClick={cancel}>
              {t('import.choose.cancel')}
            </button>
          </div>
        </fieldset>
      ) : (
        <Dropzone busy={disabled || progress !== undefined} onFiles={run} />
      )}
      <div aria-live="polite">
        {progress && (
          <p className="message" style={{ marginTop: '1rem' }}>
            {t(`import.step.${progress.step}`)}
          </p>
        )}
        {problem && (
          <p className="message error" role="alert" style={{ marginTop: '1rem' }}>
            {problem === 'failed' ? t('import.failed') : t(`import.problem.${problem}`, { name })}
          </p>
        )}
      </div>
    </section>
  );
}
