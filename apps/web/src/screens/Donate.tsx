import { localize } from '@combray/core';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { DonationAnswer, DonationOverview, DonationProblem, DonationReceipt, DonationRow, DonationTable, Page } from '../worker/api';
import { data } from '../worker/client';

const PAGE = 50;
const MAX_TEXT = 300;

const short = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s);

interface Props {
  /** The fingerprint of the study's key from the study link, if there was one. */
  keyPin?: string;
  onBack: () => void;
}

/**
 * Sharing data with the researchers: everything the study asks for, from every upload, to look
 * through and leave rows out of, then a consent and the donation, encrypted on this device to
 * the study's key. Earlier donations can be withdrawn here.
 */
export function Donate({ keyPin, onBack }: Props) {
  const { t, i18n } = useTranslation();
  const [overview, setOverview] = useState<DonationOverview | 'unreachable'>();
  const [answers, setAnswers] = useState<DonationAnswer[]>([]);
  const [receipts, setReceipts] = useState<DonationReceipt[]>([]);
  const [sent, setSent] = useState<DonationReceipt>();
  const [problem, setProblem] = useState<DonationProblem>();
  const [busy, setBusy] = useState(false);
  const [agreed, setAgreed] = useState(false);
  /** The study's consent statements ticked, by position. */
  const [ticked, setTicked] = useState<Set<number>>(new Set());
  // Bumped whenever rows are left out or put back, so open tables read their rows again.
  const [version, setVersion] = useState(0);

  const load = useCallback(async () => {
    setOverview(undefined);
    const [o, r, a] = await Promise.all([data.donationOverview(), data.donations(), data.donationAnswers()]);
    setOverview(o);
    setAnswers(a === 'unreachable' ? [] : a);
    setReceipts(r);
    setTicked(new Set());
    setVersion((v) => v + 1);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const changed = (next: DonationOverview) => {
    setOverview(next);
    setVersion((v) => v + 1);
  };

  async function donate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setProblem(undefined);
    try {
      if (!overview || overview === 'unreachable') return;
      // What the participant read and agreed to, in their language, goes with the donation.
      const language = i18n.resolvedLanguage ?? 'en';
      const information = overview.consent?.information && localize(overview.consent.information, language);
      const consent = {
        language,
        ...(information ? { information } : {}),
        statements: [...(overview.consent?.statements ?? []).map((s) => localize(s, language)), t('donate.agree')],
      };
      const result = await data.donate(keyPin, consent);
      if (result.status === 'done') {
        setSent(result.receipt);
        setReceipts(await data.donations());
        setAgreed(false);
        setTicked(new Set());
      } else {
        setProblem(result.status);
        // The study's settings changed: show what would be sent now.
        if (result.status === 'changed') await load();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="donate" aria-labelledby="donate-title">
      <p>
        <button type="button" className="link-button" onClick={onBack}>
          {t('donate.back')}
        </button>
      </p>
      <h1 id="donate-title">{t('donate.title')}</h1>

      {sent ? (
        <Receipt receipt={sent} onDone={onBack} />
      ) : overview === undefined ? (
        <p className="meta" role="status">
          {t('donate.loading')}
        </p>
      ) : overview === 'unreachable' ? (
        <p className="message error">{t('donate.unreachable')}</p>
      ) : overview.tables.length === 0 && answers.length === 0 ? (
        <p>{t('donate.nothingAsked')}</p>
      ) : (
        <>
          <p>{t('donate.intro')}</p>
          {overview.tables.length > 0 && <LeaveOutSearch onChanged={changed} />}
          {overview.tables.length > 0 && (
            <p className="meta" role="status">
              {t('donate.summary', { count: overview.rows - overview.leftOut })}
              {overview.leftOut > 0 && (
                <>
                  {' · '}
                  {t('donate.leftOutCount', { count: overview.leftOut })}{' '}
                  <button type="button" className="link-button" onClick={async () => changed(await data.putBackAll())}>
                    {t('donate.putBackAll')}
                  </button>
                </>
              )}
            </p>
          )}
          {overview.rules.length > 0 && (
            <ul className="left-out-rules" aria-label={t('donate.rulesTitle')}>
              {overview.rules.map((rule, i) => (
                <li key={`${rule.table ?? ''}\u0000${rule.text}`}>
                  {rule.tableName !== undefined
                    ? t('donate.ruleInTable', { text: rule.text, table: localize(rule.tableName, i18n.language) || t('donate.unnamedTable'), count: rule.count })
                    : t('donate.rule', { text: rule.text, count: rule.count })}{' '}
                  <button type="button" className="link-button" onClick={async () => changed(await data.removeRule(i))}>
                    {t('donate.putBack')}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="donate-tables">
            {overview.tables.map((table) => (
              <DonateTable key={table.id} table={table} parent={overview.tables.find((p) => p.id === table.parent)} version={version} onChanged={changed} />
            ))}
          </div>
          {answers.length > 0 && (
            <Answers
              answers={answers}
              onRemove={async (id) => {
                await data.answer(id, null);
                setAnswers((list) => list.filter((a) => a.id !== id));
              }}
            />
          )}

          <form className="card consent" onSubmit={donate}>
            <h2>{t('donate.consentTitle')}</h2>
            {overview.consent?.information && <Information text={localize(overview.consent.information, i18n.language)} />}
            <p>{t('donate.consentText')}</p>
            {(overview.consent?.statements ?? []).map((statement, i) => (
              <label key={i} className="check">
                <input
                  type="checkbox"
                  checked={ticked.has(i)}
                  onChange={(e) =>
                    setTicked((set) => {
                      const next = new Set(set);
                      if (e.target.checked) next.add(i);
                      else next.delete(i);
                      return next;
                    })
                  }
                />
                {localize(statement, i18n.language)}
              </label>
            ))}
            <label className="check">
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
              {t('donate.agree')}
            </label>
            {problem && <p className="message error">{t(`donate.problem.${problem}`)}</p>}
            <p>
              <button
                type="submit"
                className="button"
                disabled={
                  !agreed || ticked.size < (overview.consent?.statements?.length ?? 0) || busy || (overview.rows === overview.leftOut && answers.length === 0)
                }
              >
                {busy ? t('donate.sending') : t('donate.send')}
              </button>
            </p>
          </form>
        </>
      )}

      {receipts.length > 0 && <Receipts receipts={receipts} onChanged={async () => setReceipts(await data.donations())} />}
    </section>
  );
}

/** The participant's answers to the story's questions: shared with the data, or taken back. */
function Answers({ answers, onRemove }: { answers: DonationAnswer[]; onRemove: (id: string) => Promise<void> }) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? 'en';
  return (
    <section className="card donate-answers" aria-labelledby="donate-answers-title">
      <h2 id="donate-answers-title">{t('donate.answersTitle')}</h2>
      <p>{t('donate.answersIntro')}</p>
      <dl>
        {answers.map((a) => (
          <div key={a.id} className="donate-answer">
            <dt>{localize(a.prompt, language)}</dt>
            <dd>
              <span>{a.option ? localize(a.option, language) : typeof a.answer === 'number' ? a.answer.toLocaleString(language) : short(a.answer)}</span>
              <button type="button" className="link-button" onClick={() => void onRemove(a.id)}>
                {t('donate.removeAnswer')}
              </button>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** The study's information: plain text, an empty line between paragraphs. Never HTML. */
function Information({ text }: { text: string }) {
  const { t } = useTranslation();
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  return (
    <section className="study-information" aria-label={t('donate.information')}>
      {paragraphs.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </section>
  );
}

/** Leave out every row, in all tables, that contains a word. */
function LeaveOutSearch({ onChanged }: { onChanged: (o: DonationOverview) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [done, setDone] = useState<{ text: string; count: number }>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const query = text.trim();
    if (!query) return;
    const { count, overview } = await data.leaveOutMatching(undefined, query);
    onChanged(overview);
    setDone({ text: query, count });
    setText('');
  }

  return (
    <form className="leave-out" onSubmit={submit}>
      <label htmlFor="leave-out-text">{t('donate.leaveOutLabel')}</label>
      <div className="leave-out-row">
        <input id="leave-out-text" type="search" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />
        <button type="submit" className="button quiet" disabled={!text.trim()}>
          {t('donate.leaveOutButton')}
        </button>
      </div>
      <p className="meta" role="status">
        {done && t('donate.leftOutMatching', { count: done.count, text: done.text })}
      </p>
    </form>
  );
}

/** One table of the donation, closed until opened, with a way to leave rows out. */
function DonateTable({
  table,
  parent,
  version,
  onChanged,
}: {
  table: DonationTable;
  parent?: DonationTable;
  version: number;
  onChanged: (o: DonationOverview) => void;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [page, setPage] = useState<Page<DonationRow>>();
  const name = localize(table.name, i18n.language) || t('donate.unnamedTable');

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void data.donationRows(table.id, query, 0, limit).then((p) => {
      if (!cancelled) setPage(p);
    });
    return () => {
      cancelled = true;
    };
  }, [open, table.id, query, limit, version]);

  const kept = table.rowCount - table.leftOut;
  return (
    <details className="card donate-table" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>
        <strong>{name}</strong>{' '}
        <span className="meta">
          {t('donate.rows', { count: kept })}
          {table.leftOut > 0 && ` · ${t('donate.leftOutCount', { count: table.leftOut })}`}
        </span>
      </summary>
      {parent && (
        <p className="meta">
          {t('donate.nested', {
            name: localize(parent.name, i18n.language) || t('donate.unnamedTable'),
          })}
        </p>
      )}
      {open && (
        <>
          <p className="search">
            <label>
              <span className="visually-hidden">{t('donate.searchTable', { name })}</span>
              <input
                type="search"
                placeholder={t('donate.searchTable', { name })}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setLimit(PAGE);
                }}
              />
            </label>
            {query.trim() && page && page.total > 0 && (
              <button
                type="button"
                className="button quiet"
                onClick={async () => {
                  onChanged((await data.leaveOutMatching(table.id, query)).overview);
                  setQuery('');
                }}
              >
                {t('donate.leaveOutAllFound', { count: page.total })}
              </button>
            )}
          </p>
          {page && (
            <>
              <div className="preview-scroll">
                <table className="preview-table">
                  <thead>
                    <tr>
                      {table.fields.map((f) => (
                        <th key={f.id} scope="col">
                          {localize(f.name, i18n.language) || f.id}
                        </th>
                      ))}
                      <th scope="col">
                        <span className="visually-hidden">{t('donate.inDonation')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((row) => {
                      const out = row.leftOut || row.withParent;
                      return (
                        <tr key={row.key} className={out ? 'left-out' : undefined}>
                          {table.fields.map((f) => (
                            <td key={f.id}>{short((row.cells[f.id] ?? []).join(', '))}</td>
                          ))}
                          <td>
                            {row.withParent ? (
                              <span className="meta">{t('donate.outWithParent')}</span>
                            ) : row.byText ? (
                              <span className="meta">{t('donate.outByText')}</span>
                            ) : (
                              <button
                                type="button"
                                className="link-button"
                                aria-pressed={row.leftOut}
                                onClick={async () => onChanged(await data.leaveOut([row.key], !row.leftOut))}
                              >
                                {row.leftOut ? t('donate.putBack') : t('donate.leaveOut')}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="meta">
                {t('donate.shown', {
                  shown: page.items.length,
                  count: page.total,
                })}{' '}
                {page.total > page.items.length && (
                  <button type="button" className="link-button" onClick={() => setLimit((l) => l + PAGE)}>
                    {t('donate.more')}
                  </button>
                )}
              </p>
            </>
          )}
        </>
      )}
    </details>
  );
}

/** Thanks, and the code that withdraws the donation. */
function Receipt({ receipt, onDone }: { receipt: DonationReceipt; onDone: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="card receipt" role="status">
      <h2>{t('donate.thanks')}</h2>
      <p>{t('donate.receiptText')}</p>
      <p className="receipt-code">
        <code>{receipt.code}</code>
      </p>
      <p className="meta">{t('donate.receiptKeep')}</p>
      <p>
        <button type="button" className="button" onClick={onDone}>
          {t('donate.backHome')}
        </button>
      </p>
    </div>
  );
}

/** Donations sent from this device, each with a way to withdraw it. */
function Receipts({ receipts, onChanged }: { receipts: DonationReceipt[]; onChanged: () => Promise<void> }) {
  const { t, i18n } = useTranslation();
  const [failed, setFailed] = useState<string>();
  const date = (iso: string) =>
    new Date(iso).toLocaleString(i18n.language, {
      dateStyle: 'long',
      timeStyle: 'short',
    });

  async function withdraw(r: DonationReceipt) {
    if (!window.confirm(t('donate.confirmWithdraw'))) return;
    setFailed(undefined);
    const result = await data.withdraw(r.id);
    if (result !== 'done') setFailed(t(`donate.withdraw.${result}`));
    await onChanged();
  }

  return (
    <section className="receipts" aria-labelledby="receipts-title">
      <h2 id="receipts-title">{t('donate.earlier')}</h2>
      {failed && <p className="message error">{failed}</p>}
      <ul className="datasets">
        {receipts.map((r) => (
          <li key={r.id} className="card">
            <div className="dataset">
              <div>
                <strong>{t('donate.sentOn', { date: date(r.sent) })}</strong>
                <div className="meta">
                  {r.tables
                    .map((n) => localize(n, i18n.language))
                    .filter(Boolean)
                    .join(', ')}{' '}
                  · {t('donate.rows', { count: r.rows })}
                </div>
                <div className="meta">
                  {t('donate.code')} <code>{r.code}</code>
                </div>
              </div>
              {r.withdrawn ? (
                <span className="meta">{t('donate.withdrawnOn', { date: date(r.withdrawn) })}</span>
              ) : (
                <button type="button" className="button danger" onClick={() => void withdraw(r)}>
                  {t('donate.withdrawButton')}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
