import type { TFunction } from 'i18next';

/*
 * Illustrations for the FAQ: keys going into boxes, and the browser throwing keys away. Drawn
 * from a few shared symbols; colours come from the stylesheet (`.faq-*`), labels from
 * locales/{language}/faq.json. The same pictures, in English, are in docs/explainers/.
 */

/** Shared symbols. Render once per page, before any scene. */
export function FaqSymbols() {
  return (
    <svg className="faq-symbols" width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        <marker
          id="faq-ah"
          viewBox="0 0 10 10"
          refX={8}
          refY={5}
          markerWidth={7}
          markerHeight={7}
          orient="auto-start-reverse"
        >
          <path d="M0 0L10 5L0 10z" className="faq-ahead" />
        </marker>
        <pattern id="faq-hatch" patternUnits="userSpaceOnUse" width={6} height={6} patternTransform="rotate(45)">
          <rect width={6} height={6} className="faq-hbg" />
          <line x1={0} y1={0} x2={0} y2={6} className="faq-hline" />
        </pattern>
        <symbol id="faq-key" viewBox="0 0 64 28">
          <path className="faq-ol faq-fc" d="M23 10h37v8h-6v7h-6v-7h-5v5h-6v-5h-14z" />
          <circle className="faq-ol faq-fc" cx={13} cy={14} r={11} />
          <circle className="faq-ol faq-fp" cx={13} cy={14} r={4} />
        </symbol>
        <symbol id="faq-box" viewBox="0 0 60 52">
          <rect className="faq-ol faq-fw" x={4} y={20} width={52} height={29} rx={4} />
          <path className="faq-ol faq-fw2" d="M4 22Q4 6 30 6Q56 6 56 22Z" />
          <path className="faq-ol faq-fn" d="M24 26v-4a6 6 0 0 1 12 0v4" />
          <rect className="faq-ol faq-fc" x={21} y={26} width={18} height={14} rx={3} />
        </symbol>
        <symbol id="faq-boxopen" viewBox="0 0 60 52">
          <rect className="faq-ol faq-fw" x={4} y={20} width={52} height={29} rx={4} />
          <path className="faq-ol faq-fw2" d="M8 20L2 4Q16 -2 30 6L36 20Z" />
          <path className="faq-ol faq-fdark" d="M8 20h44v6H8z" />
        </symbol>
        <symbol id="faq-letterbox" viewBox="0 0 60 52">
          <rect className="faq-ol faq-fc" x={4} y={6} width={52} height={43} rx={6} />
          <rect className="faq-ol faq-fdark" x={14} y={14} width={32} height={5} rx={2.5} />
          <circle className="faq-ol faq-fp" cx={30} cy={33} r={5} />
          <path className="faq-ol" d="M30 36v6" />
        </symbol>
        <symbol id="faq-cards" viewBox="0 0 70 56">
          <rect className="faq-ol faq-fp" x={14} y={2} width={54} height={38} rx={3} transform="rotate(4 41 21)" />
          <rect className="faq-ol faq-fp" x={2} y={14} width={56} height={40} rx={3} />
          <circle className="faq-fmad" cx={15} cy={27} r={6} />
          <path className="faq-ink2" d="M26 25h24M26 33h20M10 43h40" />
        </symbol>
        <symbol id="faq-locked" viewBox="0 0 70 56">
          <rect className="faq-ol faq-fh" x={14} y={2} width={54} height={38} rx={3} transform="rotate(4 41 21)" />
          <rect className="faq-ol faq-fh" x={2} y={14} width={56} height={40} rx={3} />
          <path className="faq-ol faq-fn" d="M24 30v-5a6 6 0 0 1 12 0v5" />
          <rect className="faq-ol faq-fc" x={21} y={30} width={18} height={14} rx={3} />
        </symbol>
        <symbol id="faq-hall" viewBox="0 0 96 96">
          <path className="faq-ol faq-fp" d="M6 34L48 6L90 34Z" />
          <rect className="faq-ol faq-fp" x={10} y={34} width={76} height={8} />
          <rect className="faq-ol faq-fp" x={14} y={42} width={68} height={38} />
          <path className="faq-ol" d="M26 46v30M40 46v30M56 46v30M70 46v30" />
          <rect className="faq-ol faq-fp" x={6} y={80} width={84} height={10} />
          <circle className="faq-ol faq-fmad" cx={48} cy={23} r={5} />
        </symbol>
        <symbol id="faq-laptop" viewBox="0 0 90 70">
          <rect className="faq-ol faq-fp" x={10} y={4} width={70} height={48} rx={4} />
          <path className="faq-ol faq-fw2" d="M2 58h86l-6 8H8z" />
          <path className="faq-ol faq-fn" d="M10 52h70v6H10z" />
        </symbol>
        <symbol id="faq-bin" viewBox="0 0 40 46">
          <path className="faq-ol faq-fw2" d="M6 12h28l-3 31H9z" />
          <path className="faq-ol" d="M2 12h36M15 12V6h10v6M15 19v18M25 19v18" />
        </symbol>
        <symbol id="faq-pw" viewBox="0 0 84 22">
          <rect className="faq-ol faq-fp" x={1} y={1} width={82} height={20} rx={5} />
          <circle className="faq-fdark" cx={14} cy={11} r={3} />
          <circle className="faq-fdark" cx={25} cy={11} r={3} />
          <circle className="faq-fdark" cx={36} cy={11} r={3} />
          <circle className="faq-fdark" cx={47} cy={11} r={3} />
          <circle className="faq-fdark" cx={58} cy={11} r={3} />
        </symbol>
        <symbol id="faq-clock" viewBox="0 0 30 30">
          <circle className="faq-ol faq-fp" cx={15} cy={15} r={12} />
          <path className="faq-ol" d="M15 8v7l5 3" />
        </symbol>
        <symbol id="faq-file" viewBox="0 0 52 62">
          <path className="faq-ol faq-fp" d="M2 2h34l14 14v44H2z" />
          <path className="faq-ol faq-fn" d="M36 2v14h14" />
          <rect className="faq-ol faq-fh" x={9} y={24} width={34} height={18} rx={2} />
          <rect className="faq-ol faq-fw" x={15} y={46} width={22} height={10} rx={2} />
        </symbol>
      </defs>
    </svg>
  );
}

