/**
 * The blocks of a story's slides as participants see them: text, a view of their data with its
 * sentence, and questions. The studio previews slides with them too, with made-up numbers.
 * Text is rendered as text, never as HTML.
 */
import { fillText, localize, optionValue, validAnswer, type Answer, type QuestionBlock, type StoryBlock } from '@combray/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { StoryView } from '../worker/api';
import { StoryViewChart, storyValues } from './StoryViews';

/** One block of a slide. */
export function Block({
  block,
  views,
  answer,
  onAnswer,
}: {
  block: StoryBlock;
  views: Record<string, StoryView>;
  answer: Answer | undefined;
  onAnswer: (q: QuestionBlock, a: Answer | null) => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? 'en';
  if (block.type === 'text') return <Paragraphs text={localize(block.text, language)} />;
  if (block.type === 'question') return <Question question={block} answer={answer} onAnswer={onAnswer} />;
  const view = views[block.id];
  if (!view) return <p className="story-text">{block.empty ? localize(block.empty, language) : t('story.noData')}</p>;
  return (
    <div className="story-data">
      <StoryViewChart view={view} {...(block.text ? { message: fillText(block.text, language, storyValues(view, language, t)) } : {})} />
    </div>
  );
}

/** Text, in paragraphs at blank lines. Plain text only: never read as HTML. */
function Paragraphs({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/\n\s*\n/)
        .filter((p) => p.trim())
        .map((p, i) => (
          <p key={i} className="story-text">
            {p}
          </p>
        ))}
    </>
  );
}

function Question({
  question,
  answer,
  onAnswer,
}: {
  question: QuestionBlock;
  answer: Answer | undefined;
  onAnswer: (q: QuestionBlock, a: Answer | null) => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? 'en';
  const id = `question-${question.id}`;
  const prompt = localize(question.prompt, language);
  return (
    <fieldset className="story-question" aria-describedby={`${id}-note`}>
      <legend id={`${id}-prompt`}>{prompt}</legend>
      {question.kind === 'choice' && (
        <div className="story-choices">
          {(question.options ?? []).map((option) => {
            const value = optionValue(option);
            const chosen = answer === value;
            return (
              <button
                key={value}
                type="button"
                className="story-choice"
                aria-pressed={chosen}
                // Choosing it again takes the answer back.
                onClick={() => void onAnswer(question, chosen ? null : value)}
              >
                {localize(option, language)}
              </button>
            );
          })}
        </div>
      )}
      {question.kind === 'open' && <OpenAnswer question={question} answer={answer} onAnswer={onAnswer} labelledBy={`${id}-prompt`} />}
      {question.kind === 'number' && <NumberAnswer question={question} answer={answer} onAnswer={onAnswer} labelledBy={`${id}-prompt`} />}
      <p id={`${id}-note`} className="meta">
        {question.required ? t('story.required') : t('story.optional')}
      </p>
    </fieldset>
  );
}

/** Text is saved a moment after typing stops, and when leaving the field. */
function OpenAnswer({
  question,
  answer,
  onAnswer,
  labelledBy,
}: {
  question: QuestionBlock;
  answer: Answer | undefined;
  onAnswer: (q: QuestionBlock, a: Answer | null) => Promise<void>;
  labelledBy: string;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(typeof answer === 'string' ? answer : '');
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const commit = useCallback(
    async (value: string) => {
      clearTimeout(timer.current);
      await onAnswer(question, value.trim() ? value : null);
      setSaved(value.trim() !== '');
    },
    [onAnswer, question],
  );

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <>
      <textarea
        className="story-open"
        aria-labelledby={labelledBy}
        placeholder={t('story.answerPlaceholder')}
        maxLength={2000}
        rows={3}
        value={text}
        onChange={(e) => {
          const value = e.target.value;
          setText(value);
          setSaved(false);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => void commit(value), 600);
        }}
        onBlur={() => void commit(text)}
      />
      <p className="meta story-saved" aria-live="polite">
        {saved ? t('story.saved') : ''}
      </p>
    </>
  );
}

function NumberAnswer({
  question,
  answer,
  onAnswer,
  labelledBy,
}: {
  question: QuestionBlock;
  answer: Answer | undefined;
  onAnswer: (q: QuestionBlock, a: Answer | null) => Promise<void>;
  labelledBy: string;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(typeof answer === 'number' ? String(answer) : '');
  const value = text.trim() === '' ? null : Number(text.replace(',', '.'));
  const invalid = value !== null && !validAnswer(question, value);
  const { min, max } = question;
  const hint =
    min !== undefined && max !== undefined
      ? t('story.numberRange', { min, max })
      : min !== undefined
        ? t('story.numberMin', { min })
        : max !== undefined
          ? t('story.numberMax', { max })
          : undefined;
  return (
    <>
      <input
        className="story-number-input"
        type="text"
        inputMode="decimal"
        aria-labelledby={labelledBy}
        aria-invalid={invalid}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const raw = e.target.value.trim();
          const n = raw === '' ? null : Number(raw.replace(',', '.'));
          // Only an answer that fits is kept; anything else takes the answer back.
          void onAnswer(question, n !== null && validAnswer(question, n) ? n : null);
        }}
      />
      {(hint || invalid) && <p className={invalid ? 'story-invalid' : 'meta'}>{invalid ? t('story.numberInvalid') + (hint ? ` ${hint}.` : '') : hint}</p>}
    </>
  );
}
