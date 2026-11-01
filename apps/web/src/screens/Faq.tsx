import { Trans, useTranslation } from 'react-i18next';

import { FaqSymbols, Scene, type SceneName } from '../components/FaqArt';

/**
 * Questions and answers for participants, at `/{project}/faq`. Works with the store locked: it
 * needs no data. Answers about features that are not built yet are written, but stay hidden until
 * the feature ships, so participants never read about something they cannot do.
 */

interface Item {
  id: string;
  art?: SceneName;
  /** A feature that must exist before the answer is shown. */
  needs?: Feature;
}

type Feature = 'donations' | 'package';

/** Features that exist today. Add to this when the donation flow and the package ship. */
const AVAILABLE = new Set<Feature>();

/** Days until withdrawn donation keys are gone from the server's backups (docs/key-design.md). */
const KEY_BACKUP_RETENTION_DAYS = 30;

const ITEMS: Item[] = [
  { id: 'where', art: 'Locked' },
  { id: 'server' },
  { id: 'open', art: 'Unlock' },
  { id: 'stop', art: 'Stop' },
  { id: 'who' },
  { id: 'forgot' },
  { id: 'share', art: 'Share', needs: 'donations' },
  { id: 'withdraw', art: 'Withdraw', needs: 'donations' },
  { id: 'package', art: 'Package', needs: 'package' },
  { id: 'delete' },
];

export function Faq({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const items = ITEMS.filter((item) => !item.needs || AVAILABLE.has(item.needs));
  return (
    <div className="faq">
      <FaqSymbols />
      <button className="link-button" type="button" onClick={onBack}>
        ← {t('faq.back')}
      </button>
      <h1>{t('faq.title')}</h1>
      <p className="muted">{t('faq.intro')}</p>
      {items.map((item) => (
        <details key={item.id} className="faq-item">
          <summary>{t(`faq.items.${item.id}.q`)}</summary>
          <div className="faq-answer">
            {item.art && <Scene name={item.art} title={t(`faq.items.${item.id}.art`)} t={t} />}
            <div>
              {(t(`faq.items.${item.id}.a`, { returnObjects: true }) as string[]).map((_, i) => (
                <p key={i}>
                  <Trans
                    i18nKey={`faq.items.${item.id}.a.${i}`}
                    values={{ days: KEY_BACKUP_RETENTION_DAYS }}
                    components={{ b: <b /> }}
                  />
                </p>
              ))}
            </div>
          </div>
        </details>
      ))}
    </div>
  );
}
