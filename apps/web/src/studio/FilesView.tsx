import {
  addFileMatch,
  ambiguousNames,
  anyFolderProblem,
  copyGroupContent,
  excludeFile,
  fileGroups,
  groupKey,
  groupsOf,
  includeAll,
  includeFile,
  namePattern,
  newGroupKey,
  patternText,
  removeFileMatch,
  removeGroup,
  renameGroup,
  sameFileMatch,
  seenFiles,
  setAnyFolder,
  setGroupRequired,
  shapeFiles,
  suggestGroups,
  toName,
  typingName,
  unseenMatches,
  type ConfigNode,
  type FileMatch,
  type FilePath,
  type ProjectConfig,
  type SeenFile,
  type Shape,
} from '@combray/core';
import { useMemo, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { HelpButton } from './Help';
import { Popover } from './Popover';

/**
 * The files step (ADR 0016): the files and folders of the seen packages, as a file browser, and
 * the groups that read them. A group reads files that hold the same content (the English and the
 * Dutch history, the JSON and the HTML export); each group gets one content tree in the next step.
 * It looks like a file system on purpose: it is about where things are, not what is in them.
 */
export function FilesView({
  config,
  seen,
  structures,
  onChange,
  onOpenGroup,
}: {
  config: ProjectConfig;
  /** The structures seen, as one union. */
  seen: Shape | undefined;
  /** Each package's own structure: which files it has. */
  structures: readonly Shape[];
  /** A changed configuration; throws to say why it cannot be done. */
  onChange: (next: ProjectConfig) => void;
  /** Go on to the content of a group. */
  onOpenGroup: (key: string) => void;
}) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const files = useMemo(() => seenFiles(config, seen), [config, seen]);
  const groups = useMemo(() => groupsOf(config), [config]);
  const colours = useMemo(() => new Map(groups.map((g, i) => [groupKey(g), i % GROUP_COLOURS])), [groups]);
  const suggestions = useMemo(() => {
    const out = new Map<string, string>();
    if (seen) for (const s of suggestGroups(config.root, seen)) out.set(s.file.join('/'), s.group);
    return out;
  }, [config, seen]);
  /** In how many packages each file is, by its path. */
  const counts = useMemo(() => {
    const out = new Map<string, number>();
    for (const shape of structures) {
      for (const f of new Set(shapeFiles(shape).map((f) => f.steps.join('/')))) out.set(f, (out.get(f) ?? 0) + 1);
    }
    return out;
  }, [structures]);
  const [onlyRead, setOnlyRead] = useState(false);
  const read = files.filter((f) => f.group !== undefined).length;
  const root = useMemo(() => folderTree(files), [files]);

  return (
    <div className="files-step">
      <p className="meta files-intro">
        {t('studio.files.intro')} <HelpButton topic="file-groups" />
      </p>
      <div className="files-layout">
        <section className="file-browser" aria-label={t('studio.files.browser')}>
          <div className="file-browser-bar">
            <span className="meta">{t('studio.files.counts', { count: files.length, read, groups: groups.length })}</span>
            <label className="check">
              <input type="checkbox" checked={onlyRead} onChange={(e) => setOnlyRead(e.target.checked)} />
              {t('studio.files.onlyRead')}
            </label>
            {groups.length === 0 && seen && files.length > 0 && (
              <button type="button" className="button quiet" onClick={() => onChange(includeAll(seen, config))}>
                {t('studio.files.readAll')}
              </button>
            )}
          </div>
          {files.length === 0 ? (
            <p className="meta">{t('studio.files.none')}</p>
          ) : (
            <ul className="file-tree" role="tree" aria-label={t('studio.files.browser')}>
              <FolderBody
                folder={root}
                depth={0}
                onlyRead={onlyRead}
                config={config}
                colours={colours}
                suggestions={suggestions}
                counts={counts}
                packages={structures.length}
                small={files.length <= SMALL}
                onChange={onChange}
              />
            </ul>
          )}
        </section>
        <section className="file-groups" aria-label={t('studio.files.groupsTitle')}>
          <h3>{t('studio.files.groupsTitle')}</h3>
          {groups.length === 0 ? (
            <p className="meta">{t('studio.files.noGroups')}</p>
          ) : (
            groups.map((g) => (
              <GroupCard
                key={g.id}
                group={g}
                config={config}
                seen={seen}
                files={files}
                structures={structures}
                colour={colours.get(groupKey(g)) ?? 0}
                onChange={onChange}
                onOpen={() => onOpenGroup(groupKey(g))}
              />
            ))
          )}
        </section>
      </div>
    </div>
  );
}

