/**
 * One place for help in the studio: a dialog with every explanation, so the screens stay quiet.
 * A "?" next to a setting opens it at that setting's explanation.
 */
import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/** The explanations, in order, by group. Their texts are `studio.helpTopics.topics.{id}`. */
export const HELP_GROUPS = {
  basics: ['seen-data', 'extractor', 'names', 'decisions', 'same-name'],
  matching: ['matches', 'required', 'skip-new', 'keys-are-data'],
  reading: ['read-as', 'clean', 'filter-rows', 'header-row'],
  packages: ['test-packages', 'keep-values'],
  platform: ['undecided-shown', 'find'],
  notes: ['conflict', 'name-mismatch'],
} as const;

export type HelpTopic = (typeof HELP_GROUPS)[keyof typeof HELP_GROUPS][number];

const HelpContext = createContext<(topic?: HelpTopic) => void>(() => undefined);

/** Open the help dialog, at one topic or at the start. */
export const useHelp = () => useContext(HelpContext);

/** Gives the screens inside it the help dialog. */
export function HelpProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<{ topic?: HelpTopic }>();
  const show = useCallback((topic?: HelpTopic) => setOpen(topic ? { topic } : {}), []);
  return (
    <HelpContext.Provider value={show}>
      {children}
      {open && <HelpDialog {...(open.topic ? { topic: open.topic } : {})} onClose={() => setOpen(undefined)} />}
    </HelpContext.Provider>
  );
}

/** A "?" that opens the help at a topic. */
export function HelpButton({ topic }: { topic: HelpTopic }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const help = useHelp();
  const label = t('studio.helpTopics.about', { topic: t(`studio.helpTopics.topics.${topic}.title`) });
  return (
    <button type="button" className="help-button" title={label} aria-label={label} onClick={() => help(topic)}>
      <span aria-hidden="true">?</span>
    </button>
  );
}

/** A button that opens the help at the start. */
export function HelpLink() {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const help = useHelp();
  return (
    <button type="button" className="button quiet help-link" onClick={() => help()}>
      <span aria-hidden="true">? </span>
      {t('studio.helpTopics.open')}
    </button>
  );
}

/** Text with **bold** terms, as React text: help texts are ours, but never HTML. */
function Rich({ text }: { text: string }) {
  return <>{text.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 === 1 ? <strong key={i}>{part}</strong> : <Fragment key={i}>{part}</Fragment>))}</>;
}

function HelpDialog({ topic, onClose }: { topic?: HelpTopic; onClose: () => void }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const panel = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState<HelpTopic | undefined>(topic);
  const groups = useMemo(() => Object.entries(HELP_GROUPS) as [keyof typeof HELP_GROUPS, readonly HelpTopic[]][], []);

  // Focus moves in, Escape closes, and focus goes back to where it was.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      before?.focus({ preventScroll: true });
    };
  }, [onClose]);

  // Open at the topic asked for.
  useEffect(() => {
    if (!current) return;
    const article = body.current?.querySelector(`[data-topic="${current}"]`);
    article?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [current]);

  return (
    <div className="help-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} className="help-dialog" role="dialog" aria-modal="true" aria-labelledby="help-title" tabIndex={-1}>
        <div className="help-head">
          <h2 id="help-title">{t('studio.helpTopics.title')}</h2>
          <button type="button" className="close-button" onClick={onClose}>
            <span aria-hidden="true">×</span>
            <span className="visually-hidden">{t('studio.helpTopics.close')}</span>
          </button>
        </div>
        <div className="help-columns">
          <nav className="help-contents" aria-label={t('studio.helpTopics.contents')}>
            {groups.map(([group, topics]) => (
              <Fragment key={group}>
                <p className="help-group">{t(`studio.helpTopics.groups.${group}`)}</p>
                <ul>
                  {topics.map((id) => (
                    <li key={id}>
                      <button type="button" className="link-button" aria-current={id === current ? 'true' : undefined} onClick={() => setCurrent(id)}>
                        {t(`studio.helpTopics.topics.${id}.title`)}
                      </button>
                    </li>
                  ))}
                </ul>
              </Fragment>
            ))}
          </nav>
          <div ref={body} className="help-body">
            {groups.map(([group, topics]) => (
              <section key={group} aria-label={t(`studio.helpTopics.groups.${group}`)}>
                <p className="help-group">{t(`studio.helpTopics.groups.${group}`)}</p>
                {topics.map((id) => (
                  <article key={id} data-topic={id} className={id === current ? 'current' : undefined}>
                    <h3>{t(`studio.helpTopics.topics.${id}.title`)}</h3>
                    {t(`studio.helpTopics.topics.${id}.body`)
                      .split('\n\n')
                      .map((paragraph, i) => (
                        <p key={i}>
                          <Rich text={paragraph} />
                        </p>
                      ))}
                  </article>
                ))}
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
