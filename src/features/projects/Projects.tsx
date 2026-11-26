import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { StashClient } from '../../supabase.ts';
import { FormError, ItemDialog } from '../items/ItemDialog.tsx';
import { createProject, linkProjectItem, listProjects, projectStatus, updateProject, type Project } from './projects.ts';

type AccountProps = { client: StashClient; owner: string };

function useProjects(client: StashClient, owner: string) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    void listProjects(client, owner).then((rows) => {
      if (active) setProjects(rows);
    }, () => {
      if (active) setLoadError(true);
    });
    return () => { active = false; };
  }, [client, owner, revision]);

  function reload() {
    setLoadError(false);
    setRevision((value) => value + 1);
  }

  return { projects, loadError, reload };
}

export function Projects({ client, owner, onOpen }: AccountProps & { onOpen: (project: Project) => void }) {
  const { projects, loadError, reload } = useProjects(client, owner);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const attempt = useRef<Project | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !name.trim()) return;
    const values = new FormData(event.currentTarget);
    attempt.current ??= {
      id: crypto.randomUUID(), status: 'active', name: name.trim(), description: String(values.get('description') ?? '').trim() || null,
    };
    const project = attempt.current;
    setSaving(true);
    setError('');
    try {
      await createProject(client, owner, project);
      onOpen(project);
    } catch {
      setError('Impossibile creare il progetto. Riprova.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="projects-title">
      <div className="section-heading">
        <h1 id="projects-title">Progetti</h1>
        {!editing && <button className="primary" type="button" onClick={() => setEditing(true)}>Nuovo progetto</button>}
      </div>
      {editing && (
        <form className="project-form project-create" onSubmit={(event) => void save(event)} onChange={() => {
          attempt.current = null;
          setError('');
        }}>
          <label htmlFor="project-name">Nome</label>
          <input id="project-name" autoFocus value={name} required maxLength={80} disabled={saving} onChange={(event) => setName(event.target.value)} />
          <label htmlFor="project-description">Descrizione (facoltativa)</label>
          <textarea id="project-description" name="description" maxLength={2000} rows={2} disabled={saving} />
          {error && <p className="feedback error" role="alert">{error}</p>}
          <div className="project-actions">
            <button className="primary" disabled={saving || !name.trim()}>{saving ? 'Creazione…' : 'Crea progetto'}</button>
            <button className="quiet" disabled={saving} type="button" onClick={() => {
              attempt.current = null;
              setName('');
              setError('');
              setEditing(false);
            }}>Annulla</button>
          </div>
        </form>
      )}
      {loadError && <p className="feedback error" role="alert">
        Impossibile caricare i progetti. <button className="quiet" type="button" onClick={reload}>Riprova</button>
      </p>}
      {!projects && !loadError && <p className="inbox-empty" role="status">Caricamento…</p>}
      {projects?.length === 0 && !editing && <p className="empty-state">Crea un progetto per raggruppare note e link.</p>}
      <ul className="items">
        {projects?.map((project) => (
          <li key={project.id} className="item project-card">
            <button className="project-title quiet" type="button" onClick={() => onOpen(project)}>{project.name}</button>
            <p className="classification">{projectStatus[project.status]}</p>
            {project.description && <p className="project-description">{project.description}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ProjectLinkDialog({ client, owner, itemId, onClose, onOpenProjects, onLinked }: AccountProps & {
  itemId: string;
  onClose: () => void;
  onOpenProjects: () => void;
  onLinked: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { projects: allProjects, loadError, reload } = useProjects(client, owner);
  const projects = allProjects?.filter((project) => project.status === 'active');
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [linked, setLinked] = useState('');

  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement;
    element.showModal();
    return () => {
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  async function link(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const selected = projects?.find((project) => project.id === projectId);
    if (busy || !selected) return;
    setBusy(true);
    setError(false);
    setLinked('');
    try {
      await linkProjectItem(client, owner, selected.id, itemId);
      setLinked(`Collegato a ${selected.name}.`);
      onLinked();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog className="project-dialog" ref={dialog} aria-labelledby="link-title" onCancel={(event) => {
      event.preventDefault();
      if (!busy) onClose();
    }}>
      <h2 id="link-title">Collega a progetto</h2>
      {loadError && <p className="feedback error" role="alert">
        Impossibile caricare i progetti. <button className="quiet" type="button" onClick={reload}>Riprova</button>
      </p>}
      {!projects && !loadError && <p role="status">Caricamento…</p>}
      {projects?.length === 0 && <p>Puoi iniziare creando un progetto.</p>}
      {!!projects?.length && <form className="project-form" onSubmit={(event) => void link(event)}>
        <label htmlFor="link-project">Progetto</label>
        <select id="link-project" autoFocus value={projectId} disabled={busy} onChange={(event) => {
          setProjectId(event.target.value);
          setLinked('');
          setError(false);
        }}>
          <option value="" disabled>Scegli un progetto</option>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
        {error && <p className="feedback error" role="alert">Impossibile collegare la nota. Riprova.</p>}
        <p className="feedback" role="status" hidden={!linked}>{linked}</p>
        <button className="primary" disabled={busy || !projectId}>{busy ? 'Collegamento…' : 'Collega'}</button>
      </form>}
      <div className="project-actions">
        {projects?.length === 0 && <button className="primary" type="button" onClick={onOpenProjects}>Vai a Progetti</button>}
        <button className="quiet" type="button" disabled={busy} onClick={onClose}>Chiudi</button>
      </div>
    </dialog>
  );
}

export function ProjectEditor({ client, owner, project, onUpdated, onClose }: AccountProps & {
  project: Project; onUpdated: (project: Project) => void; onClose: () => void;
}) {
  return <ItemDialog title="Modifica progetto" confirm="Salva progetto" onClose={onClose} onConfirm={async (data) => {
    const name = String(data.get('name') ?? '').trim();
    if (!name) throw new FormError('Scrivi il nome del progetto.');
    const changed: Project = {
      ...project, name, description: String(data.get('description') ?? '').trim() || null,
      status: data.get('status') as Project['status'],
    };
    if (!await updateProject(client, owner, changed)) return false;
    onUpdated(changed);
    return true;
  }}>
    <label htmlFor="rename-project">Nome</label>
    <input id="rename-project" name="name" required maxLength={80} autoFocus defaultValue={project.name} />
    <label htmlFor="describe-project">Descrizione</label>
    <textarea id="describe-project" name="description" maxLength={2000} defaultValue={project.description ?? ''} />
    <label htmlFor="project-status">Stato</label>
    <select id="project-status" name="status" defaultValue={project.status}>
      {Object.entries(projectStatus).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select>
  </ItemDialog>;
}