/** Up to this many files, every folder starts open. */
const SMALL = 40;

/** Group colours: the same six as parts that share a name. */
const GROUP_COLOURS = 6;

interface Folder {
  name: string;
  path: string[];
  folders: Folder[];
  files: SeenFile[];
}

/** The seen files as folders, folders first and by name, as file browsers show them. */
function folderTree(files: SeenFile[]): Folder {
  const root: Folder = { name: '', path: [], folders: [], files: [] };
  for (const file of files) {
    let folder = root;
    for (const name of file.steps.slice(0, -1)) {
      let next = folder.folders.find((f) => f.name === name);
      if (!next) folder.folders.push((next = { name, path: [...folder.path, name], folders: [], files: [] }));
      folder = next;
    }
    folder.files.push(file);
  }
  const sort = (folder: Folder) => {
    folder.folders.sort((a, b) => a.name.localeCompare(b.name));
    folder.files.sort((a, b) => (a.steps.at(-1) ?? '').localeCompare(b.steps.at(-1) ?? ''));
    folder.folders.forEach(sort);
  };
  sort(root);
  return root;
}

const filesIn = (folder: Folder): SeenFile[] => [...folder.files, ...folder.folders.flatMap(filesIn)];

interface BrowserProps {
  onlyRead: boolean;
  config: ProjectConfig;
  colours: Map<string, number>;
  suggestions: Map<string, string>;
  counts: Map<string, number>;
  packages: number;
  /** Few files: every folder starts open. */
  small: boolean;
  onChange: (next: ProjectConfig) => void;
}

function FolderBody(props: BrowserProps & { folder: Folder; depth: number }) {
  const { folder, depth, onlyRead } = props;
  return (
    <>
      {folder.folders
        .filter((f) => !onlyRead || filesIn(f).some((x) => x.group !== undefined))
        .map((f) => (
          <FolderRow key={f.name} {...props} folder={f} depth={depth} />
        ))}
      {folder.files
        .filter((f) => !onlyRead || f.group !== undefined)
        .map((f) => (
          <FileRow key={f.steps.join('/')} {...props} file={f} depth={depth} />
        ))}
    </>
  );
}

function FolderRow(props: BrowserProps & { folder: Folder; depth: number }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const { folder, depth } = props;
  const all = filesIn(folder);
  const read = all.filter((f) => f.group !== undefined).length;
  // Open where something is read, and the first level, as a file browser would start; all of it when it is small.
  const [open, setOpen] = useState(props.small || read > 0 || depth < 1);
  return (
    <li role="treeitem" aria-expanded={open} className="file-row-item">
      <div className="file-line folder-line" style={{ paddingLeft: `${depth * 1.25}rem` }}>
        <button
          type="button"
          className="file-toggle"
          aria-label={open ? t('studio.collapse', { name: folder.name }) : t('studio.expand', { name: folder.name })}
          onClick={() => setOpen((o) => !o)}
        >
          <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        </button>
        <FolderIcon open={open} />
        <span className="file-name" onClick={() => setOpen((o) => !o)}>
          {folder.name}
        </span>
        <span className="meta file-meta">{t('studio.files.folderCount', { count: all.length, read })}</span>
      </div>
      {open && (
        <ul role="group">
          <FolderBody {...props} folder={folder} depth={depth + 1} />
        </ul>
      )}
    </li>
  );
}

/** The kind of file by its extension, for its icon. */
function extension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase().slice(0, 4) : '';
}

