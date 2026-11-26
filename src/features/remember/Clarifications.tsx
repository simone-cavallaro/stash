import { useCallback, useRef, useState } from 'react';
import type { StashClient } from '../../supabase.ts';
import { httpUrl, maxCaptureLength } from '../capture/capture.ts';
import { FormError, ItemDialog, Modal } from '../items/ItemDialog.tsx';
import { noteLabel } from '../items/NoteMenu.tsx';
import { TaskEditor } from '../tasks/Tasks.tsx';
import { useHomeFeed, useReviewFocus } from './useHomeFeed.ts';

type Question = {
  id: string; revision: number; captured_at: string; current_text: string; current_url: string | null;
};
type Answer = 'remember' | 'explore' | 'context' | 'task' | 'snoozed' | 'ignored';
const pageSize = 5;

export function Clarifications({ client, owner, revision, onChanged }: {
  client: StashClient; owner: string; revision: number; onChanged: () => void;
}) {
  const [pages, setPages] = useState(1);
  const [selection, setSelection] = useState<{ note: Question; form: 'answer' | 'context' | 'task' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [notice, setNotice] = useState('');
  const section = useRef<HTMLElement>(null);
  const focusAfterReview = useReviewFocus(!!selection);
  const request = useRef<{ signature: string; id: string } | null>(null);
  const load = useCallback(async () => {
    const questions: Question[] = [];
    let more = false;
    for (let page = 0; page < pages; page++) {
      const cursor = questions.at(-1);
      const { data, error } = await client.rpc('list_due_clarifications', {
        p_before: cursor?.captured_at ?? null, p_before_id: cursor?.id ?? null,
      });
      if (error) throw error;
      const rows = (data ?? []) as Question[];
      questions.push(...rows.slice(0, pageSize));
      more = rows.length > pageSize;
      if (!more) break;
    }
    return { questions, more };
  }, [client, pages]);
  const { data, setData, error, reload } = useHomeFeed(load, revision, 12_000);
  const questions = data?.questions ?? [];

  async function answer(note: Question, action: Answer, text: string | null = null, due: string | null = null) {
    const signature = JSON.stringify([note.id, note.revision, action, text, due]);
    if (request.current?.signature !== signature) request.current = { signature, id: crypto.randomUUID() };
    const { data, error } = await client.rpc('respond_to_clarification', {
      p_item: note.id, p_revision: note.revision, p_request: request.current.id, p_action: action,
      p_text: text, p_due_at: due,
    });
    if (error) throw error;
    if (data !== true) {
      reload();
      return false;
    }
    request.current = null;
    focusAfterReview(section.current, note.id);
    setData((current) => current && { ...current, questions: current.questions.filter((question) => question.id !== note.id) });
    setNotice(action === 'snoozed' ? 'Lo rivedrai tra 24 ore.' : action === 'task' ? 'Task creato.'
      : action === 'ignored' ? 'Domanda chiusa.' : 'Chiarimento salvato.');
    if (action !== 'task') onChanged();
    return true;
  }

  async function quick(note: Question, action: Answer) {
    if (busy) return;
    setBusy(true);
    setFailure('');
    try {
      if (await answer(note, action)) setSelection(null);
      else setFailure('Questa domanda è già stata gestita o la nota è cambiata.');
    } catch {
      setFailure('Impossibile salvare la risposta. Riprova.');
    } finally {
      setBusy(false);
    }
  }

  function close() {
    setFailure('');
    setSelection(null);
  }

  const note = selection?.note;
  const url = note?.current_url && httpUrl(note.current_url);
  return <>
    {(questions.length > 0 || error) && <section ref={section} className="review-panel" aria-labelledby="clarifications-title">
      <div className="section-heading"><h2 id="clarifications-title" tabIndex={-1} data-list-heading>Da chiarire</h2></div>
      {error && <div className="inline-feedback">
        <p className="feedback error" role="alert">Impossibile caricare i chiarimenti.</p>
        <button type="button" className="quiet" onClick={reload}>Riprova</button>
      </div>}
      {questions.length > 0 && <ul className="review-list">
        {questions.map((note) => <li key={note.id}>
          <button className="quiet review-note" type="button" data-note-action={note.id} onClick={() => {
            setNotice('');
            setSelection({ note, form: 'answer' });
          }}>{noteLabel(note.current_text)}</button>
        </li>)}
      </ul>}
      {data?.more && <button className="quiet" type="button" onClick={() => setPages((value) => value + 1)}>Mostra altre domande</button>}
    </section>}
    {notice && <p className="feedback" role="status">{notice}</p>}
    {note && selection.form === 'answer' && <Modal title="Cosa volevi fare con questa nota?" onClose={close} canClose={() => !busy}>
      <p className="original">{note.current_text}</p>
      {url && <a href={url} target="_blank" rel="noreferrer">Apri link</a>}
      {failure && <p className="feedback error" role="alert">{failure}</p>}
      <div className="review-actions">
        <button className="quiet" type="button" disabled={busy} onClick={() => void quick(note, 'remember')}>Ricordare</button>
        <button className="quiet" type="button" disabled={busy} onClick={() => void quick(note, 'explore')}>Approfondire</button>
        <button className="quiet" type="button" disabled={busy} onClick={() => setSelection({ note, form: 'context' })}>Aggiungi contesto</button>
        <button className="quiet" type="button" disabled={busy} onClick={() => setSelection({ note, form: 'task' })}>Crea task</button>
        <button className="quiet" type="button" disabled={busy} onClick={() => void quick(note, 'snoozed')}>Più tardi</button>
        <button className="quiet" type="button" disabled={busy} onClick={() => void quick(note, 'ignored')}>Ignora</button>
        <button className="quiet" type="button" disabled={busy} onClick={close}>Chiudi</button>
      </div>
    </Modal>}
    {note && selection.form === 'context' && <ItemDialog title="Aggiungi contesto" confirm="Salva contesto" onClose={close}
      onConfirm={(values) => {
        const context = String(values.get('context') ?? '').trim();
        if (!context) throw new FormError('Scrivi il contesto prima di salvare.');
        return answer(note, 'context', context);
      }}>
      <p className="original">{note.current_text}</p>
      <label htmlFor="clarification-context">Contesto</label>
      <textarea id="clarification-context" name="context" autoFocus required maxLength={maxCaptureLength} />
    </ItemDialog>}
    {note && selection.form === 'task' && <TaskEditor client={client} owner={owner} itemId={note.id}
      onClose={close} onSaved={onChanged} onCreate={(title, due) => answer(note, 'task', title, due)} />}
  </>;
}
