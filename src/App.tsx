import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { Session } from '@supabase/supabase-js';
import { makeCapture, maxCaptureLength, type Capture } from './features/capture/capture.ts';
import { claimShare, removeShare } from './features/capture/shared-draft.ts';
import { acceptedFiles, prepareFiles, uploadFile, type Upload } from './features/files/files.ts';
import { Trash } from './features/items/Trash.tsx';
import { Library } from './features/library/Library.tsx';
import { Tasks } from './features/tasks/Tasks.tsx';
import { Inbox } from './features/inbox/Inbox.tsx';
import { ProjectEditor, ProjectLinkDialog, Projects } from './features/projects/Projects.tsx';
import { projectStatus, type Project } from './features/projects/projects.ts';
import { saveCapture, type StashClient } from './supabase.ts';

function applyPreference(owner: string, value?: boolean) {
  try {
    const key = `stash.ai.${owner}`;
    if (value !== undefined) localStorage.setItem(key, String(value));
    return localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}

function Login({ client }: { client: StashClient }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const values = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      const { error } = await client.auth.signInWithPassword({
        email: String(values.get('email')).trim(), password: String(values.get('password')),
      });
      if (error) throw error;
    } catch {
      setError('Accesso non riuscito. Controlla email, password e connessione.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="capture" aria-labelledby="login-title">
      <h1 id="login-title">Accedi a Stash</h1>
      {location.hash.startsWith('#share=') && <p>Accedi per salvare quello che hai condiviso.</p>}
      <form onSubmit={(event) => void login(event)}>
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="username" required />
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required />
        {error && <p role="alert" className="feedback error">{error}</p>}
        <button className="primary" disabled={busy}>{busy ? 'Accesso…' : 'Accedi'}</button>
      </form>
    </section>
  );
}

function Workspace({ client, owner, onSignOut }: { client: StashClient; owner: string; onSignOut: () => void }) {
  const [text, setText] = useState('');
  const [shared, setShared] = useState<Capture | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState({ message: '', error: false });
  const [revision, setRevision] = useState(0);
  const [view, setView] = useState<Project | 'inbox' | 'projects' | 'library' | 'tasks' | 'trash'>('inbox');
  const project = typeof view === 'object' ? view : null;
  const [editProject, setEditProject] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [savedWithPending, setSavedWithPending] = useState(false);
  const [pickerRevision, resetPicker] = useState(0);
  const changed = useCallback(() => setRevision((value) => value + 1), []);
  const [linkItemId, setLinkItemId] = useState<string | null>(null);
  const [aiAllowed, setAiAllowed] = useState(() => applyPreference(owner));
  const preference = useRef(aiAllowed);
  const inFlight = useRef(false);
  const manualDraft = useRef<Capture | null>(null);

  const save = useCallback(async (draft: Capture, files: Upload[] = [], allowAI = preference.current) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFeedback({ message: '', error: false });
    try {
      await saveCapture(client, owner, draft, allowAI);
      changed();
      if (files.length) {
        setFeedback({ message: 'Caricamento allegati…', error: false });
        const remaining: Upload[] = [];
        for (const file of files) {
          try { await uploadFile(client, draft.id, file); }
          catch { remaining.push(file); }
        }
        changed();
        if (remaining.length) {
          setUploads(remaining);
          setSavedWithPending(true);
          setFeedback({ message: 'Nota salvata. Alcuni allegati sono da completare.', error: true });
          return;
        }
      }
      if (draft.capture_source === 'share') {
        await removeShare(draft.id).catch(() => undefined);
        if (location.hash === `#share=${draft.id}`) history.replaceState(null, '', location.pathname);
        setShared((value) => value?.id === draft.id ? null : value);
      } else {
        manualDraft.current = null;
        setText('');
        setUploads([]);
        resetPicker((value) => value + 1);
        setSavedWithPending(false);
      }
      setFeedback({ message: 'Salvato nell’Inbox.', error: false });
    } catch {
      setFeedback({ message: 'Invio da completare. Controlla la connessione e riprova.', error: true });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [changed, client, owner]);

  useEffect(() => {
    let active = true;
    async function receive() {
      const hash = location.hash;
      if (hash === '#share-error') {
        setView('inbox');
        setEditProject(false);
        setLinkItemId(null);
        history.replaceState(null, '', location.pathname);
        setFeedback({ message: 'Condivisione non ricevuta. Puoi incollare qui il testo o il link.', error: true });
        return;
      }
      const id = /^#share=([a-f\d-]{36})$/i.exec(hash)?.[1];
      if (!id) return;
      setView('inbox');
      setEditProject(false);
      setLinkItemId(null);
      try {
        const draft = await claimShare(id, owner);
        if (!active || location.hash !== hash) return;
        if (!draft) throw new Error('draft_unavailable');
        setShared(draft);
        await save(draft);
      } catch {
        if (active) setFeedback({ message: 'Condivisione non disponibile per questo account.', error: true });
      }
    }
    function handleShare() { void receive(); }
    window.addEventListener('hashchange', handleShare);
    void receive();
    return () => { active = false; window.removeEventListener('hashchange', handleShare); };
  }, [owner, save]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    if (shared) {
      void save(shared);
      return;
    }
    try {
      const fileOnly = !text.trim() && !!uploads.length;
      manualDraft.current ??= makeCapture(fileOnly ? uploads[0].file.name : text, 'manual');
      void save(manualDraft.current, uploads, preference.current && !fileOnly);
    } catch {
      setFeedback({ message: 'Scrivi o incolla il testo da salvare.', error: true });
    }
  }

  async function discardShare(draft: Capture) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await removeShare(draft.id);
      if (location.hash === `#share=${draft.id}`) history.replaceState(null, '', location.pathname);
      setShared((value) => value?.id === draft.id ? null : value);
      setFeedback({ message: 'Condivisione rimossa da questo dispositivo.', error: false });
    } catch {
      setFeedback({ message: 'Impossibile rimuovere la condivisione. Riprova.', error: true });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <header className="topbar">
        <Brand />
        <button className="quiet" type="button" disabled={busy} onClick={onSignOut}>Esci</button>
      </header>
      <nav className="workspace-nav" aria-label="Sezioni di Stash">
        {([
          ['inbox', 'Inbox'], ['library', 'Libreria'], ['projects', 'Progetti'], ['tasks', 'Task'], ['trash', 'Cestino'],
        ] as const).map(([value, label]) => <button key={value} className="quiet" type="button"
          aria-current={(project ? 'projects' : view) === value ? 'page' : undefined}
          onClick={() => {
            setEditProject(false);
            setView(value);
          }}>{label}</button>)}
      </nav>
      <main>
        {view === 'inbox' && <section className="capture" aria-labelledby="capture-title">
          <h1 id="capture-title">Salva al volo</h1>
          <form onSubmit={submit}>
            <label className="sr-only" htmlFor="capture">Testo o link</label>
            <textarea id="capture" rows={4} placeholder="Scrivi una nota o incolla un link…" maxLength={maxCaptureLength}
              value={shared?.raw_text ?? text} readOnly={busy || !!shared || savedWithPending} onChange={(event) => {
                manualDraft.current = null;
                setText(event.target.value);
              }} />
            {!shared && <>
              <label htmlFor="capture-files">Allegati (facoltativi)</label>
              <input key={pickerRevision} type="file" id="capture-files" accept={acceptedFiles} multiple
                disabled={busy || savedWithPending} onChange={(event) => {
                  manualDraft.current = null;
                  try {
                    setUploads(prepareFiles(event.target.files ?? []));
                    setFeedback({ message: '', error: false });
                  } catch (failure) {
                    setUploads([]);
                    event.target.value = '';
                    setFeedback({ message: failure instanceof Error ? failure.message : 'File non disponibile.', error: true });
                  }
                }} />
              {!!uploads.length && <ul className="file-list" aria-label="File selezionati">
                {uploads.map(({ id, file }) => <li key={id}>{file.name}</li>)}
              </ul>}
            </>}
            <label className="consent">
              <input type="checkbox" checked={aiAllowed} disabled={busy || savedWithPending} onChange={(event) => {
                preference.current = event.target.checked;
                applyPreference(owner, preference.current);
                setAiAllowed(preference.current);
              }} />
              <span>Classifica i prossimi salvataggi con Groq</span>
            </label>
            <div className="capture-actions">
              <button className="primary" disabled={busy || (!(shared?.raw_text ?? text).trim() && !uploads.length)}>
                {busy ? 'Salvataggio…' : shared ? 'Riprova salvataggio' : savedWithPending ? 'Riprova allegati' : 'Salva'}
              </button>
              {savedWithPending && !shared && <button type="button" className="quiet" disabled={busy} onClick={() => {
                manualDraft.current = null;
                setText('');
                setUploads([]);
                resetPicker((value) => value + 1);
                setSavedWithPending(false);
                setFeedback({ message: 'Puoi completare gli allegati dalla nota nell’Inbox.', error: false });
              }}>Completa più tardi</button>}
              {shared && <button className="quiet" type="button" disabled={busy} onClick={() => void discardShare(shared)}>Scarta invio</button>}
              <p role="status" className={feedback.error ? 'feedback error' : 'feedback'}>{feedback.message}</p>
            </div>
          </form>
        </section>}
        {view === 'inbox' && <Inbox client={client} owner={owner} revision={revision} onChanged={changed} onLink={setLinkItemId} />}
        {view === 'library' && <Library client={client} owner={owner} revision={revision}
          onChanged={changed} onLink={setLinkItemId} />}
        {view === 'tasks' && <Tasks client={client} owner={owner} revision={revision} />}
        {view === 'trash' && <Trash client={client} onRestored={changed} />}
        {view === 'projects' && <Projects client={client} owner={owner}
          onOpen={(opened) => setView((value) => value === 'projects' ? opened : value)} />}
        {project && <>
          <section aria-labelledby="project-title">
            <div className="project-actions">
              <button className="quiet project-title" type="button" onClick={() => setView('projects')}>Tutti i progetti</button>
              <button className="quiet" type="button" onClick={() => setEditProject(true)}>Modifica progetto</button>
            </div>
            <h1 id="project-title" className="project-description">{project.name}</h1>
            <p className="classification">{projectStatus[project.status]}</p>
            {project.description && <p className="project-description">{project.description}</p>}
          </section>
          <Tasks key={`tasks-${project.id}`} client={client} owner={owner} revision={revision} project={project.id} />
          <Inbox key={project.id} client={client} owner={owner} revision={revision}
            projectId={project.id} onChanged={changed} onLink={setLinkItemId} />
          {editProject && <ProjectEditor client={client} owner={owner} project={project} onUpdated={(updated) => {
            setView(updated);
            changed();
          }} onClose={() => setEditProject(false)} />}
        </>}
      </main>
      {linkItemId && <ProjectLinkDialog key={linkItemId} client={client} owner={owner} itemId={linkItemId}
        onClose={() => setLinkItemId(null)} onLinked={changed} onOpenProjects={() => {
          setLinkItemId(null);
          setView('projects');
        }} />}
    </>
  );
}

function Brand() {
  return <div className="brand"><img src="/icon-192.png" alt="" width="36" height="36" />Stash</div>;
}

export function App({ client }: { client: StashClient | null }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!client) return;
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, [client]);

  async function signOut() {
    if (!client) return;
    try {
      const { error } = await client.auth.signOut({ scope: 'local' });
      if (error) throw error;
    } catch {
      setError('Impossibile uscire. Riprova.');
    }
  }

  if (client && session) return (
    <div className="shell">
      {error && <p className="feedback error" role="alert">{error}</p>}
      <Workspace key={session.user.id} client={client} owner={session.user.id} onSignOut={() => void signOut()} />
    </div>
  );
  return (
    <div className="shell">
      <header className="topbar"><Brand /></header>
      <main>
        {!client ? <section className="capture"><h1>Configura Stash</h1><p>Connessione a Supabase da configurare.</p></section>
          : session === undefined ? <p role="status">Caricamento…</p> : <Login client={client} />}
      </main>
    </div>
  );
}
