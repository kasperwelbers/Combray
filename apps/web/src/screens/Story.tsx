/**
 * The study's story: slides that walk participants through their own data and ask about it
 * (docs/plans/2026-11-05-stories-and-exploration.md). Everything shown is computed on this
 * computer; answers are kept here, encrypted, and only go along with a donation.
 */
import { fillText, localize, optionValue, validAnswer, type Answer, type QuestionBlock, type Slide, type StoryBlock } from '@combray/core';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { StoryViewChart, storyValues } from '../components/StoryViews';
import type { StoryOverview } from '../worker/api';
import { data } from '../worker/client';

interface Props {
  onClose: () => void;
  /** Go on to the donation, offered on the last slide. */
  onDonate?: () => void;
}

/**
 * The blocks a slide shows: data blocks without data are left out, or say so with the block's
 * own sentence for that. A slide whose data blocks all have nothing to show is skipped, with its
 * questions, which are about that data.
 */
function shownBlocks(slide: Slide, overview: StoryOverview): StoryBlock[] | undefined {
  const blocks = slide.blocks.filter((b) => b.type !== 'data' || overview.views[b.id] || b.empty);
  const data = slide.blocks.filter((b) => b.type === 'data');
  if (data.length > 0 && !data.some((b) => overview.views[b.id] || b.empty)) return undefined;
  return blocks;
}

export function Story({ onClose, onDonate }: Props) {
  const { t } = useTranslation();
  const [overview, setOverview] = useState<StoryOverview | 'none' | 'unreachable'>();

  useEffect(() => {
    void data.story().then(setOverview);
  }, []);

  if (!overview) return <p className="meta">{t('story.loading')}</p>;
  if (overview === 'unreachable' || overview === 'none') {
    return (
      <section className="story-message">
        <p>{t(`story.${overview}`)}</p>
        <button type="button" className="button" onClick={onClose}>
          {t('story.close')}
        </button>
      </section>
    );
  }
  return <Player overview={overview} onClose={onClose} {...(onDonate ? { onDonate } : {})} />;
}

function Player({ overview, onClose, onDonate }: { overview: StoryOverview } & Props) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? 'en';
  const slides = overview.story.slides.flatMap((slide) => {
    const blocks = shownBlocks(slide, overview);
    return blocks ? [{ slide, blocks }] : [];
  });
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, Answer>>(overview.answers);
  const heading = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);
  const total = slides.length + 1; // and the last one, to close
  const atEnd = index >= slides.length;
  const current = slides[index];

  const unanswered = current?.blocks.some((b) => b.type === 'question' && b.required && !validAnswer(b, answers[b.id])) ?? false;

  const go = useCallback(
    (to: number) => {
      moved.current = true;
      setIndex(Math.max(0, Math.min(total - 1, to)));
    },
    [total],
  );

  // A new slide is announced and read from its heading.
  useEffect(() => {
    if (moved.current) heading.current?.focus();
  }, [index]);

  const save = useCallback(async (question: QuestionBlock, answer: Answer | null) => {
    setAnswers((a) => {
      const next = { ...a };
      if (answer === null) delete next[question.id];
      else next[question.id] = answer;
      return next;
    });
    await data.answer(question.id, answer);
  }, []);

  function onKey(e: KeyboardEvent<HTMLElement>) {
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select')) return;
    if (e.key === 'ArrowRight' && !unanswered) go(index + 1);
    if (e.key === 'ArrowLeft') go(index - 1);
  }

  if (slides.length === 0) {
    return (
      <section className="story-message">
        <p>{t('story.nothingYet')}</p>
        <button type="button" className="button" onClick={onClose}>
          {t('story.close')}
        </button>
      </section>
    );
  }

  const title = current?.slide.title ? localize(current.slide.title, language) : undefined;

  return (
    <section className="story" aria-roledescription="slides" onKeyDown={onKey}>
      <div className="story-top-bar-row">
        <ol className="story-progress">
          {Array.from({ length: total }, (_, i) => (
            <li key={i}>
              <button
                type="button"
                className={i < index ? 'seen' : i === index ? 'current' : undefined}
                aria-current={i === index ? 'step' : undefined}
                aria-label={t('story.slideOf', { n: i + 1, total })}
                // Slides with an unanswered required question cannot be skipped.
                disabled={i > index && unanswered}
                onClick={() => go(i)}
              />
            </li>
          ))}
        </ol>
        <button type="button" className="button quiet story-close" onClick={onClose}>
          {t('story.close')}
        </button>
      </div>

      <article className="story-slide" key={index} aria-label={t('story.slideOf', { n: index + 1, total })}>
        {atEnd ? (
          <>
            <h2 ref={heading} tabIndex={-1}>
              {t('story.endTitle')}
            </h2>
            <p className="story-text">{t('story.endText')}</p>
            <div className="story-end-actions">
              {onDonate && (
                <button type="button" className="button" onClick={onDonate}>
                  {t('donate.openButton')}
                </button>
              )}
              <button type="button" className={onDonate ? 'button quiet' : 'button'} onClick={onClose}>
                {t('story.done')}
              </button>
            </div>
          </>
        ) : (
          <>
            {title ? (
              <h2 ref={heading} tabIndex={-1}>
                {title}
              </h2>
            ) : (
              <h2 ref={heading} tabIndex={-1} className="visually-hidden">
                {t('story.slideOf', { n: index + 1, total })}
              </h2>
            )}
            {current!.blocks.map((block) => (
              <Block key={block.id} block={block} overview={overview} answer={answers[block.id]} onAnswer={save} />
            ))}
          </>
        )}
      </article>

      <nav className="story-nav" aria-label={t('story.slideOf', { n: index + 1, total })}>
        <button type="button" className="button quiet" onClick={() => go(index - 1)} disabled={index === 0}>
          ← {t('story.back')}
        </button>
        {!atEnd && (
          <button type="button" className="button" onClick={() => go(index + 1)} disabled={unanswered}>
            {t('story.next')} →
          </button>
        )}
      </nav>
      {index === 0 && <p className="meta story-hint">{t('story.keys')}</p>}
    </section>
  );
}

function Block({
  block,
  overview,
  answer,
  onAnswer,
}: {
  block: StoryBlock;
  overview: StoryOverview;
  answer: Answer | undefined;
  onAnswer: (q: QuestionBlock, a: Answer | null) => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? 'en';
  if (block.type === 'text') return <Paragraphs text={localize(block.text, language)} />;
  if (block.type === 'question') return <Question question={block} answer={answer} onAnswer={onAnswer} />;
  const view = overview.views[block.id];
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