function FileRow(props: BrowserProps & { file: SeenFile; depth: number }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const { file, depth, config, colours, counts, packages } = props;
  const name = file.steps.at(-1) ?? t('studio.files.upload');
  const key = file.steps.join('/');
  const suggestion = file.group === undefined ? props.suggestions.get(key) : undefined;
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const colour = file.group !== undefined ? colours.get(file.group) : undefined;
  const inPackages = counts.get(key) ?? 0;
  return (
    <li role="treeitem" className={`file-row-item${file.group ? ' is-read' : ''}`}>
      <div className="file-line" style={{ paddingLeft: `${depth * 1.25 + 1.6}rem` }}>
        <FileIcon ext={extension(name)} />
        <span className="file-name" title={file.raw.join('/')}>
          {name}
        </span>
        {packages > 1 && <span className="meta file-meta">{t('studio.files.inPackages', { count: inPackages, total: packages })}</span>}
        <span className="file-actions decision-menu-anchor">
          {suggestion && (
            <button type="button" className="tag hint-tag" onClick={() => props.onChange(includeFile(config, file, suggestion))}>
              {t('studio.files.suggest', { group: suggestion })}
            </button>
          )}
          <button
            ref={button}
            type="button"
            className={file.group ? `group-chip shared-${colour}` : 'button quiet file-include'}
            aria-expanded={open}
            aria-haspopup="dialog"
            aria-label={file.group ? t('studio.files.readByLabel', { name, group: file.group }) : t('studio.files.includeLabel', { name })}
            onClick={() => setOpen((o) => !o)}
          >
            {file.group ?? t('studio.files.include')}
            {file.byName && <span className="chip-note"> {t('studio.files.anyFolderShort')}</span>}
          </button>
          {open && (
            <Popover label={t('studio.files.chooseTitle', { name })} anchor={button} onClose={() => setOpen(false)} className="row-popover file-popover">
              <ChooseGroup {...props} name={name} onDone={() => setOpen(false)} />
            </Popover>
          )}
        </span>
      </div>
    </li>
  );
}

