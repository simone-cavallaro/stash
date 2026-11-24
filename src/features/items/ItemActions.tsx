import { useState } from 'react';
import type { Intention, Kind } from '../../../supabase/functions/_shared/item-types.ts';
import type { StashClient } from '../../supabase.ts';
import { httpUrl, maxCaptureLength } from '../capture/capture.ts';
import { TaskEditor } from '../tasks/Tasks.tsx';
import { FormError, ItemDialog } from './ItemDialog.tsx';
import { acceptSuggestion, correctItem, editItem, intentionLabels, kindLabels, trashItem, type OrganizedItem } from './items.ts';

type Action = 'edit' | 'trash' | 'correct' | 'task' | 'project';

export function ItemActions({ client, owner, item, onChanged, onTrashed }: {
  client: StashClient; owner: string; item: OrganizedItem; onChanged: () => void; onTrashed: (id: string) => void;
}) {
  const [selected, select] = useState<{ action: Action; item: OrganizedItem } | null>(null);
  const [addingTask, setAddingTask] = useState(false);
  const [taskMessage, setTaskMessage] = useState('');
  const close = () => select(null);
  const open = (action: Action) => select({ action, item });
  const commit = async (update: Promise<boolean>) => {
    const done = await update;
    if (done) onChanged();
    return done;
  };
  async function addSuggestedTask() {
    if (addingTask) return;
    setAddingTask(true);
    setTaskMessage('');
    try {
      const done = await commit(acceptSuggestion(client, item, 'task'));
      setTaskMessage(done ? 'Task creato.' : 'Proposta scaduta. Aggiorna la nota.');
    } catch {
      setTaskMessage('Impossibile creare il task. Riprova.');
    } finally {
      setAddingTask(false);
    }
  }

  function dialog() {
    if (!selected) return null;
    const { action, item: snapshot } = selected;
    if (action === 'edit') return <ItemDialog title="Modifica nota" confirm="Salva modifiche" onClose={close}
      onConfirm={async (data) => {
        const text = String(data.get('text') ?? '');
        const link = String(data.get('url') ?? '').trim();
        const url = link && link === snapshot.source_url ? snapshot.source_url : httpUrl(link);
        if (!text.trim()) throw new FormError('Scrivi del testo prima di salvare.');
        if (link && !url) throw new FormError('Inserisci un link HTTP o HTTPS valido.');
        return commit(editItem(client, snapshot, text, url, data.get('ai') === 'on'));
      }}>
      <label htmlFor="edit-text">Testo</label>
      <textarea id="edit-text" name="text" autoFocus required maxLength={maxCaptureLength} defaultValue={snapshot.raw_text} />
      <label htmlFor="edit-link">Link (facoltativo)</label>
      <input id="edit-link" name="url" type="url" defaultValue={snapshot.source_url ?? ''} maxLength={maxCaptureLength} />
      <label className="consent"><input type="checkbox" name="ai" /> Riclassifica questa modifica con Groq</label>
    </ItemDialog>;
    if (action === 'trash') return <ItemDialog title="Elimina nota" confirm="Sposta nel cestino" onClose={close} danger
      onConfirm={async () => {
        const done = await trashItem(client, snapshot);
        if (done) onTrashed(snapshot.id);
        return done;
      }}>
      <p>La nota, gli allegati e i task collegati spariranno dalle viste. Potrai ripristinarli dal Cestino entro 30 giorni.</p>
    </ItemDialog>;
    if (action === 'correct') return <ItemDialog title="Correggi classificazione" confirm="Salva correzioni" onClose={close}
      onConfirm={async (data) => {
        const tags = [...new Set(String(data.get('tags') ?? '').split(',')
          .map((tag) => tag.trim().toLocaleLowerCase('it')).filter(Boolean))];
        if (data.get('manual-tags') && (tags.length > 12 || tags.some((tag) => tag.length > 40 || /[\u0000-\u001f\u007f]/u.test(tag)))) {
          throw new FormError('Usa al massimo 12 tag di 40 caratteri ciascuno.');
        }
        return commit(correctItem(client, snapshot, {
          kind_override: (data.get('kind') || null) as Kind | null,
          intentions_override: data.get('manual-intentions') ? data.getAll('intentions') as Intention[] : null,
          tags_override: data.get('manual-tags') ? tags : null,
        }));
      }}>
      <label htmlFor="override-kind">Tipo</label>
      <select id="override-kind" name="kind" defaultValue={snapshot.kind_override ?? ''}>
        <option value="">Usa il suggerimento</option>
        {Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <fieldset className="override-intentions">
        <legend>Intenzioni</legend>
        <label className="consent"><input type="checkbox" name="manual-intentions" defaultChecked={snapshot.intentions_override !== null} /> Usa la mia selezione</label>
        {Object.entries(intentionLabels).map(([value, label]) => <label className="consent" key={value}>
          <input type="checkbox" name="intentions" value={value} defaultChecked={snapshot.intentions.includes(value as Intention)} /> {label}
        </label>)}
      </fieldset>
      <label className="consent"><input type="checkbox" name="manual-tags" defaultChecked={snapshot.tags_override !== null} /> Usa i miei tag</label>
      <label htmlFor="override-tags">Tag separati da virgola</label>
      <input id="override-tags" name="tags" defaultValue={snapshot.tags.join(', ')} maxLength={500} />
    </ItemDialog>;
    if (action === 'task') return <TaskEditor client={client} owner={owner} itemId={snapshot.id} onSaved={onChanged} onClose={close} />;
    return <ItemDialog title="Progetto suggerito" confirm="Crea o collega"
      onClose={close} onConfirm={() => commit(acceptSuggestion(client, snapshot, 'project'))}>
      <p>{snapshot.project_suggestion}</p>
      <p className="feedback">Se esiste già un progetto attivo con questo nome, Stash collega la nota a quel progetto.</p>
    </ItemDialog>;
  }

  return <>
    <div className="project-actions">
      <button type="button" className="quiet" onClick={() => open('edit')}>Modifica</button>
      <button type="button" className="quiet" onClick={() => open('correct')}>Tipo e tag</button>
      <button type="button" className="quiet" onClick={() => open('task')}>Nuovo task</button>
      <button type="button" className="quiet danger-text" onClick={() => open('trash')}>Elimina</button>
    </div>
    {(item.project_suggestion || item.task_suggestion) && <div className="suggestions">
      {item.project_suggestion && <button type="button" className="quiet" onClick={() => open('project')}>
        Progetto suggerito · {item.project_suggestion}
      </button>}
      {item.task_suggestion && <button type="button" className="quiet" disabled={addingTask} onClick={() => void addSuggestedTask()}>
        {addingTask ? 'Creazione…' : `Crea task · ${item.task_suggestion}`}
      </button>}
    </div>}
    {taskMessage && <p role="status" className="feedback">{taskMessage}</p>}
    {dialog()}
  </>;
}
