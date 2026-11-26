import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { Session } from '@supabase/supabase-js';
import { Icon } from './components/Icon.tsx';
import { useSectionSwipe } from './components/section-swipe.ts';
import { ItemDialog } from './features/items/ItemDialog.tsx';
import { makeCapture, maxCaptureLength, type Capture } from './features/capture/capture.ts';
import { claimShare, removeShare } from './features/capture/shared-draft.ts';
import { acceptedFiles, prepareFiles, uploadFile, type Upload } from './features/files/files.ts';
import { Trash } from './features/items/Trash.tsx';
import { Library } from './features/library/Library.tsx';
import { Tasks } from './features/tasks/Tasks.tsx';
import { Inbox } from './features/inbox/Inbox.tsx';
import { Clarifications } from './features/remember/Clarifications.tsx';
import { Memories } from './features/remember/Memories.tsx';
import { ProjectEditor, ProjectLinkDialog, Projects } from './features/projects/Projects.tsx';
import { projectStatus, type Project } from './features/projects/projects.ts';
import { saveCapture, type StashClient } from './supabase.ts';

const sections = [
  ['inbox', 'Home', 'home'], ['library', 'Libreria', 'library'], ['projects', 'Progetti', 'projects'],
  ['tasks', 'Task', 'tasks'], ['trash', 'Cestino', 'trash'],
] as const;
type Section = typeof sections[number][0];

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
    <section className="capture access" aria-labelledby="login-title">
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
  const [sending, setSending] = useState<Capture['capture_source'] | null>(null);
  const busy = sending !== null;
  const [feedback, setFeedback] = useState({ message: '', error: false });
  const [shareFeedback, setShareFeedback] = useState({ message: '', error: false });
  const [discard, setDiscard] = useState<'manual' | 'share' | null>(null);
  const [revision, setRevision] = useState(0);
  const [view, setView] = useState<Project | Section>('inbox');
  const [focusSearch, setFocusSearch] = useState(false);
  const content = useRef<HTMLElement>(null);
  const capture = useRef<HTMLTextAreaElement>(null);
  const project = typeof view === 'object' ? view : null;
  const [editProject, setEditProject] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [savedWithPending, setSavedWithPending] = useState(false);
  const changed = useCallback(() => setRevision((value) => value + 1), []);
  const [linkItemId, setLinkItemId] = useState<string | null>(null);
  const [aiAllowed, setAiAllowed] = useState(() => applyPreference(owner));
  const preference = useRef(aiAllowed);
  const inFlight = useRef(false);
  const manualDraft = useRef<Capture | null>(null);
  const navigate = useCallback((section: Section, search = false) => {
    setEditProject(false);
    setFocusSearch(search);
    setView(section);
  }, []);
  const swipe = useCallback((step: -1 | 1) => {
    const index = sections.findIndex(([id]) => id === view);
    const next = index >= 0 ? sections[index + step] : undefined;
    if (next) navigate(next[0]);
  }, [navigate, view]);
  useSectionSwipe(content, !project, swipe);

  function resetDraft() {
    manualDraft.current = null;
    setText('');
    setUploads([]);
    setSavedWithPending(false);
  }

  const save = useCallback(async (draft: Capture, files: Upload[] = [], allowAI = preference.current) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(draft.capture_source);
    const setStatus = draft.capture_source === 'share' ? setShareFeedback : setFeedback;
    setStatus({ message: 'Salvataggio…', error: false });
    try {
      await saveCapture(client, owner, draft, allowAI);
      changed();
      if (files.length) {
        setStatus({ message: 'Nota salvata. Caricamento allegati…', error: false });
        const remaining: Upload[] = [];
        for (const file of files) {
          try { await uploadFile(client, draft.id, file); }
          catch { remaining.push(file); }
        }
        changed();
        if (remaining.length) {
          setUploads(remaining);
          setSavedWithPending(true);
          setStatus({ message: 'Nota salvata. Alcuni allegati sono da completare.', error: true });
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
        setSavedWithPending(false);
      }
      setStatus({ message: files.length ? 'Nota e allegati salvati.' : 'Nota salvata.', error: false });
    } catch {
      setStatus({ message: 'Invio da completare. Controlla la connessione e riprova.', error: true });
    } finally {
      inFlight.current = false;
      setSending(null);
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
        setShareFeedback({ message: 'Condivisione non ricevuta. Puoi incollare qui il testo o il link.', error: true });
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
        setShareFeedback({ message: 'Condivisione da salvare.', error: false });
        await save(draft);
      } catch {
        if (active && location.hash === hash) {
          setShared(null);
          setShareFeedback({ message: 'Condivisione non disponibile per questo account. Condividi di nuovo.', error: true });
        }
      }
    }
    function handleShare() { void receive(); }
    window.addEventListener('hashchange', handleShare);
    void receive();
    return () => { active = false; window.removeEventListener('hashchange', handleShare); };
  }, [owner, save]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || shared) return;
    try {
      const fileOnly = !text.trim() && !!uploads.length;
      manualDraft.current ??= makeCapture(fileOnly ? uploads[0].file.name : text, 'manual');
      void save(manualDraft.current, uploads, preference.current && !fileOnly);
    } catch {
      setFeedback({ message: 'Scrivi o incolla il testo da salvare.', error: true });
    }
  }

  async function discardShare(draft: Capture) {
    if (inFlight.current) return false;
    inFlight.current = true;
    setSending('share');
    try {
      await removeShare(draft.id);
      if (location.hash === `#share=${draft.id}`) history.replaceState(null, '', location.pathname);
      setShared((value) => value?.id === draft.id ? null : value);
      setShareFeedback({ message: 'Condivisione rimossa da questo dispositivo.', error: false });
      return true;
    } finally {
      inFlight.current = false;
      setSending(null);
    }
  }

  const notice = sending === 'share' || shared ? shareFeedback
    : sending === 'manual' || savedWithPending || feedback.error ? feedback : shareFeedback;

  return (
    <>
      <header className="topbar">
        <Brand />
        <div className="header-actions">
          {view === 'inbox' && (
            <button className="icon-button search-button" type="button" aria-label="Cerca in Libreria"
              onClick={() => navigate('library', true)}><Icon name="search" /></button>
          )}
          <button className="quiet" type="button" disabled={busy} onClick={onSignOut}>Esci</button>
        </div>
      </header>
      {view !== 'inbox' && (sending || shared || savedWithPending || feedback.error || shareFeedback.error) && (
        <div className="capture-notice">
          <p role="status">{notice.message || 'Invio da completare.'}</p>
          <button className="quiet" type="button" onClick={() => navigate('inbox')}>Vai alla Home</button>
        </div>
      )}
      <main ref={content}>
        {view === 'inbox' && <>
          {(shared || shareFeedback.message) && <section className="capture share-card" aria-label="Condivisione">
            {shared && <>
              <h2>Condivisione ricevuta</h2>
              <p className="original">{shared.raw_text}</p>
              <div className="project-actions">
                <button className="primary" type="button" disabled={busy} onClick={() => void save(shared)}>
                  {shareFeedback.error ? 'Riprova salvataggio' : 'Salva condivisione'}
                </button>
                <button className="quiet" type="button" disabled={busy} onClick={() => setDiscard('share')}>Scarta invio</button>
              </div>
            </>}
            <p role={shareFeedback.error ? 'alert' : 'status'} className={shareFeedback.error ? 'feedback error' : 'feedback'}>
              {shareFeedback.message}
            </p>
          </section>}
          <section className="capture composer" aria-labelledby="capture-title">
            <h1 id="capture-title">Salva al volo</h1>
            <form className="capture-form" onSubmit={submit}>
              <label htmlFor="capture">Testo o link</label>
              <textarea ref={capture} id="capture" rows={2} placeholder="Scrivi una nota o incolla un link…"
                maxLength={maxCaptureLength} value={text} readOnly={busy || savedWithPending} onChange={(event) => {
                  manualDraft.current = null;
                  setText(event.target.value);
                }} />
              {!!uploads.length && <ul className="draft-files" aria-label={savedWithPending ? 'Allegati da completare' : 'File selezionati'}>
                {uploads.map(({ id, file }) => <li key={id}>
                  <span>{file.name}</span>
                  {!savedWithPending && <button className="icon-button" type="button" disabled={busy}
                    aria-label={`Rimuovi ${file.name}`} onClick={() => {
                      manualDraft.current = null;
                      setUploads((entries) => entries.filter((entry) => entry.id !== id));
                    }}><Icon name="close" /></button>}
                </li>)}
              </ul>}
              <div className="capture-actions">
                {!savedWithPending && <div className="composer-tools">
                  <label className="quiet file-picker">
                    <input className="sr-only" type="file" accept={acceptedFiles} multiple disabled={busy} onChange={(event) => {
                      try {
                        const files = prepareFiles(event.target.files ?? [], uploads.length);
                        if (files.length) {
                          manualDraft.current = null;
                          setUploads((entries) => [...entries, ...files]);
                          setFeedback({ message: '', error: false });
                        }
                      } catch (failure) {
                        setFeedback({ message: failure instanceof Error ? failure.message : 'File non disponibile.', error: true });
                      }
                      event.target.value = '';
                    }} />
                    <Icon name="clip" /> Allega
                  </label>
                  {(text || !!uploads.length) && <button className="icon-button" type="button" disabled={busy}
                    aria-label="Svuota bozza" onClick={() => setDiscard('manual')}><Icon name="close" /></button>}
                </div>}
                {savedWithPending && <button type="button" className="quiet" disabled={busy} onClick={() => {
                  resetDraft();
                  setFeedback({ message: 'Per completare i file, apri Gestisci allegati dalla nota salvata.', error: false });
                }}>Completa più tardi</button>}
                <button className="primary save-button" disabled={busy || !!shared || (!text.trim() && !uploads.length)}>
                  {sending === 'manual' ? 'Salvataggio…' : savedWithPending ? 'Riprova allegati'
                    : feedback.error && manualDraft.current ? 'Riprova salvataggio' : 'Salva'}
                  <Icon name="arrow" />
                </button>
              </div>
              <label className="consent">
                <input type="checkbox" checked={aiAllowed} disabled={busy || savedWithPending}
                  aria-labelledby="capture-ai-label" aria-describedby="capture-ai-hint" onChange={(event) => {
                    preference.current = event.target.checked;
                    applyPreference(owner, preference.current);
                    setAiAllowed(preference.current);
                  }} />
                <span>
                  <span id="capture-ai-label">Classifica i prossimi salvataggi con l’AI</span>
                  <span id="capture-ai-hint" className="consent-hint">Testo e link possono essere inviati a un servizio esterno.</span>
                </span>
              </label>
              <p role={feedback.error ? 'alert' : 'status'} className={feedback.error ? 'feedback error' : 'feedback'}>{feedback.message}</p>
            </form>
          </section>
          <Clarifications client={client} owner={owner} revision={revision} onChanged={changed} />
          <Memories client={client} revision={revision} />
          <Inbox client={client} owner={owner} revision={revision} onChanged={changed} onLink={setLinkItemId}
            recent={{ onAll: () => navigate('library'), onWrite: () => capture.current?.focus() }} />
        </>}
        {view === 'library' && <Library client={client} owner={owner} revision={revision} focusSearch={focusSearch}
          onChanged={changed} onLink={setLinkItemId} onHome={() => navigate('inbox')} />}
        {view === 'tasks' && <Tasks client={client} owner={owner} revision={revision} onLibrary={() => navigate('library')} />}
        {view === 'trash' && <Trash client={client} onRestored={changed} />}
        {view === 'projects' && <Projects client={client} owner={owner}
          onOpen={(opened) => setView((value) => value === 'projects' ? opened : value)} />}
        {project && <>
          <section className="project-intro" aria-labelledby="project-title">
            <div className="project-actions">
              <button className="quiet project-title" type="button" onClick={() => navigate('projects')}>‹ Tutti i progetti</button>
              <button className="quiet" type="button" onClick={() => setEditProject(true)}>Modifica progetto</button>
            </div>
            <h1 id="project-title" className="project-description">{project.name}</h1>
            <p className="classification">{projectStatus[project.status]}</p>
            {project.description && <p className="project-description">{project.description}</p>}
          </section>
          <Tasks key={`tasks-${project.id}`} client={client} owner={owner} revision={revision} project={project.id} />
          <Inbox key={project.id} client={client} owner={owner} revision={revision}
            project={{ id: project.id, name: project.name }} onChanged={changed} onLink={setLinkItemId}
            onEmpty={() => navigate('library')} />
          {editProject && <ProjectEditor client={client} owner={owner} project={project} onUpdated={(updated) => {
            setView(updated);
            changed();
          }} onClose={() => setEditProject(false)} />}
        </>}
      </main>
      <nav className="workspace-nav" aria-label="Sezioni di Stash">
        {sections.map(([value, label, icon]) => <button key={value} type="button"
          aria-current={(project ? 'projects' : view) === value ? 'page' : undefined}
          onClick={() => navigate(value)}><Icon name={icon} />{label}</button>)}
      </nav>
      {linkItemId && <ProjectLinkDialog key={linkItemId} client={client} owner={owner} itemId={linkItemId}
        onClose={() => setLinkItemId(null)} onLinked={changed} onOpenProjects={() => {
          setLinkItemId(null);
          navigate('projects');
        }} />}
      {discard === 'manual' && <ItemDialog title="Svuota bozza" confirm="Svuota" danger onClose={() => setDiscard(null)}
        onConfirm={async () => {
          resetDraft();
          setFeedback({ message: '', error: false });
          requestAnimationFrame(() => capture.current?.focus());
          return true;
        }}><p>Il testo e i file selezionati verranno rimossi dalla bozza.</p></ItemDialog>}
      {discard === 'share' && shared && <ItemDialog title="Scarta invio" confirm="Scarta" danger onClose={() => setDiscard(null)}
        onConfirm={() => discardShare(shared)}><p>Rimuovi questo tentativo di condivisione dal dispositivo.</p></ItemDialog>}
    </>
  );
}

function Brand() {
  return <img className="brand" src="/stash-logo.png" alt="Stash" width="67" height="76" />;
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
        {!client ? <section className="capture access"><h1>Configura Stash</h1><p>Stash non è configurato su questa installazione.</p></section>
          : session === undefined ? <p role="status">Verifica sessione…</p> : <Login client={client} />}
      </main>
    </div>
  );
}
