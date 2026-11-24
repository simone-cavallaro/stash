import { useEffect, useState } from 'react';
import type { StashClient } from '../../supabase.ts';
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
      if (await restoreItem(client, item)) {
        setItems((rows) => rows.filter((row) => row.id !== item.id));
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

  return <section aria-labelledby="trash-title" aria-busy={loading}>
    <div className="section-heading"><h1 id="trash-title">Cestino</h1>
      <button type="button" className="quiet" onClick={() => {
        setError('');
        reload();
      }}>Aggiorna</button>
    </div>
    <p className="inbox-empty">Puoi ripristinare le note entro 30 giorni.</p>
    {error && <p className="feedback error" role="alert">{error}</p>}
    <p className="feedback" role="status">{message}</p>
    {loading && <p role="status">Caricamento…</p>}
    {!items.length && !loading && !error && <p>Il cestino è vuoto.</p>}
    <ul className="items">
      {items.map((item) => <li key={item.id} className="item">
        <p className="original">{item.text}</p>
        <p className="classification">Ripristinabile fino al <time dateTime={item.expires_at}>{date.format(new Date(item.expires_at))}</time></p>
        <button type="button" className="quiet" disabled={!!restore} onClick={() => void recover(item)}>
          {restore === item.id ? 'Ripristino…' : 'Ripristina'}
        </button>
      </li>)}
    </ul>
    {more && <button type="button" className="quiet more" disabled={loading} onClick={() => {
      setLoading(true);
      setPages((value) => value + 1);
    }}>Carica altre note</button>}
  </section>;
}
