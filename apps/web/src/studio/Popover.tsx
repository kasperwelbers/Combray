import { useEffect, useRef, type ReactNode, type RefObject } from 'react';

import { HelpButton, type HelpTopic } from './Help';

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

/** A title with a "?" to its explanation in the help dialog. */
export function SectionHead({ title, topic }: { title: string; topic?: HelpTopic }) {
  return (
    <div className="section-head">
      <strong>{title}</strong>
      {topic && <HelpButton topic={topic} />}
    </div>
  );
}
