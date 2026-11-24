import { useEffect, useState } from 'react';
import { retryItem, type StashClient } from '../../supabase.ts';
import { Attachments } from '../files/Attachments.tsx';
import { ItemActions } from '../items/ItemActions.tsx';
import { intentionLabels, kindLabels, listItems, pageSize, type Filters, type OrganizedItem } from '../items/items.ts';
import { httpUrl } from '../capture/capture.ts';
import { unlinkProjectItem } from '../projects/projects.ts';

const date = new Intl.DateTimeFormat('it', { dateStyle: 'medium', timeStyle: 'short' });
export function Inbox({ client, owner, revision, projectId, filters, onLink, onChanged }: {
  client: StashClient;
  owner: string;
  revision: number;
  projectId?: string;
  filters?: Filters;
  onChanged: () => void;
  onLink?: (itemId: string) => void;
}) {
  const [items, setItems] = useState<OrganizedItem[]>([]);
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
        const result: OrganizedItem[] = [];
        let hasMore = false;
        for (let page = 0; page < pages; page++) {
          const chunk = await listItems(client, result.at(-1), projectId ? { project: projectId } : filters);
          result.push(...chunk);
          hasMore = chunk.length === pageSize;
          if (!active || !hasMore) break;
        }
        if (active) {
          setItems(result);
          setMore(hasMore);
          setError('');
        }
      } catch {
        if (active) setError(projectId ? 'Impossibile caricare le note del progetto.' : 'Impossibile caricare le note.');
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
  }, [client, owner, pages, refresh, revision, projectId, filters]);

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
      onChanged();
      setUnlinkFeedback({ message: 'Nota scollegata dal progetto.', error: false });
    } catch {
      setUnlinkFeedback({ message: 'Impossibile scollegare l’Item. Riprova.', error: true });
    } finally {
      setUnlinking(null);
    }
  }

  return (
    <section className="inbox" aria-labelledby="inbox-title" aria-busy={loading}>
      <div className="section-heading">
        <h2 id="inbox-title">{projectId ? 'Note e link' : filters ? 'Risultati' : 'Inbox'}</h2>
        <button className="quiet" type="button" onClick={() => setRefresh((value) => value + 1)}>Aggiorna</button>
      </div>
      {error && <p role="alert" className="feedback error">{error}</p>}
      <p role="status" className={unlinkFeedback.error ? 'feedback error' : 'feedback'} hidden={!unlinkFeedback.message}>{unlinkFeedback.message}</p>
      {loading && !items.length && <p className="inbox-empty">Caricamento…</p>}
      {!loading && !error && !items.length && <p className="inbox-empty">
        {projectId ? 'Collega note e link a questo progetto dall’Inbox.' : filters ? 'Nessuna nota corrispondente.' : 'Qui ritroverai le note e i link che salvi.'}
      </p>}
      <ul className="items">
        {items.map((item) => {
          const classification = item.classification;
          const result = classification?.result;
          const url = item.source_url && httpUrl(item.source_url);
          return (
            <li key={item.id} className="item">
              <article>
                <div className="item-meta">
                  <span>{item.capture_source === 'share' ? 'Condivisione' : 'Nota'}</span>
                  <time dateTime={item.captured_at}>{date.format(new Date(item.captured_at))}</time>
                  {item.edited && <span>Modificata</span>}
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
                {(item.kind || item.intentions.length > 0 || result?.needs_clarification) && (
                  <p className="classification">
                    {[item.kind && kindLabels[item.kind], ...item.intentions.map((value) => intentionLabels[value]),
                      result?.needs_clarification && 'Da chiarire'].filter(Boolean).join(' · ')}
                  </p>
                )}
                {!!item.tags.length && <ul aria-label="Tag" className="tags">
                  {item.tags.map((tag) => <li key={tag}>{tag}</li>)}
                </ul>}
                {item.edited && <details className="attachments">
                  <summary>Contenuto catturato</summary>
                  <p className="original">{item.original_text}</p>
                  {item.original_url && httpUrl(item.original_url) && <a href={item.original_url} target="_blank" rel="noreferrer">Apri link originale</a>}
                </details>}
                <Attachments client={client} itemId={item.id} files={item.files} onChanged={onChanged} />
                <ItemActions client={client} owner={owner} item={item} onChanged={onChanged} onTrashed={(id) => {
                  setItems((rows) => rows.filter((row) => row.id !== id));
                  setUnlinkFeedback({ message: 'Nota spostata nel Cestino.', error: false });
                  onChanged();
                }} />
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
