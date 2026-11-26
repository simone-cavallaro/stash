import { useEffect, type RefObject } from 'react';

export function swipeStep(start: { x: number; y: number }, end: { x: number; y: number }, width: number): -1 | 0 | 1 {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (start.x <= 24 || width - start.x <= 24 || Math.abs(dx) < 60 || Math.abs(dx) < 1.5 * Math.abs(dy)) return 0;
  return dx < 0 ? 1 : -1;
}

const editing = '.capture-form, input:not([type="checkbox"], [type="file"]), textarea, [contenteditable="true"]';
const excluded = 'a, button, input, textarea, select, label, summary, [contenteditable], [role="button"], dialog, [data-note-menu]';

export function useSectionSwipe(content: RefObject<HTMLElement | null>, enabled: boolean, navigate: (step: -1 | 1) => void) {
  useEffect(() => {
    if (!content.current || !enabled) return;
    const element = content.current;
    const fingers = new Set<number>();
    let start: { id: number; x: number; y: number } | null = null;
    const viewport = window.visualViewport;
    const zoomed = () => (viewport?.scale ?? 1) !== 1;
    const selecting = () => window.getSelection()?.isCollapsed === false;
    const blocked = () => zoomed() || selecting() || !!document.activeElement?.closest(editing)
      || !!document.querySelector('dialog[open], [data-note-menu]');

    function updateZoom() {
      element.toggleAttribute('data-swipe', !zoomed());
      if (zoomed()) start = null;
    }
    function down(event: PointerEvent) {
      if (event.pointerType !== 'touch') return;
      fingers.add(event.pointerId);
      start = null;
      if (fingers.size !== 1 || !event.isPrimary || blocked() || !(event.target instanceof Element)
        || !element.contains(event.target) || event.target.closest(excluded)) return;
      start = { id: event.pointerId, x: event.clientX, y: event.clientY };
    }
    function end(event: PointerEvent) {
      fingers.delete(event.pointerId);
      if (start?.id !== event.pointerId) return;
      const candidate = start;
      start = null;
      if (event.type !== 'pointerup' || blocked()) return;
      const step = swipeStep(candidate, { x: event.clientX, y: event.clientY }, document.documentElement.clientWidth);
      if (step) navigate(step);
    }
    function selectionChanged() {
      if (selecting()) start = null;
    }
    updateZoom();
    viewport?.addEventListener('resize', updateZoom);
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', end, true);
    window.addEventListener('pointercancel', end, true);
    document.addEventListener('selectionchange', selectionChanged);
    return () => {
      element.removeAttribute('data-swipe');
      viewport?.removeEventListener('resize', updateZoom);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', end, true);
      window.removeEventListener('pointercancel', end, true);
      document.removeEventListener('selectionchange', selectionChanged);
    };
  }, [content, enabled, navigate]);
}
