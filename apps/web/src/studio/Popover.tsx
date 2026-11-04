import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * A small panel that opens below what it belongs to and scrolls with it. Escape or a click
 * outside closes it; focus moves into it when it opens and back when it closes. Clicks on
 * `anchor` (the button that opens it) are left to that button, so it can toggle.
 */
export function Popover({
  label,
  onClose,
  anchor,
  className,
  children,
}: {
  label: string;
  onClose: () => void;
  anchor?: RefObject<HTMLElement | null>;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const panel = ref.current;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close.current();
    };
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panel?.contains(target) || anchor?.current?.contains(target)) return;
      close.current();
    };
    panel?.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      panel?.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
      // Give focus back only if it was in here: a click elsewhere keeps its own focus.
      const active = document.activeElement;
      if (before && (active === document.body || active === null || panel?.contains(active))) {
        before.focus({ preventScroll: true });
      }
    };
  }, [anchor]);

  return (
    <div ref={ref} role="dialog" aria-label={label} tabIndex={-1} className={`popover${className ? ` ${className}` : ''}`}>
      {children}
    </div>
  );
}

/** A small "?" that shows an explanation underneath when pressed. */
export function Help({ topic, children }: { topic: string; children: ReactNode }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      <button
        type="button"
        className="help-button"
        aria-expanded={open}
        aria-controls={id}
        title={t('studio.help', { topic })}
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true">?</span>
        <span className="visually-hidden">{t('studio.help', { topic })}</span>
      </button>
      <span id={id} className="help-text" hidden={!open}>
        {children}
      </span>
    </>
  );
}

/** A title with its explanation behind a "?". */
export function SectionHead({ title, help }: { title: string; help?: ReactNode }) {
  return (
    <div className="section-head">
      <strong>{title}</strong>
      {help && <Help topic={title}>{help}</Help>}
    </div>
  );
}