/** Which group reads a file: one of the groups, a new one, or none. */
function ChooseGroup({ file, name, config, colours, onChange, onDone }: BrowserProps & { file: SeenFile; name: string; onDone: () => void }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const [newKey, setNewKey] = useState(() => newGroupKey(config, file));
  const [error, setError] = useState<string>();
  const groups = groupsOf(config);
  const apply = (edit: () => ProjectConfig) => {
    try {
      onChange(edit());
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const create = (event: FormEvent) => {
    event.preventDefault();
    apply(() => includeFile(config, file, toName(newKey)));
  };
  return (
    <div className="choose-group">
      <p className="popover-title">{t('studio.files.chooseTitle', { name })}</p>
      {file.byName ? (
        <p className="meta">{t('studio.files.foundByName', { group: file.group })}</p>
      ) : (
        <>
          {groups.length > 0 && (
            <div className="group-choices" role="group" aria-label={t('studio.files.groupsTitle')}>
              {groups.map((g) => {
                const key = groupKey(g);
                return (
                  <button
                    key={g.id}
                    type="button"
                    className={`group-chip shared-${colours.get(key) ?? 0}`}
                    aria-pressed={file.group === key}
                    onClick={() => apply(() => includeFile(config, file, key))}
                  >
                    {key}
                  </button>
                );
              })}
            </div>
          )}
          <form className="new-group" onSubmit={create}>
            <label className="field">
              <span>{t('studio.files.newGroup')}</span>
              <input value={newKey} onChange={(e) => setNewKey(typingName(e.target.value))} spellCheck={false} />
            </label>
            <button type="submit" className="button quiet">
              {t('studio.files.addGroup')}
            </button>
          </form>
          {file.group !== undefined && (
            <button type="button" className="link-button" onClick={() => apply(() => excludeFile(config, file))}>
              {t('studio.files.exclude')}
            </button>
          )}
        </>
      )}
      {error && (
        <p className="message error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** A group: its name, the files it reads and how, and what can be done with it. */
function GroupCard({
  group,
  config,
  seen,
  files,
  structures,
  colour,
  onChange,
  onOpen,
}: {
  group: ConfigNode;
  config: ProjectConfig;
  seen: Shape | undefined;
  files: SeenFile[];
  structures: readonly Shape[];
  colour: number;
  onChange: (next: ProjectConfig) => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const key = groupKey(group);
  const [renaming, setRenaming] = useState<string>();
  const [pattern, setPattern] = useState('');
  const [copyFrom, setCopyFrom] = useState('');
  const [error, setError] = useState<string>();
  const others = groupsOf(config).filter((g) => groupKey(g) !== key && (g.children?.length ?? 0) > 0);
  const unseen = unseenMatches(config, seen, key);
  const read = files.filter((f) => f.group === key);
  // A name in any folder that some package has in two folders: neither file is read there.
  const twice = useMemo(() => {
    const groups = fileGroups(config.root).filter((g) => g.key === key);
    return new Set(structures.flatMap((s) => ambiguousNames(shapeFiles(s), groups)).map((a) => JSON.stringify(a.match)));
  }, [config, key, structures]);

  const apply = (edit: () => ProjectConfig) => {
    setError(undefined);
    try {
      onChange(edit());
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  const rename = (event: FormEvent) => {
    event.preventDefault();
    if (renaming !== undefined && apply(() => renameGroup(config, key, toName(renaming)))) setRenaming(undefined);
  };

  const addPattern = (event: FormEvent) => {
    event.preventDefault();
    if (pattern.trim() && apply(() => addFileMatch(config, key, { name: namePattern(pattern) }))) setPattern('');
  };

  return (
    <article className={`group-card shared-${colour}`} aria-label={key}>
      <header className="group-card-head">
        {renaming === undefined ? (
          <>
            <span className={`group-chip shared-${colour}`}>{key}</span>
            <button type="button" className="link-button" onClick={() => setRenaming(key)}>
              {t('studio.files.rename')}
              <span className="visually-hidden"> {key}</span>
            </button>
          </>
        ) : (
          <form className="group-rename" onSubmit={rename}>
            <label className="visually-hidden" htmlFor={`rename-${group.id}`}>
              {t('studio.files.renameLabel', { name: key })}
            </label>
            <input id={`rename-${group.id}`} value={renaming} onChange={(e) => setRenaming(typingName(e.target.value))} spellCheck={false} autoFocus />
            <button type="submit" className="button quiet">
              {t('studio.files.renameSave')}
            </button>
            <button type="button" className="link-button" onClick={() => setRenaming(undefined)}>
              {t('studio.files.cancel')}
            </button>
          </form>
        )}
        <button type="button" className="button quiet group-open" onClick={onOpen} disabled={read.length === 0 && (group.children?.length ?? 0) === 0}>
          {t('studio.files.openContents')}
        </button>
      </header>

      <ul className="group-matches">
        {(group.files ?? []).map((match) => (
          <MatchRow
            key={JSON.stringify(match)}
            match={match}
            groupKey={key}
            config={config}
            seen={seen}
            files={files}
            unseen={unseen.some((u) => sameFileMatch(u, match))}
            twice={twice.has(JSON.stringify(match))}
            apply={apply}
          />
        ))}
        {(group.files ?? []).length === 0 && <li className="meta">{t('studio.files.readsNothing')}</li>}
      </ul>

      <details className="group-more">
        <summary>{t('studio.files.settings')}</summary>
        <form className="group-pattern" onSubmit={addPattern}>
          <label className="field">
            <span>{t('studio.files.patternLabel')}</span>
            <input value={pattern} placeholder="message_*.json" onChange={(e) => setPattern(e.target.value)} spellCheck={false} />
          </label>
          <button type="submit" className="button quiet" disabled={!pattern.trim()}>
            {t('studio.files.patternAdd')}
          </button>
        </form>

        <div className="group-settings">
          <label className="check">
            <input type="checkbox" checked={group.required === true} onChange={(e) => apply(() => setGroupRequired(config, key, e.target.checked))} />
            {t('studio.files.required')}
          </label>
          <HelpButton topic="required" />
        </div>

        {others.length > 0 && (
          <form
            className="group-copy"
            onSubmit={(e) => {
              e.preventDefault();
              if (!copyFrom || !window.confirm(t('studio.files.copyConfirm', { from: copyFrom, to: key }))) return;
              if (apply(() => copyGroupContent(config, copyFrom, key))) setCopyFrom('');
            }}
          >
            <label className="field">
              <span>{t('studio.files.copyLabel')}</span>
              <select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
                <option value="">{t('studio.files.copyChoose')}</option>
                {others.map((g) => (
                  <option key={g.id} value={groupKey(g)}>
                    {groupKey(g)}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="button quiet" disabled={!copyFrom}>
              {t('studio.files.copy')}
            </button>
          </form>
        )}

        <p className="group-remove">
          <button
            type="button"
            className="link-button danger"
            onClick={() => window.confirm(t('studio.files.removeConfirm', { name: key })) && apply(() => removeGroup(config, key))}
          >
            {t('studio.files.remove')}
            <span className="visually-hidden"> {key}</span>
          </button>
        </p>
      </details>
      {error && (
        <p className="message error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}

/** One way a group finds files: an exact path (with a switch to any folder), or a name. */
function MatchRow({
  match,
  groupKey: key,
  config,
  seen,
  files,
  unseen,
  twice,
  apply,
}: {
  match: FileMatch;
  groupKey: string;
  config: ProjectConfig;
  seen: Shape | undefined;
  files: SeenFile[];
  unseen: boolean;
  twice: boolean;
  apply: (edit: () => ProjectConfig) => boolean;
}) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const isPath = 'path' in match;
  const text = isPath ? match.path.map(patternText).join(' / ') || t('studio.files.upload') : patternText(match.name);
  // The seen file behind an exact path, or behind a plain name read in any folder.
  const file: FilePath | undefined = isPath
    ? files.find((f) => f.steps.length === match.path.length && f.steps.every((s, i) => s === match.path[i]))
    : typeof match.name === 'string'
      ? files.find((f) => f.group === key && f.byName && f.steps.at(-1) === match.name)
      : undefined;
  const name = isPath ? match.path.at(-1) : match.name;
  const problem = isPath && name !== undefined ? anyFolderProblem(seen, name) : undefined;
  const canToggle = file !== undefined && file.steps.length > 0 && (isPath ? typeof name === 'string' : true);
  return (
    <li className="group-match">
      <FileIcon ext={typeof name === 'string' ? extension(name) : ''} />
      <span className="match-text" title={text}>
        {!isPath && <span className="tag">{typeof match.name === 'string' ? t('studio.files.anyFolder') : t('studio.files.pattern')}</span>} {text}
      </span>
      {unseen && <span className="tag warn-tag">{t('studio.files.notSeen')}</span>}
      {twice && <span className="tag warn-tag">{t('studio.files.foundTwice')}</span>}
      {canToggle && (
        <label className="check any-folder" title={problem ?? t('studio.files.anyFolderHelp')}>
          <input
            type="checkbox"
            checked={!isPath}
            disabled={isPath && problem !== undefined}
            onChange={(e) => apply(() => setAnyFolder(config, key, file!, e.target.checked))}
          />
          {t('studio.files.anyFolderToggle')}
          {isPath && problem && <span className="meta"> ({problem})</span>}
        </label>
      )}
      <button type="button" className="link-button" onClick={() => apply(() => removeFileMatch(config, key, match))}>
        {t('studio.files.removeMatch')}
        <span className="visually-hidden"> {text}</span>
      </button>
    </li>
  );
}

function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg className="file-icon folder-icon" viewBox="0 0 20 16" aria-hidden="true" focusable="false">
      {open ? (
        <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h4.2l1.6 1.6h7.2A1.5 1.5 0 0 1 17 5.1V6H5.2a1.5 1.5 0 0 0-1.4 1L1.6 13.2 1 13Zm3.6 3.9A1 1 0 0 1 5.5 7H19l-2.6 7H1.9Z" />
      ) : (
        <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h4.2l1.6 1.6h9.2A1.5 1.5 0 0 1 19 5.1v7.4a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 1 12.5Z" />
      )}
    </svg>
  );
}

function FileIcon({ ext }: { ext: string }) {
  return (
    <span className="file-icon-wrap" aria-hidden="true">
      <svg className="file-icon doc-icon" viewBox="0 0 16 20" focusable="false">
        <path d="M2.5 1h7L14 5.5v12a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 1 17.5v-15A1.5 1.5 0 0 1 2.5 1Z" />
        <path className="doc-fold" d="M9.5 1v4.5H14" />
      </svg>
      {ext && <span className={`file-ext ext-${ext}`}>{ext}</span>}
    </span>
  );
}
