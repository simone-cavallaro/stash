import { useEffect, useRef, useState } from 'react';
import type { StashClient } from '../../supabase.ts';
import { FormError, ItemDialog } from '../items/ItemDialog.tsx';

type Task = {
  id: string;
  item_id: string;
  title: string;
  due_at: string | null;
  completed_at: string | null;
};
const date = new Intl.DateTimeFormat('it', { dateStyle: 'medium', timeStyle: 'short' });

function toLocalInput(value: string | null) {
  if (!value) return '';
  const time = new Date(value);
  return new Date(time.getTime() - time.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function TaskEditor({ client, owner, itemId, task, onClose, onSaved }: {
  client: StashClient; owner: string; itemId: string; task?: Task; onClose: () => void; onSaved: () => void;
}) {
  const requestId = useRef<{ id: string; signature: string } | null>(null);
  return <ItemDialog title={task ? 'Modifica task' : 'Nuovo task'} confirm={task ? 'Salva modifiche' : 'Crea task'}
    onClose={onClose} onConfirm={async (data) => {
      const title = String(data.get('title') ?? '').trim();
      const due = String(data.get('due') ?? '');
      if (!title) throw new FormError('Scrivi il titolo del task.');
      const due_at = due ? new Date(due).toISOString() : null;
      if (task) {
        const { data: updated, error } = await client.from('tasks').update({ title, due_at })
          .eq('user_id', owner).eq('id', task.id).select('id').maybeSingle();
        if (error) throw error;
        if (!updated) return false;
      } else {
        const signature = JSON.stringify([title, due_at]);
        if (requestId.current?.signature !== signature) requestId.current = { id: crypto.randomUUID(), signature };
        const { error } = await client.from('tasks').upsert({
          user_id: owner, id: requestId.current.id, item_id: itemId, title, due_at,
        }, { onConflict: 'user_id,id', ignoreDuplicates: true });
        if (error) throw error;
      }
      onSaved();
      return true;
    }}>
    <label htmlFor="task-title">Titolo</label>
    <input id="task-title" name="title" autoFocus required maxLength={200} defaultValue={task?.title} />
    <label htmlFor="task-due">Scadenza (facoltativa)</label>
    <input id="task-due" name="due" type="datetime-local" defaultValue={toLocalInput(task?.due_at ?? null)} />
  </ItemDialog>;
}

export function Tasks({ client, owner, revision, project }: {
  client: StashClient; owner: string; revision: number; project?: string;
}) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [refresh, setRefresh] = useState(0);
  const reload = () => setRefresh((value) => value + 1);

  useEffect(() => {
    let active = true;
    async function load() {
      const rows: Task[] = [];
      try {
        while (active) {
          const { data, error } = await client.rpc('list_tasks', {
            p_project: project ?? null, p_after: rows.at(-1)?.id ?? null,
          });
          if (error) throw error;
          const chunk = (data ?? []) as Task[];
          rows.push(...chunk);
          if (chunk.length < 100) break;
        }
        if (active) {
          setTasks(rows.sort((a, b) => Number(!!a.completed_at) - Number(!!b.completed_at)
            || (a.due_at ? Date.parse(a.due_at) : Infinity) - (b.due_at ? Date.parse(b.due_at) : Infinity)
            || a.title.localeCompare(b.title, 'it')));
          setError('');
        }
      } catch {
        if (active) setError('Impossibile caricare i task.');
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [client, owner, project, refresh, revision]);

  async function toggle(task: Task) {
    setBusy(true);
    try {
      const { data, error } = await client.from('tasks').update({
        completed_at: task.completed_at ? null : new Date().toISOString(),
      }).eq('user_id', owner).eq('id', task.id).select('id').maybeSingle();
      if (error || !data) throw error ?? new Error('task_unavailable');
      reload();
    } catch {
      setError('Impossibile aggiornare il task. Riprova.');
    } finally {
      setBusy(false);
    }
  }

  return <section className="inbox" aria-labelledby="tasks-title" aria-busy={loading}>
    <div className="section-heading"><h2 id="tasks-title">Task</h2>
      <button type="button" className="quiet" onClick={reload}>Aggiorna</button>
    </div>
    {error && <p className="feedback error" role="alert">{error}</p>}
    {loading && <p className="inbox-empty" role="status">Caricamento…</p>}
    {!loading && !tasks.length && !error && <p className="inbox-empty">Puoi creare un task da una nota salvata.</p>}
    <ul className="items">
      {tasks.map((task) => <li key={task.id} className="item">
        <strong>{task.title}</strong>
        <p className="classification">{task.completed_at ? 'Completato' : 'Da fare'}
          {task.due_at && <> · <time dateTime={task.due_at}>{date.format(new Date(task.due_at))}</time></>}
        </p>
        <div className="project-actions">
          <button type="button" className="quiet" disabled={busy} onClick={() => void toggle(task)}>
            {task.completed_at ? 'Riapri' : 'Completa'}
          </button>
          <button type="button" className="quiet" disabled={busy} onClick={() => setEditing(task)}>Modifica</button>
        </div>
      </li>)}
    </ul>
    {editing && <TaskEditor client={client} owner={owner} itemId={editing.item_id} task={editing}
      onClose={() => setEditing(null)} onSaved={reload} />}
  </section>;
}
