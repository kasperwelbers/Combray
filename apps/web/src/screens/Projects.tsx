import { localize } from '@combray/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { LocalProject } from '../worker/api';
import { data } from '../worker/client';

/** The studies that have data on this computer. Read locally; the server is not asked. */
export function Projects() {
  const { t, i18n } = useTranslation();
  const [projects, setProjects] = useState<LocalProject[]>();

  useEffect(() => {
    void data.localProjects().then(setProjects, () => setProjects([]));
  }, []);

  if (!projects) return null;
  return (
    <>
      <h1>{t('projects.title')}</h1>
      {projects.length === 0 ? (
        <p>{t('projects.empty')}</p>
      ) : (
        <ul className="project-list">
          {projects.map((p) => (
            <li key={p.id} className="card">
              <a href={`/${p.id}/`}>
                <strong>{p.name ? localize(p.name, i18n.language) : p.id}</strong>
              </a>
              {p.participantId && <span className="muted"> · {t('projects.as', { id: p.participantId })}</span>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
