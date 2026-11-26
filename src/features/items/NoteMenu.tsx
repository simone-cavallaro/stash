import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export function noteLabel(text: string) {
  const line = text.trim().split('\n')[0];
  return line.length > 64 ? `${line.slice(0, 64)}…` : line || 'Nota';
}

export function focusAfterRemoval(section: HTMLElement | null, id: string) {
  const triggers = [...(section?.querySelectorAll<HTMLButtonElement>('[data-note-action]') ?? [])];
  const index = triggers.findIndex((button) => button.dataset.noteAction === id);
  if (index < 0) return;
  const trigger = triggers[index];
  const adjacent = triggers[index + 1] ?? triggers[index - 1];
  requestAnimationFrame(() => {
    if (!section?.isConnected || trigger.isConnected || document.activeElement !== document.body) return;
    (adjacent?.isConnected ? adjacent : section.querySelector<HTMLElement>('[data-list-heading]'))?.focus();
  });
}

export type NoteAction = { key: string; label: ReactNode; run: () => void; disabled?: boolean; danger?: boolean };

export function NoteMenu({ id, label, open, onToggle, actions }: {
  id: string; label: string; open: boolean; onToggle: (id: string | null) => void; actions: NoteAction[];
}) {
  const panelId = useId();
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState({ above: false, height: 280 });

  useLayoutEffect(() => {
    if (!open) return;
    const button = trigger.current!;
    const bounds = button.getBoundingClientRect();
    const viewport = window.visualViewport;
    const top = viewport?.offsetTop ?? 0;
    const below = top + (viewport?.height ?? window.innerHeight) - bounds.bottom - 12;
    const above = bounds.top - top - 12;
    setPlacement({ above: below < 280 && above > below, height: Math.max(44, below < 280 && above > below ? above : below) });
    const first = panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
    first?.focus({ preventScroll: true });

    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !wrapper.current?.contains(event.target)) onToggle(null);
    }
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open, onToggle]);

  function closeAndFocus() {
    onToggle(null);
    trigger.current?.focus();
  }

  return <div className="note-menu" ref={wrapper} onBlur={(event) => {
    if (open && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) onToggle(null);
  }} onKeyDown={(event) => {
    if (open && event.key === 'Escape') {
      event.stopPropagation();
      closeAndFocus();
    }
  }}>
    <button className="icon-button note-menu-trigger" type="button" ref={trigger} data-note-action={id}
      aria-label={`Azioni della nota: ${label}`} aria-expanded={open} aria-controls={panelId}
      onClick={() => onToggle(open ? null : id)}><span aria-hidden="true">⋯</span></button>
    <div id={panelId} className="note-menu-panel" data-note-menu={open ? '' : undefined} hidden={!open}
      data-above={placement.above ? '' : undefined} style={{ maxHeight: placement.height }} ref={panel}>
      {open && actions.map((action) => <button className={action.danger ? 'quiet danger-text' : 'quiet'} key={action.key}
        type="button" disabled={action.disabled} onClick={() => {
          closeAndFocus();
          action.run();
        }}>{action.label}</button>)}
    </div>
  </div>;
}
