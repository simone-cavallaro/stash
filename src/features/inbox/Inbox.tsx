import { useEffect, useState } from 'react';
import { listItems, retryItem, type Item, type StashClient } from '../../supabase.ts';
import { httpUrl } from '../capture/capture.ts';
import { unlinkProjectItem } from '../projects/projects.ts';

const date = new Intl.DateTimeFormat('it', { dateStyle: 'medium', timeStyle: 'short' });
const kinds: Record<string, string> = {
  person: 'Persona', tool: 'Strumento', model: 'Modello', concept: 'Concetto',
  article: 'Articolo', document: 'Documento', idea: 'Idea', task: 'Azione', other: 'Altro',
};
const intentions: Record<string, string> = { remember: 'Da ricordare', explore: 'Da esplorare', act: 'Da fare' };

export function Inbox({ client, owner, revision, projectId, onLink }: {
  client: StashClient;
  owner: string;
  revision: number;
  projectId?: string;
  onLink?: (itemId: string) => void;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [pages, setPages] = useState(1);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retrying, setRetrying] = useState<string | null>(null);
  const [unlinking, setUnlinking] = useState<string | null>(null);
  const [unlinkFeedback, setUnlinkFeedback] = useState({ message: '', error: false });
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let active = true;
    let reading = false;
    async function load() {
      if (reading) return;
      reading = true;
      try {
        const result: Item[] = [];
        let hasMore = false;
        for (let page = 0; page < pages; page++) {
          const chunk = await listItems(client, owner, result.at(-1), projectId);
          result.push(...chunk);
          hasMore = chunk.length === 30;
          if (!active || !hasMore) break;
        }
        if (active) {
          setItems(result);
          setMore(hasMore);
          setError('');
        }
      } catch {
        if (active) setError(projectId ? 'Impossibile caricare gli Item del progetto.' : 'Impossibile caricare l’Inbox.');
      } finally {
        if (active) setLoading(false);
        reading = false;
      }
    }
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 12000);
    return () => { active = false; window.clearInterval(timer); };
  }, [client, owner, pages, refresh, revision, projectId]);

  async function retry(id: string) {
    setRetrying(id);
    try {
      await retryItem(client, owner, id);
      setRefresh((value) => value + 1);
    } catch {
      setError('Impossibile riavviare la classificazione. Riprova.');
    } finally {
      setRetrying(null);
    }
  }

  async function unlink(id: string) {
    if (!projectId || unlinking) return;
    setUnlinking(id);
    setUnlinkFeedback({ message: '', error: false });
    try {
      await unlinkProjectItem(client, owner, projectId, id);
      setItems((rows) => rows.filter((item) => item.id !== id));
      setRefresh((value) => value + 1);
      setUnlinkFeedback({ message: 'Item scollegato dal progetto.', error: false });
    } catch {
      setUnlinkFeedback({ message: 'Impossibile scollegare l’Item. Riprova.', error: true });
    } finally {
      setUnlinking(null);
    }
  }

  return (
    <section className="inbox" aria-labelledby="inbox-title" aria-busy={loading}>
      <div className="section-heading">
        <h2 id="inbox-title">{projectId ? 'Note e link' : 'Inbox'}</h2>
        <button className="quiet" type="button" onClick={() => setRefresh((value) => value + 1)}>Aggiorna</button>
      </div>
      {error && <p role="alert" className="feedback error">{error}</p>}
      {projectId && <p role="status" className={unlinkFeedback.error ? 'feedback error' : 'feedback'}>{unlinkFeedback.message}</p>}
      {loading && !items.length && <p className="inbox-empty">Caricamento…</p>}
      {!loading && !error && !items.length && <p className="inbox-empty">
        {projectId ? 'Collega note e link a questo progetto dall’Inbox.' : 'Qui ritroverai le note e i link che salvi.'}
      </p>}
      <ul className="items">
        {items.map((item) => {
          const classification = item.item_classifications;
          const result = classification?.result;
          const url = item.source_url && httpUrl(item.source_url);
          return (
            <li key={item.id} className="item">
              <article>
                <div className="item-meta">
                  <span>{item.capture_source === 'share' ? 'Condivisione' : 'Nota'}</span>
                  <time dateTime={item.captured_at}>{date.format(new Date(item.captured_at))}</time>
                </div>
                <p className="original">{item.raw_text}</p>
                {url && <a href={url} target="_blank" rel="noreferrer">Apri link</a>}
                {classification?.status === 'pending' && <p className="classification">Classificazione in attesa</p>}
                {classification?.status === 'skipped' && <p className="classification">Classificazione omessa per proteggere il contenuto</p>}
                {classification?.status === 'failed' && (
                  <div className="classification retry">
                    <span>Classificazione non riuscita</span>
                    <button className="quiet" type="button" disabled={retrying !== null} onClick={() => void retry(item.id)}>Riprova</button>
                  </div>
                )}
                {classification?.status === 'ready' && result && (
                  <p className="classification">
                    {[kinds[result.kind], ...result.intentions.map((value) => intentions[value]),
                      result.needs_clarification && 'Da chiarire'].filter(Boolean).join(' · ')}
                  </p>
                )}
                {onLink && <button className="quiet item-action" type="button" onClick={() => onLink(item.id)}>Collega a progetto</button>}
                {projectId && <button className="quiet item-action" type="button" disabled={unlinking !== null} onClick={() => void unlink(item.id)}>
                  {unlinking === item.id ? 'Scollegamento…' : 'Scollega'}
                </button>}
              </article>
            </li>
          );
        })}
      </ul>
      {more && <button className="quiet more" type="button" disabled={loading} onClick={() => {
        setLoading(true);
        setPages((value) => value + 1);
      }}>Carica altre note</button>}
    </section>
  );
}
