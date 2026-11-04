/**
 * Previewing a story in the studio: with a test package per platform, read the way a
 * participant's device reads it (in the studio worker; only counts come back), or with made-up
 * numbers. Only test packages whose values the researchers declared fine to keep can be used.
 */
import { localize, parseStory, type Answer, type DataBlock, type Localized, type Slide, type Story } from '@combray/core';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { StoryPlayer } from '../components/StoryPlayer';
import type { StoryView } from '../worker/api';
import type { StoredPackage } from './api';
import { studio } from './client';
import { projectApi } from './projectApi';

/** A platform's files as the draft has them. */
export interface PlatformFiles {
  platform: string;
  name: Localized;
  pack?: string;
  structure?: unknown;
  importer?: unknown;
}

/** Made-up numbers, so researchers see what each view looks like. */
export function sampleView(block: DataBlock): StoryView {
  if (block.view === 'amount') return { view: 'amount', count: 4312, first: '2024-01-01', last: '2024-12-31', days: 366 };
  if (block.view === 'top') {
    const items = [
      'Example one',
      'Example two',
      'Example three',
      'Example four',
      'Example five',
      'Example six',
      'Example seven',
      'Example eight',
      'Example nine',
      'Example ten',
    ];
    return { view: 'top', items: items.slice(0, block.top ?? 5).map((value, i) => ({ value, count: Math.round(240 / (i + 1.4)) })), distinct: 120 };
  }
  if (block.view === 'over-time') {
    return {
      view: 'over-time',
      unit: 'month',
      buckets: Array.from({ length: 12 }, (_, i) => ({
        start: `2024-${String(i + 1).padStart(2, '0')}-01`,
        count: Math.round(300 + 180 * Math.sin(i / 2) + (i === 9 ? 260 : 0)),
      })),
    };
  }
  if (block.by === 'weekday') return { view: 'rhythm', by: 'weekday', counts: [52, 48, 50, 55, 70, 96, 88] };
  return {
    view: 'rhythm',
    by: 'hour',
    counts: Array.from({ length: 24 }, (_, h) => Math.round(h < 7 ? 4 : 30 + 40 * Math.sin(((h - 7) / 17) * Math.PI) + (h === 22 ? 40 : 0))),
  };
}

const packageKey = (platform: string, id: string) => `${platform}/${id}`;

export interface StoryPreview {
  /** Test packages with values, per platform. */
  packages: Record<string, StoredPackage[]>;
  /** The package each platform previews with; `''` for made-up numbers. */
  chosen: Record<string, string>;
  choose: (platform: string, id: string) => void;
  /** Loading a package, or working the views out. */
  busy: boolean;
  failed: boolean;
  /** What a data block shows: from the chosen test package, or made up. `undefined`: no data in the package. */
  viewOf: (block: DataBlock) => StoryView | undefined;
}

