/**
 * The story player: a story's slides one at a time, with progress segments, Back and Next (and
 * the arrow keys), and the way on to the donation at the end. Participants play their own story
 * with it; the studio plays a story on a test package.
 */
import { localize, validAnswer, type Answer, type QuestionBlock, type Slide, type Story, type StoryBlock } from '@combray/core';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { StoryView } from '../worker/api';
import { Block } from './StoryBlocks';

interface Props {
  story: Story;
  /** What each data block shows, by block id; blocks without data are missing. */
  views: Record<string, StoryView>;
  answers: Record<string, Answer>;
  /** Keep an answer; `null` takes it back. */
  onAnswer: (questionId: string, answer: Answer | null) => Promise<void>;
  onClose: () => void;
  /** Go on to the donation, offered on the last slide. */
  onDonate?: () => void;
}

/**
 * The blocks a slide shows: data blocks without data are left out, or say so with the block's
 * own sentence for that. A slide whose data blocks all have nothing to show is skipped, with its
 * questions, which are about that data.
 */
function shownBlocks(slide: Slide, views: Record<string, StoryView>): StoryBlock[] | undefined {
  const blocks = slide.blocks.filter((b) => b.type !== 'data' || views[b.id] || b.empty);
  const data = slide.blocks.filter((b) => b.type === 'data');
  if (data.length > 0 && !data.some((b) => views[b.id] || b.empty)) return undefined;
  return blocks;
}

export function StoryPlayer({ story, views, answers: initial, onAnswer, onClose, onDonate }: Props) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? 'en';
  const slides = story.slides.flatMap((slide) => {
    const blocks = shownBlocks(slide, views);
    return blocks ? [{ slide, blocks }] : [];
  });
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, Answer>>(initial);
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

  const save = useCallback(
    async (question: QuestionBlock, answer: Answer | null) => {
      setAnswers((a) => {
        const next = { ...a };
        if (answer === null) delete next[question.id];
        else next[question.id] = answer;
        return next;
      });
      await onAnswer(question.id, answer);
    },
    [onAnswer],
  );

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
              <Block key={block.id} block={block} views={views} answer={answers[block.id]} onAnswer={save} />
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
