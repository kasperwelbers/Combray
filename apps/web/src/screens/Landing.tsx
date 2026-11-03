import { useTranslation } from 'react-i18next';

import { Madeleine } from '../components/Madeleine';
import { STUDIES_PATH, studioPath } from '../route';

/**
 * The landing page at `/`: what Combray is, and the way in for participants and for researchers.
 * Static: it reads nothing from this computer and asks the server nothing.
 */
export function Landing() {
  const { t } = useTranslation();
  return (
    <div className="landing">
      <header className="landing-intro">
        <Madeleine size={72} className="madeleine" />
        <h1>{t('app.tagline')}</h1>
        <p className="lead">{t('landing.lead')}</p>
        <ul className="landing-steps">
          <li>{t('landing.explore')}</li>
          <li>{t('landing.reflect')}</li>
          <li>{t('landing.share')}</li>
        </ul>
        <p className="muted">{t('landing.private')}</p>
      </header>
      <div className="landing-ways">
        <section className="card" aria-labelledby="landing-participants">
          <h2 id="landing-participants">{t('landing.participantTitle')}</h2>
          <p>{t('landing.participantText')}</p>
          <a className="button" href={STUDIES_PATH}>
            {t('landing.participantLink')}
          </a>
        </section>
        <section className="card" aria-labelledby="landing-researchers">
          <h2 id="landing-researchers">{t('landing.researcherTitle')}</h2>
          <p>{t('landing.researcherText')}</p>
          <a className="button quiet" href={studioPath()}>
            {t('landing.researcherLink')}
          </a>
        </section>
      </div>
    </div>
  );
}
