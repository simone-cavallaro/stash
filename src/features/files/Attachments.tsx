import { useId, useRef, useState } from 'react';
import { ItemDialog, Modal } from '../items/ItemDialog.tsx';
import type { StashClient } from '../../supabase.ts';
import { acceptedFiles, downloadFile, maxFiles, prepareFiles, removeFile, uploadFile, type ItemFile, type Upload } from './files.ts';

export function Attachments({ client, itemId, files, onChanged, open, onClose }: {
  client: StashClient; itemId: string; files: ItemFile[]; onChanged: () => void; open: boolean; onClose: () => void;
}) {
  const inputId = useId();
  const inFlight = useRef(false);
  const [remaining, setRemaining] = useState<Upload[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [removing, setRemoving] = useState<ItemFile | null>(null);

  async function upload(entries: Upload[]) {
    if (!entries.length || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage('');
    const failed: Upload[] = [];
    for (const entry of entries) {
      try {
        await uploadFile(client, itemId, entry);
      } catch {
        failed.push(entry);
      }
    }
    setRemaining(failed);
    setMessage(failed.length ? 'Allegati da completare. Riprova il caricamento.' : 'Allegati salvati.');
    setBusy(false);
    inFlight.current = false;
    onChanged();
  }

  function select(selected: FileList) {
    try {
      const entries = prepareFiles(selected);
      const existing = new Set<string>();
      for (const entry of entries) {
        const pending = files.find((file) => file.status === 'pending' && !existing.has(file.id)
          && file.name === entry.file.name && file.size === entry.file.size && file.mime === entry.mime);
        if (pending) {
          existing.add(pending.id);
          entry.id = pending.id;
        }
      }
      if (files.length + entries.length - existing.size > maxFiles) throw new Error('Puoi aggiungere al massimo 5 allegati per nota.');
      void upload(entries);
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : 'Impossibile leggere i file.');
    }
  }

  if (!open) return null;

  return <Modal title="Gestisci allegati" onClose={onClose} canClose={() => !inFlight.current}>
    {!!files.length && <ul className="file-list">
      {files.map((file) => <li key={file.id}>
        <span>{file.name}{file.status === 'pending' ? ' · Da completare' : ''}</span>
        {file.status === 'ready' && <button type="button" className="quiet" onClick={() => {
          void downloadFile(client, file).catch(() => setMessage('Impossibile scaricare l’allegato.'));
        }}>Scarica</button>}
        <button type="button" className="quiet danger-text" disabled={busy} onClick={() => setRemoving(file)}
          aria-label={`Rimuovi ${file.name}`}>Rimuovi…</button>
      </li>)}
    </ul>}
    <label htmlFor={inputId}>{files.some((file) => file.status === 'pending') ? 'Aggiungi o riseleziona i file' : 'Aggiungi allegati'}</label>
    <input id={inputId} type="file" multiple accept={acceptedFiles} disabled={busy || !!remaining.length}
      onChange={(event) => {
        if (event.target.files) select(event.target.files);
        event.target.value = '';
      }} />
    {!!remaining.length && <div className="project-actions">
      <ul className="file-list" aria-label="Caricamenti da completare">
        {remaining.map(({ id, file }) => <li key={id}>{file.name} · Da completare</li>)}
      </ul>
      <button type="button" className="quiet" disabled={busy} onClick={() => void upload(remaining)}>Riprova allegati</button>
      <button type="button" className="quiet" disabled={busy} onClick={() => setRemaining([])}>Annulla tentativo</button>
    </div>}
    <p className="feedback" role="status">{busy ? 'Attendi…' : message}</p>
    <button className="quiet" type="button" disabled={busy} onClick={onClose}>Chiudi</button>
    {removing && <ItemDialog title="Rimuovi allegato" confirm="Rimuovi" danger onClose={() => setRemoving(null)}
      onConfirm={async () => {
        await removeFile(client, itemId, removing.id);
        setRemaining((entries) => entries.filter((entry) => entry.id !== removing.id));
        setMessage('Allegato rimosso.');
        onChanged();
        return true;
      }}><p className="original">Rimuovi «{removing.name}» dalla nota.</p></ItemDialog>}
  </Modal>;
}