export type SceneName = 'Locked' | 'Unlock' | 'Stop' | 'Share' | 'Withdraw' | 'Package';

/** One illustration. `title` is the text alternative for screen readers. */
export function Scene({ name, title, t }: { name: SceneName; title: string; t: TFunction }) {
  return (
    <svg className="faq-art" viewBox="0 0 400 214" role="img" aria-label={title}>
      {SCENES[name](t)}
    </svg>
  );
}

const SCENES: Record<SceneName, (t: TFunction) => React.JSX.Element> = {
  Locked: (t) => (
    <>
      <g className="frame">
        <rect x={6} y={22} width={250} height={186} rx={10} />
        <line x1={6} y1={40} x2={256} y2={40} />
        <circle cx={18} cy={31} r={2.5} />
        <circle cx={27} cy={31} r={2.5} />
        <circle cx={36} cy={31} r={2.5} />
      </g>
      <text className="lbl" x={10} y={15} textAnchor="start">
        {t('faq.art.computer')}
      </text>
      <use href="#faq-cards" x={22} y={54} width={70} height={56} />
      <path className="arrow" d="M98 82 H128" markerEnd="url(#faq-ah)" />
      <use href="#faq-locked" x={134} y={54} width={70} height={56} style={{ color: 'var(--madeleine)' }} />
      <text className="cap" x={57} y={128} textAnchor="middle">
        {t('faq.art.yourData')}
      </text>
      <text className="cap" x={169} y={128} textAnchor="middle">
        {t('faq.art.locked')}
      </text>
      <use href="#faq-key" x={28} y={150} width={56} height={24} style={{ color: 'var(--madeleine)' }} />
      <path className="arrow" d="M90 162 H128" markerEnd="url(#faq-ah)" />
      <use href="#faq-box" x={134} y={140} width={60} height={52} />
      <text className="cap" x={56} y={192} textAnchor="middle">
        {t('faq.art.dataKey')}
      </text>
      <use href="#faq-hall" x={292} y={44} width={96} height={96} />
      <text className="lbl" x={340.0} y={34} textAnchor="middle">
        {t('faq.art.server')}
      </text>
      <use href="#faq-key" x={308} y={156} width={64} height={28} style={{ color: 'var(--dusk)' }} />
      <path className="arrow dashed" d="M200 168 C240 176, 270 176, 302 170" />
      <text className="cap" x={340} y={202} textAnchor="middle">
        {t('faq.art.keyToBox')}
      </text>
    </>
  ),
  Unlock: (t) => (
    <>
      <g className="frame">
        <rect x={6} y={22} width={250} height={186} rx={10} />
        <line x1={6} y1={40} x2={256} y2={40} />
        <circle cx={18} cy={31} r={2.5} />
        <circle cx={27} cy={31} r={2.5} />
        <circle cx={36} cy={31} r={2.5} />
      </g>
      <text className="lbl" x={10} y={15} textAnchor="start">
        {t('faq.art.computer')}
      </text>
      <use href="#faq-pw" x={20} y={50} width={84} height={22} />
      <path className="arrow" d="M108 61 C180 26, 250 34, 290 68" markerEnd="url(#faq-ah)" />
      <text className="cap" x={62} y={86} textAnchor="middle">
        {t('faq.art.password')}
      </text>
      <use href="#faq-hall" x={292} y={44} width={96} height={96} />
      <text className="lbl" x={340.0} y={34} textAnchor="middle">
        {t('faq.art.server')}
      </text>
      <path className="arrow" d="M292 118 C262 122, 240 112, 222 104" markerEnd="url(#faq-ah)" />
      <use href="#faq-key" x={162} y={92} width={56} height={24} style={{ color: 'var(--dusk)' }} />
      <path className="arrow" d="M190 120 V138" markerEnd="url(#faq-ah)" />
      <use href="#faq-boxopen" x={168} y={142} width={60} height={52} />
      <path className="arrow" d="M164 172 H152" markerEnd="url(#faq-ah)" />
      <use href="#faq-key" x={98} y={160} width={52} height={22} style={{ color: 'var(--madeleine)' }} />
      <path className="arrow" d="M112 158 L80 136" markerEnd="url(#faq-ah)" />
      <use href="#faq-cards" x={18} y={92} width={64} height={51} />
    </>
  ),
  Stop: (t) => (
    <>
      <g className="frame">
        <rect x={6} y={22} width={250} height={186} rx={10} />
        <line x1={6} y1={40} x2={256} y2={40} />
        <circle cx={18} cy={31} r={2.5} />
        <circle cx={27} cy={31} r={2.5} />
        <circle cx={36} cy={31} r={2.5} />
      </g>
      <text className="lbl" x={10} y={15} textAnchor="start">
        {t('faq.art.computer')}
      </text>
      <use href="#faq-locked" x={22} y={50} width={70} height={56} style={{ color: 'var(--madeleine)' }} />
      <use href="#faq-box" x={28} y={130} width={60} height={52} />
      <text className="cap" x={57} y={202} textAnchor="middle">
        {t('faq.art.stays')}
      </text>
      <use href="#faq-clock" x={112} y={48} width={30} height={30} />
      <text className="cap" x={127} y={92} textAnchor="middle">
        {t('faq.art.minutes')}
      </text>
      <g className="gone">
        <use href="#faq-cards" x={112} y={110} width={54} height={43} />
        <use href="#faq-key" x={166} y={68} width={50} height={21} style={{ color: 'var(--madeleine)' }} />
      </g>
      <path className="arrow" d="M150 156 L186 168" markerEnd="url(#faq-ah)" />
      <path className="arrow" d="M200 94 L204 140" markerEnd="url(#faq-ah)" />
      <use href="#faq-bin" x={184} y={142} width={44} height={50} />
      <use href="#faq-hall" x={292} y={44} width={96} height={96} />
      <text className="lbl" x={340.0} y={34} textAnchor="middle">
        {t('faq.art.server')}
      </text>
      <use href="#faq-key" x={308} y={156} width={64} height={28} style={{ color: 'var(--dusk)' }} />
      <text className="cap" x={340} y={202} textAnchor="middle">
        {t('faq.art.staysServer')}
      </text>
    </>
  ),
  Share: (t) => (
    <>
      <g className="frame">
        <rect x={6} y={22} width={250} height={186} rx={10} />
        <line x1={6} y1={40} x2={256} y2={40} />
        <circle cx={18} cy={31} r={2.5} />
        <circle cx={27} cy={31} r={2.5} />
        <circle cx={36} cy={31} r={2.5} />
      </g>
      <text className="lbl" x={10} y={15} textAnchor="start">
        {t('faq.art.computer')}
      </text>
      <use href="#faq-cards" x={18} y={52} width={70} height={56} />
      <path className="arrow" d="M94 80 H124" markerEnd="url(#faq-ah)" />
      <use href="#faq-locked" x={130} y={58} width={58} height={46} style={{ color: 'var(--tilleul)' }} />
      <text className="cap" x={53} y={126} textAnchor="middle">
        {t('faq.art.youChoose')}
      </text>
      <text className="cap" x={159} y={122} textAnchor="middle">
        {t('faq.art.donation')}
      </text>
      <use href="#faq-key" x={24} y={150} width={54} height={23} style={{ color: 'var(--tilleul)' }} />
      <path className="arrow" d="M84 162 H112" markerEnd="url(#faq-ah)" />
      <use href="#faq-letterbox" x={118} y={138} width={60} height={52} style={{ color: 'var(--terracotta)' }} />
      <text className="cap" x={51} y={192} textAnchor="middle">
        {t('faq.art.donationKey')}
      </text>
      <use href="#faq-hall" x={292} y={44} width={96} height={96} />
      <text className="lbl" x={340.0} y={34} textAnchor="middle">
        {t('faq.art.server')}
      </text>
      <path className="arrow" d="M192 66 C250 20, 372 20, 368 142" markerEnd="url(#faq-ah)" />
      <path className="arrow" d="M182 170 C230 196, 270 190, 294 176" markerEnd="url(#faq-ah)" />
      <use href="#faq-letterbox" x={296} y={150} width={44} height={38} style={{ color: 'var(--terracotta)' }} />
      <use href="#faq-locked" x={346} y={150} width={44} height={36} style={{ color: 'var(--tilleul)' }} />
      <text className="cap" x={343} y={206} textAnchor="middle">
        {t('faq.art.keptApart')}
      </text>
    </>
  ),
  Withdraw: (t) => (
    <>
      <use href="#faq-hall" x={16} y={44} width={96} height={96} />
      <text className="lbl" x={64.0} y={34} textAnchor="middle">
        {t('faq.art.server')}
      </text>
      <g className="gone">
        <use href="#faq-letterbox" x={128} y={70} width={44} height={38} style={{ color: 'var(--terracotta)' }} />
      </g>
      <path className="arrow" d="M100 96 C112 92, 120 90, 126 90" markerEnd="url(#faq-ah)" />
      <path className="arrow" d="M150 112 V140" markerEnd="url(#faq-ah)" />
      <use href="#faq-bin" x={128} y={142} width={44} height={50} />
      <use href="#faq-locked" x={40} y={150} width={44} height={36} style={{ color: 'var(--tilleul)' }} />
      <circle className="ring" cx={62} cy={168} r={30} />
      <use href="#faq-laptop" x={238} y={46} width={132} height={102} />
      <text className="lbl" x={304} y={36} textAnchor="middle">
        {t('faq.art.researcher')}
      </text>
      <use href="#faq-locked" x={282} y={66} width={44} height={36} style={{ color: 'var(--tilleul)' }} />
      <circle className="ring" cx={304} cy={84} r={30} />
      <text className="cap" x={200} y={208} textAnchor="middle">
        {t('faq.art.everyCopy')}
      </text>
    </>
  ),
  Package: (t) => (
    <>
      <g className="frame">
        <rect x={6} y={30} width={150} height={170} rx={10} />
        <line x1={6} y1={48} x2={156} y2={48} />
        <circle cx={18} cy={39} r={2.5} />
        <circle cx={27} cy={39} r={2.5} />
        <circle cx={36} cy={39} r={2.5} />
      </g>
      <text className="lbl" x={10} y={22} textAnchor="start">
        {t('faq.art.computer')}
      </text>
      <use href="#faq-locked" x={28} y={64} width={62} height={50} style={{ color: 'var(--madeleine)' }} />
      <use href="#faq-box" x={40} y={130} width={56} height={48} />
      <path className="arrow" d="M160 112 H176" markerEnd="url(#faq-ah)" />
      <use href="#faq-file" x={180} y={78} width={52} height={62} />
      <path className="arrow" d="M236 112 H250" markerEnd="url(#faq-ah)" />
      <text className="cap" x={206} y={160} textAnchor="middle">
        {t('faq.art.package')}
      </text>
      <g className="frame">
        <rect x={254} y={30} width={140} height={170} rx={10} />
        <line x1={254} y1={48} x2={394} y2={48} />
        <circle cx={266} cy={39} r={2.5} />
        <circle cx={275} cy={39} r={2.5} />
        <circle cx={284} cy={39} r={2.5} />
      </g>
      <text className="lbl" x={258} y={22} textAnchor="start">
        {t('faq.art.otherComputer')}
      </text>
      <use href="#faq-pw" x={270} y={62} width={88} height={22} />
      <use href="#faq-locked" x={268} y={106} width={52} height={42} style={{ color: 'var(--madeleine)' }} />
      <use href="#faq-box" x={328} y={110} width={50} height={43} />
      <text className="cap" x={324} y={188} textAnchor="middle">
        {t('faq.art.withPassword')}
      </text>
    </>
  ),
};
