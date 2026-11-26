import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../components/Icon.tsx';
import type { StashClient } from '../../supabase.ts';
import { ItemActions } from '../items/ItemActions.tsx';
import { focusAfterRemoval, noteLabel } from '../items/NoteMenu.tsx';
import { intentionLabels, kindLabels, listItems, pageSize, type Filters, type OrganizedItem } from '../items/items.ts';
import { httpUrl } from '../capture/capture.ts';

const date = new Intl.DateTimeFormat('it', { dateStyle: 'medium', timeStyle: 'short' });

export function Inbox({ client, owner, revision, project, filters, recent, onLink, onChanged, onEmpty, onReset }: {
  client: StashClient;
  owner: string;
  revision: number;
  project?: { id: string; name: string };
  filters?: Filters;
  recent?: { onAll: () => void; onWrite: () => void };
  onChanged: () => void;
  onLink?: (itemId: string) => void;
  onEmpty?: () => void;
  onReset?: () => void;
}) {
  const [items, setItems] = useState<OrganizedItem[]>([]);
  const [pages, setPages] = useState(1);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState({ message: '', error: false });
  const [refresh, setRefresh] = useState(0);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const section = useRef<HTMLElement>(null);
  const projectId = project?.id;
  const recentOnly = !!recent;
  const filtered = filters && Object.values(filters).some(Boolean);

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
          const visible = recentOnly ? result.slice(0, 5) : result;
          setItems(visible);
          setOpenMenu((current) => visible.some((item) => item.id === current) ? current : null);
          setMore(!recentOnly && hasMore);
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
  }, [client, owner, pages, refresh, revision, projectId, filters, recentOnly]);

  function remove(id: string, message: string) {
    focusAfterRemoval(section.current, id);
    setItems((rows) => rows.filter((row) => row.id !== id));
    setFeedback({ message, error: false });
    onChanged();
  }

  return (
    <section ref={section} className="inbox" aria-labelledby="inbox-title" aria-busy={loading}>
      <div className="section-heading">
        <h2 id="inbox-title" data-list-heading tabIndex={-1}>{recent ? 'Note recenti' : project ? 'Note e link' : filtered ? 'Risultati' : 'Tutte le note'}</h2>
        {recent ? <button className="quiet more-link" type="button" onClick={recent.onAll}>Vedi tutto <Icon name="chevron" /></button>
          : <button className="quiet" type="button" onClick={() => setRefresh((value) => value + 1)}>Aggiorna</button>}
      </div>
      {error && <div className="inline-feedback">
        <p role="alert" className="feedback error">{error}</p>
        <button className="quiet" type="button" onClick={() => setRefresh((value) => value + 1)}>Riprova</button>
      </div>}
      <p role={feedback.error ? 'alert' : 'status'} className={feedback.error ? 'feedback error' : 'feedback'}>{feedback.message}</p>
      {loading && !items.length && <p className="inbox-empty" role="status">Caricamento…</p>}
      {!loading && !error && !items.length && <div className="empty-state">
        <p className="inbox-empty">{project ? 'Nessuna nota collegata.' : filtered ? 'Nessuna nota corrispondente.'
          : recent ? 'Qui troverai le note che salvi.' : 'Nessuna nota salvata.'}</p>
        {recent && <button className="quiet" type="button" onClick={recent.onWrite}>Scrivi una nota</button>}
        {filtered && onReset && <button className="quiet" type="button" onClick={onReset}>Azzera filtri</button>}
        {!filtered && onEmpty && <button className="quiet" type="button" onClick={onEmpty}>{project ? 'Vai alla Libreria' : 'Vai alla Home'}</button>}
      </div>}
      <ul className="items">
        {items.map((item) => {
          const classification = item.classification;
          const url = item.source_url && httpUrl(item.source_url);
          const text = item.raw_text.trim();
          const title = noteLabel(text);
          const [firstLine, ...lines] = text.split('\n');
          const long = text.length > 200 || lines.length > 3 || firstLine.length > 64;
          const body = (long ? lines.slice(0, 2) : lines).join('\n').trim();
          const preview = long && body.length > 120 ? `${body.slice(0, 120).trimEnd()}…` : body;
          const pending = item.files.some((file) => file.status === 'pending');
          const icon = item.kind === 'idea' ? 'idea' : item.kind === 'task' ? 'tasks' : url ? 'link' : 'note';
          return (
            <li key={item.id}>
              <article className="item note-card">
                <div className="note-heading">
                  <span className="note-icon" data-kind={icon}><Icon name={icon} /></span>
                  <div className="note-identity">
                    <h3>{title}</h3>
                    <div className="item-meta">
                      <span>{item.kind ? kindLabels[item.kind] : 'Nota'}</span>
                      <time dateTime={item.captured_at}>{date.format(new Date(item.captured_at))}</time>
                      {item.capture_source === 'share' && <span>Condivisione</span>}
                      {item.edited && <span>Modificata</span>}
                    </div>
                  </div>
                  <ItemActions client={client} owner={owner} item={item} project={project} openMenu={openMenu === item.id}
                    onMenu={setOpenMenu} onLink={onLink} onFeedback={setFeedback} onChanged={onChanged} onRemoved={remove} />
                </div>
                <div className="note-content">
                  {preview && <p className="original">{preview}</p>}
                  {long && <details className="attachments">
                    <summary>Mostra testo completo</summary>
                    <p className="original">{item.raw_text}</p>
                  </details>}
                  {url && <a href={url} target="_blank" rel="noreferrer">Apri link</a>}
                  {classification?.status === 'pending' && <p className="classification status-pending">Classificazione in attesa</p>}
                  {classification?.status === 'skipped' && <p className="classification">Classificazione omessa per proteggere il contenuto</p>}
                  {classification?.status === 'failed' && <p className="classification error">Classificazione non riuscita</p>}
                  {(item.intentions.length > 0 || classification?.result?.needs_clarification) && (
                    <p className="classification">
                      {[...item.intentions.map((value) => intentionLabels[value]),
                        classification?.result?.needs_clarification && 'Da chiarire'].filter(Boolean).join(' · ')}
                    </p>
                  )}
                  {!!item.tags.length && <ul aria-label="Tag" className="tags">
                    {item.tags.map((tag) => <li key={tag}>{tag}</li>)}
                  </ul>}
                  {!!item.files.length && <p className="classification">{item.files.length === 1 ? '1 allegato' : `${item.files.length} allegati`}
                    {pending && ' · Da completare'}</p>}
                </div>
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
