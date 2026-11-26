import { useEffect, useRef, useState } from 'react';
import type { StashClient } from '../../supabase.ts';
import { Icon } from '../../components/Icon.tsx';
import { focusAfterRemoval, NoteMenu, noteLabel } from './NoteMenu.tsx';
import { listTrash, pageSize, restoreItem, type TrashedItem } from './items.ts';

const date = new Intl.DateTimeFormat('it', { dateStyle: 'medium', timeStyle: 'short' });

export function Trash({ client, onRestored }: { client: StashClient; onRestored: () => void }) {
  const [items, setItems] = useState<TrashedItem[]>([]);
  const [pages, setPages] = useState(1);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [restore, setRestore] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const section = useRef<HTMLElement>(null);
  const reload = () => setRefresh((value) => value + 1);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const result: TrashedItem[] = [];
        let hasMore = false;
        for (let page = 0; active && page < pages; page++) {
          const rows = await listTrash(client, result.at(-1));
          result.push(...rows);
          hasMore = rows.length === pageSize;
          if (!hasMore) break;
        }
        if (active) {
          setItems(result);
          setOpenMenu((current) => result.some((item) => item.id === current) ? current : null);
          setMore(hasMore);
        }
      } catch {
        if (active) setError('Impossibile caricare il cestino. Riprova.');
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [client, pages, refresh]);

  async function recover(item: TrashedItem) {
    setRestore(item.id);
    setMessage('');
    setError('');
    try {
      const restored = await restoreItem(client, item);
      focusAfterRemoval(section.current, item.id);
      setItems((rows) => rows.filter((row) => row.id !== item.id));
      if (restored) {
        setMessage('Nota ripristinata.');
        onRestored();
      } else {
        setError('La nota non è più disponibile nel cestino.');
      }
      reload();
    } catch {
      setError('Impossibile ripristinare la nota. Riprova.');
    } finally {
      setRestore('');
    }
  }

  return <section ref={section} aria-labelledby="trash-title" aria-busy={loading}>
    <div className="section-heading"><h1 id="trash-title" data-list-heading tabIndex={-1}>Cestino</h1>
      <button type="button" className="quiet" onClick={() => {
        setError('');
        reload();
      }}>Aggiorna</button>
    </div>
    <p className="inbox-empty">Puoi ripristinare le note entro 30 giorni.</p>
    {error && <p className="feedback error" role="alert">{error}</p>}
    <p className="feedback" role="status">{message}</p>
    {loading && <p role="status">Caricamento…</p>}
    {!items.length && !loading && !error && <p className="empty-state">Il Cestino è vuoto.</p>}
    <ul className="items">
      {items.map((item) => <li key={item.id}>
        <article className="item note-card">
          <div className="note-heading">
            <span className="note-icon"><Icon name="trash" /></span>
            <p className="original">{item.text}</p>
            <NoteMenu id={item.id} label={noteLabel(item.text)} open={openMenu === item.id} onToggle={setOpenMenu}
              actions={[{ key: 'restore', label: 'Ripristina', run: () => void recover(item), disabled: !!restore }]} />
          </div>
          <div className="note-content">
            <p className="classification">Ripristinabile fino al <time dateTime={item.expires_at}>{date.format(new Date(item.expires_at))}</time></p>
            {restore === item.id && <p role="status" className="feedback">Ripristino…</p>}
          </div>
        </article>
      </li>)}
    </ul>
    {more && <button type="button" className="quiet more" disabled={loading} onClick={() => {
      setLoading(true);
      setPages((value) => value + 1);
    }}>Carica altre note</button>}
  </section>;
}
