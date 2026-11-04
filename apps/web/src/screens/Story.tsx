/**
 * The study's story: slides that walk participants through their own data and ask about it
 * (docs/plans/2026-11-05-stories-and-exploration.md). Everything shown is computed on this
 * computer; answers are kept here, encrypted, and only go along with a donation.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { StoryPlayer } from '../components/StoryPlayer';
import type { StoryOverview } from '../worker/api';
import { data } from '../worker/client';

interface Props {
  onClose: () => void;
  /** Go on to the donation, offered on the last slide. */
  onDonate?: () => void;
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
  return (
    <StoryPlayer
      story={overview.story}
      views={overview.views}
      answers={overview.answers}
      onAnswer={(id, answer) => data.answer(id, answer)}
      onClose={onClose}
      {...(onDonate ? { onDonate } : {})}
    />
  );
}
