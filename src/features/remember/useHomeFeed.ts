import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export function useReviewFocus(dialogOpen: boolean) {
  const pending = useRef<{ section: HTMLElement | null; adjacent?: HTMLButtonElement }>(null);
  useLayoutEffect(() => {
    if (dialogOpen || !pending.current) return;
    const { section, adjacent } = pending.current;
    pending.current = null;
    if (adjacent?.isConnected) adjacent.focus();
    else if (section?.isConnected) section.querySelector<HTMLElement>('[data-list-heading]')?.focus();
    else document.getElementById('capture')?.focus();
  }, [dialogOpen]);
  return (section: HTMLElement | null, id: string) => {
    const buttons = [...(section?.querySelectorAll<HTMLButtonElement>('[data-note-action]') ?? [])];
    const index = buttons.findIndex((button) => button.dataset.noteAction === id);
    pending.current = { section, adjacent: buttons[index + 1] ?? buttons[index - 1] };
  };
}

export function useHomeFeed<T>(load: () => Promise<T>, revision: number, poll?: number) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let active = true;
    let reading = false;
    async function read() {
      if (reading) return;
      reading = true;
      try {
        const next = await load();
        if (active) {
          setData(next);
          setError(false);
        }
      } catch {
        if (active) setError(true);
      } finally {
        reading = false;
      }
    }
    function whenVisible() {
      if (document.visibilityState === 'visible') void read();
    }
    void read();
    document.addEventListener('visibilitychange', whenVisible);
    const timer = poll === undefined ? undefined : window.setInterval(whenVisible, poll);
    return () => {
      active = false;
      document.removeEventListener('visibilitychange', whenVisible);
      window.clearInterval(timer);
    };
  }, [load, poll, refresh, revision]);

  return { data, setData, error, reload: () => setRefresh((value) => value + 1) };
}
