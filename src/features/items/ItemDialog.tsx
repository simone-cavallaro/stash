import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

export class FormError extends Error {}

export function ItemDialog({ title, confirm, onConfirm, onClose, children, danger }: {
  title: string; confirm: string; onConfirm: (data: FormData) => Promise<boolean>;
  onClose: () => void; children: ReactNode; danger?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement;
    element.showModal();
    return () => {
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    const data = new FormData(event.currentTarget);
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      if (await onConfirm(data)) onClose();
      else setError('La nota non è più disponibile in questa versione. Chiudi e aggiorna la vista.');
    } catch (failure) {
      setError(failure instanceof FormError ? failure.message : 'Operazione non riuscita. Riprova.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return <dialog ref={dialog} aria-labelledby="item-dialog-title" className="project-dialog" onCancel={(event) => {
    event.preventDefault();
    if (!inFlight.current) onClose();
  }}>
    <h2 id="item-dialog-title">{title}</h2>
    <form className="project-form" onSubmit={(event) => void submit(event)}>
      <fieldset className="dialog-fields" disabled={busy}>{children}</fieldset>
      {error && <p className="feedback error" role="alert">{error}</p>}
      <div className="project-actions">
        <button type="button" className="quiet" autoFocus={danger} disabled={busy} onClick={onClose}>Annulla</button>
        <button className={danger ? 'primary destructive' : 'primary'} disabled={busy}>{busy ? 'Attendi…' : confirm}</button>
      </div>
    </form>
  </dialog>;
}
