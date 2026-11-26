import { useCallback, useRef, useState } from 'react';
import type { StashClient } from '../../supabase.ts';
import { httpUrl } from '../capture/capture.ts';
import { downloadFile, type ItemFile } from '../files/files.ts';
import { Modal } from '../items/ItemDialog.tsx';
import { noteLabel } from '../items/NoteMenu.tsx';
import { useHomeFeed, useReviewFocus } from './useHomeFeed.ts';

type Memory = { id: string; current_text: string };
type Collection = { week_start: string; entries: Memory[] };
type OpenedNote = {
  current_text: string;
  current_url: string | null;
  context: string | null;
  files: Pick<ItemFile, 'id' | 'name' | 'object_path'>[];
};

const feedback = {
  interesting: ['Interessante', 'Feedback salvato.'],
  seen: ['Già visto', 'La nota non verrà riproposta per 12 settimane.'],
  later: ['Più tardi', 'La nota avrà priorità nei prossimi Ricordi.'],
  never: ['Non riproporre', 'La nota è stata esclusa dai Ricordi.'],
} as const;
type Feedback = keyof typeof feedback;

function focusOpenedNote(element: HTMLDivElement | null) {
  element?.focus();
}

export function Memories({ client, revision }: { client: StashClient; revision: number }) {
  const [selected, setSelected] = useState<{ item: Memory; week: string } | null>(null);
  const [opened, setOpened] = useState<OpenedNote | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [notice, setNotice] = useState('');
  const section = useRef<HTMLElement>(null);
  const focusAfterReview = useReviewFocus(!!selected);
  const load = useCallback(async () => {
    const { data, error } = await client.rpc('get_weekly_memories');
    if (error || !data) throw error ?? new Error('memories_unavailable');
    return data as Collection;
  }, [client]);
  const { data, setData, error, reload } = useHomeFeed(load, revision);

  function close() {
    setSelected(null);
    setOpened(null);
    setFailure('');
  }

  async function act(action: Feedback | 'open') {
    if (!selected || busy) return;
    const { item, week } = selected;
    setBusy(true);
    setFailure('');
    try {
      const { data, error } = await client.rpc('record_memory_action', {
        p_week: week, p_item: item.id, p_action: action,
      });
      if (error) throw error;
      if (!data) {
        setFailure('Questa nota non è più disponibile nella raccolta.');
        reload();
      } else if (action === 'open') {
        setOpened((data as { note: OpenedNote }).note);
      } else {
        focusAfterReview(section.current, item.id);
        setData((current) => current?.week_start === week
          ? { ...current, entries: current.entries.filter((entry) => entry.id !== item.id) }
          : current);
        setNotice(feedback[action][1]);
        close();
        reload();
      }
    } catch {
      setFailure('Impossibile salvare l’azione. Riprova.');
    } finally {
      setBusy(false);
    }
  }

  const url = opened?.current_url && httpUrl(opened.current_url);
  return <>
    {(!!data?.entries.length || error) && <section ref={section} className="review-panel" aria-labelledby="memories-title">
      <div className="section-heading"><h2 id="memories-title" tabIndex={-1} data-list-heading>Ricordi della settimana</h2></div>
      {error && <div className="inline-feedback">
        <p className="feedback error" role="alert">Impossibile caricare i ricordi.</p>
        <button className="quiet" type="button" onClick={reload}>Riprova</button>
      </div>}
      {!!data?.entries.length && <ul className="review-list">
        {data.entries.map((item) => <li key={item.id}>
          <button className="quiet review-note" type="button" data-note-action={item.id} onClick={() => {
            setNotice('');
            setSelected({ item, week: data.week_start });
          }}>{noteLabel(item.current_text)}</button>
        </li>)}
      </ul>}
    </section>}
    {notice && <p className="feedback" role="status">{notice}</p>}
    {selected && <Modal title={noteLabel(opened?.current_text ?? selected.item.current_text)} onClose={close} canClose={() => !busy}>
      {opened && <div tabIndex={-1} ref={focusOpenedNote}>
        <p className="original">{opened.current_text}</p>
        {url && <a href={url} target="_blank" rel="noreferrer">Apri link</a>}
        {opened.context && <p className="original"><strong>Contesto</strong><br />{opened.context}</p>}
        {opened.files.length > 0 && <ul className="file-list">
          {opened.files.map((file) => <li key={file.id}>
            <span>{file.name}</span>
            <button className="quiet" type="button" aria-label={`Scarica ${file.name}`} onClick={() => {
              void downloadFile(client, file).catch(() => setFailure('Impossibile scaricare l’allegato.'));
            }}>Scarica</button>
          </li>)}
        </ul>}
      </div>}
      {failure && <p className="feedback error" role="alert">{failure}</p>}
      <div className="review-actions">
        {!opened && <button className="primary" type="button" disabled={busy} onClick={() => void act('open')}>Apri</button>}
        {(Object.keys(feedback) as Feedback[]).map((action) => <button key={action} className="quiet" type="button"
          disabled={busy} onClick={() => void act(action)}>{feedback[action][0]}</button>)}
        <button className="quiet" type="button" disabled={busy} onClick={close}>Chiudi</button>
      </div>
    </Modal>}
  </>;
}
