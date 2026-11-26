import { useState } from 'react';
import type { Intention, Kind } from '../../../supabase/functions/_shared/item-types.ts';
import { retryItem, type StashClient } from '../../supabase.ts';
import { Attachments } from '../files/Attachments.tsx';
import { unlinkProjectItem } from '../projects/projects.ts';
import { NoteMenu, noteLabel, type NoteAction } from './NoteMenu.tsx';
import { httpUrl, maxCaptureLength } from '../capture/capture.ts';
import { TaskEditor } from '../tasks/Tasks.tsx';
import { FormError, ItemDialog } from './ItemDialog.tsx';
import { acceptSuggestion, correctItem, editItem, intentionLabels, kindLabels, trashItem, type OrganizedItem } from './items.ts';

type Action = 'edit' | 'trash' | 'correct' | 'task' | 'task-suggestion' | 'project' | 'unlink' | 'files';
type Feedback = { message: string; error: boolean };

export function ItemActions({ client, owner, item, project, openMenu, onMenu, onChanged, onRemoved, onLink, onFeedback }: {
  client: StashClient; owner: string; item: OrganizedItem; project?: { id: string; name: string };
  openMenu: boolean; onMenu: (id: string | null) => void; onChanged: () => void;
  onRemoved: (id: string, message: string) => void; onLink?: (id: string) => void;
  onFeedback: (feedback: Feedback) => void;
}) {
  const [selected, select] = useState<{ action: Action; item: OrganizedItem } | null>(null);
  const [retrying, setRetrying] = useState(false);
  const close = () => select(null);
  const open = (action: Action) => select({ action, item });
  const commit = async (update: Promise<boolean>) => {
    const done = await update;
    if (done) onChanged();
    return done;
  };

  async function retry() {
    if (retrying) return;
    setRetrying(true);
    onFeedback({ message: 'Riavvio della classificazione…', error: false });
    try {
      await retryItem(client, owner, item.id);
      onChanged();
      onFeedback({ message: 'Richiesta di classificazione inviata.', error: false });
    } catch {
      onFeedback({ message: 'Impossibile riavviare la classificazione. Riprova dal menu della nota.', error: true });
    } finally {
      setRetrying(false);
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
      <label className="consent">
        <input type="checkbox" name="ai" aria-labelledby="edit-ai-label" aria-describedby="edit-ai-hint" />
        <span>
          <span id="edit-ai-label">Riclassifica questa nota con l’AI</span>
          <span id="edit-ai-hint" className="consent-hint">Testo e link possono essere inviati a un servizio esterno.</span>
        </span>
      </label>
    </ItemDialog>;
    if (action === 'trash') return <ItemDialog title="Sposta nel Cestino" confirm="Sposta nel Cestino" onClose={close} danger
      onConfirm={async () => {
        const done = await trashItem(client, snapshot);
        if (done) onRemoved(snapshot.id, 'Nota spostata nel Cestino.');
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
      <select autoFocus id="override-kind" name="kind" defaultValue={snapshot.kind_override ?? ''}>
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
    if (action === 'task-suggestion') return <ItemDialog title="Task suggerito" confirm="Crea task"
      onClose={close} onConfirm={() => commit(acceptSuggestion(client, snapshot, 'task'))}>
      <p className="original">{snapshot.task_suggestion}</p>
    </ItemDialog>;
    if (action === 'unlink' && project) return <ItemDialog title="Scollega dal progetto" confirm="Scollega" danger
      onClose={close} onConfirm={async () => {
        await unlinkProjectItem(client, owner, project.id, snapshot.id);
        onRemoved(snapshot.id, 'Nota scollegata dal progetto.');
        return true;
      }}>
      <p>La nota verrà scollegata da «{project.name}» e resterà in Libreria.</p>
    </ItemDialog>;
    if (action !== 'project') return null;
    return <ItemDialog title="Progetto suggerito" confirm="Crea o collega"
      onClose={close} onConfirm={() => commit(acceptSuggestion(client, snapshot, 'project'))}>
      <p>{snapshot.project_suggestion}</p>
      <p className="feedback">Se esiste già un progetto attivo con questo nome, Stash collega la nota a quel progetto.</p>
    </ItemDialog>;
  }

  const actions: NoteAction[] = [
    { key: 'edit', label: 'Modifica nota…', run: () => open('edit') },
    { key: 'correct', label: 'Tipo e tag…', run: () => open('correct') },
    { key: 'task', label: 'Nuovo task…', run: () => open('task') },
  ];
  if (item.task_suggestion) actions.push({ key: 'task-suggestion', label: 'Task suggerito…', run: () => open('task-suggestion') });
  if (item.project_suggestion) actions.push({ key: 'project-suggestion', label: 'Progetto suggerito…', run: () => open('project') });
  if (onLink) actions.push({ key: 'link', label: 'Collega a progetto…', run: () => onLink(item.id) });
  if (project) actions.push({ key: 'unlink', label: 'Scollega dal progetto…', run: () => open('unlink') });
  actions.push({ key: 'files', label: 'Gestisci allegati…', run: () => open('files') });
  if (item.classification?.status === 'failed') actions.push({
    key: 'retry', label: retrying ? 'Richiesta in corso…' : 'Riprova classificazione',
    run: () => void retry(), disabled: retrying,
  });
  actions.push({ key: 'trash', label: 'Sposta nel Cestino…', run: () => open('trash'), danger: true });

  return <>
    <NoteMenu id={item.id} label={noteLabel(item.raw_text)} open={openMenu} onToggle={onMenu} actions={actions} />
    <Attachments client={client} itemId={item.id} files={item.files} onChanged={onChanged}
      open={selected?.action === 'files'} onClose={close} />
    {dialog()}
  </>;
}