export function useStoryPreview(projectId: string, platforms: PlatformFiles[], slides: Slide[]): StoryPreview {
  const [packages, setPackages] = useState<Record<string, StoredPackage[]>>({});
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(new Set());
  const [views, setViews] = useState<Record<string, StoryView>>({});
  const [loading, setLoading] = useState(0);
  const [failed, setFailed] = useState(false);

  // The packages with values; the first one of each platform is chosen to start with.
  useEffect(() => {
    for (const p of platforms) {
      void projectApi
        .testPackages(projectId, p.platform)
        .list()
        .then(
          (list) => {
            const usable = list.packages.filter((x) => x.has_data);
            setPackages((all) => ({ ...all, [p.platform]: usable }));
            setChosen((all) => (p.platform in all ? all : { ...all, [p.platform]: usable[0]?.id ?? '' }));
          },
          () => undefined,
        );
    }
  }, [projectId, platforms]);

  // Chosen packages go to the studio worker once.
  useEffect(() => {
    for (const [platform, id] of Object.entries(chosen)) {
      const key = packageKey(platform, id);
      if (!id || loaded.has(key)) continue;
      setLoading((n) => n + 1);
      void projectApi
        .testPackages(projectId, platform)
        .data(id)
        .then((tree) => studio.loadStoryPackage(key, tree))
        .then(
          () => setLoaded((set) => new Set(set).add(key)),
          () => {
            setFailed(true);
            setChosen((all) => ({ ...all, [platform]: '' }));
          },
        )
        .finally(() => setLoading((n) => n - 1));
    }
  }, [projectId, chosen, loaded]);

  const real = useCallback((platform: string) => Boolean(chosen[platform]) && loaded.has(packageKey(platform, chosen[platform]!)), [chosen, loaded]);

  // The views, worked out again a moment after the story or the choice changes.
  const [computing, setComputing] = useState(false);
  useEffect(() => {
    const story = parseStory({ slides });
    const sources = platforms.filter((p) => real(p.platform));
    if (!story || sources.length === 0) {
      setViews({});
      return;
    }
    const timer = setTimeout(() => {
      setComputing(true);
      void studio
        .storyViews(
          story,
          sources.map((p) => ({
            platform: p.platform,
            package: packageKey(p.platform, chosen[p.platform]!),
            ...(p.pack ? { pack: p.pack } : {}),
            ...(p.structure ? { structure: p.structure } : {}),
            ...(p.importer ? { importer: p.importer } : {}),
          })),
        )
        .then(setViews, () => setFailed(true))
        .finally(() => setComputing(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [slides, platforms, chosen, real]);

  // A platform the project does not have has no data, made up or not.
  const viewOf = useCallback(
    (block: DataBlock) => (real(block.platform) ? views[block.id] : platforms.some((p) => p.platform === block.platform) ? sampleView(block) : undefined),
    [real, views, platforms],
  );

  return {
    packages,
    chosen,
    choose: (platform, id) => setChosen((all) => ({ ...all, [platform]: id })),
    busy: loading > 0 || computing,
    failed,
    viewOf,
  };
}

/** The views of every data block of a story that has something to show. */
export function previewViews(story: Story, viewOf: (b: DataBlock) => StoryView | undefined): Record<string, StoryView> {
  const out: Record<string, StoryView> = {};
  for (const slide of story.slides) {
    for (const block of slide.blocks) {
      if (block.type !== 'data') continue;
      const view = viewOf(block);
      if (view) out[block.id] = view;
    }
  }
  return out;
}

/** Choose what to preview with, per platform, and play the whole story. */
export function PreviewBar({ preview, platforms, onPlay }: { preview: StoryPreview; platforms: PlatformFiles[]; onPlay?: () => void }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  return (
    <section className="card story-preview-bar" aria-labelledby="story-preview-title">
      <h3 id="story-preview-title">{t('studio.story.previewWith')}</h3>
      <p className="meta">{t('studio.story.previewWithHelp')}</p>
      <div className="field-row">
        {platforms.map((p) => (
          <label key={p.platform} className="field">
            {localize(p.name, 'en') || p.platform}
            <select value={preview.chosen[p.platform] ?? ''} onChange={(e) => preview.choose(p.platform, e.target.value)}>
              <option value="">{t('studio.story.madeUp')}</option>
              {(preview.packages[p.platform] ?? []).map((pkg) => (
                <option key={pkg.id} value={pkg.id}>
                  {pkg.name}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <p className="story-preview-actions">
        {onPlay && (
          <button type="button" className="button" onClick={onPlay}>
            {t('studio.story.play')}
          </button>
        )}
        <span className="meta" role="status">
          {preview.busy ? t('studio.story.previewBusy') : preview.failed ? t('studio.story.previewFailed') : ''}
        </span>
      </p>
    </section>
  );
}

const NO_ANSWERS: Record<string, Answer> = {};
/** The player keeps answers while it is open; nothing is stored. */
const keepNothing = async () => undefined;

/**
 * The whole story as a participant with the chosen test packages would see it, over the
 * studio.
 */
export function PlayOverlay({ story, views, onClose }: { story: Story; views: Record<string, StoryView>; onClose: () => void }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="story-play-overlay" role="dialog" aria-modal="true" aria-label={t('studio.story.play')}>
      <p className="meta story-play-note">{t('studio.story.playNote')}</p>
      <StoryPlayer story={story} views={views} answers={NO_ANSWERS} onAnswer={keepNothing} onClose={onClose} />
    </div>
  );
}
