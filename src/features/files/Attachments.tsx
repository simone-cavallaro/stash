import { useId, useRef, useState } from 'react';
import type { StashClient } from '../../supabase.ts';
import { acceptedFiles, downloadFile, maxFiles, prepareFiles, removeFile, uploadFile, type ItemFile, type Upload } from './files.ts';

export function Attachments({ client, itemId, files, onChanged }: {
  client: StashClient; itemId: string; files: ItemFile[]; onChanged: () => void;
}) {
  const inputId = useId();
  const inFlight = useRef(false);
  const [remaining, setRemaining] = useState<Upload[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

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

  async function remove(file: ItemFile) {
    setBusy(true);
    try {
      await removeFile(client, itemId, file.id);
      setRemaining((entries) => entries.filter((entry) => entry.id !== file.id));
      onChanged();
      setMessage('Allegato rimosso.');
    } catch {
      setMessage('Impossibile rimuovere l’allegato. Riprova.');
    } finally {
      setBusy(false);
    }
  }

  return <details className="attachments">
    <summary>{files.length ? `Allegati (${files.length})` : 'Allegati'}</summary>
    {!!files.length && <ul className="file-list">
      {files.map((file) => <li key={file.id}>
        <span>{file.name}{file.status === 'pending' ? ' · Da completare' : ''}</span>
        {file.status === 'ready' && <button type="button" className="quiet" onClick={() => {
          void downloadFile(client, file).catch(() => setMessage('Impossibile scaricare l’allegato.'));
        }}>Scarica</button>}
        <button type="button" className="quiet" disabled={busy} onClick={() => void remove(file)}>Rimuovi</button>
      </li>)}
    </ul>}
    <label htmlFor={inputId}>{files.some((file) => file.status === 'pending') ? 'Aggiungi o riseleziona i file' : 'Aggiungi allegati'}</label>
    <input id={inputId} type="file" multiple accept={acceptedFiles} disabled={busy || !!remaining.length}
      onChange={(event) => {
        if (event.target.files) select(event.target.files);
        event.target.value = '';
      }} />
    {!!remaining.length && <div className="project-actions">
      <button type="button" className="quiet" disabled={busy} onClick={() => void upload(remaining)}>Riprova allegati</button>
      <button type="button" className="quiet" disabled={busy} onClick={() => setRemaining([])}>Annulla tentativo</button>
    </div>}
    <p className="feedback" role="status">{busy ? 'Attendi…' : message}</p>
  </details>;
}
