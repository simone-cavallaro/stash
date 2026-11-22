import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { Session } from '@supabase/supabase-js';
import { makeCapture, maxCaptureLength, type Capture } from './features/capture/capture.ts';
import { claimShare, removeShare } from './features/capture/shared-draft.ts';
import { Inbox } from './features/inbox/Inbox.tsx';
import { ProjectLinkDialog, Projects } from './features/projects/Projects.tsx';
import type { Project } from './features/projects/projects.ts';
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
  const [projectView, setProjectView] = useState<Project | 'list' | null>(null);
  const [linkItemId, setLinkItemId] = useState<string | null>(null);
  const [aiAllowed, setAiAllowed] = useState(() => applyPreference(owner));
  const preference = useRef(aiAllowed);
  const inFlight = useRef(false);
  const manualDraft = useRef<Capture | null>(null);

  const save = useCallback(async (draft: Capture) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFeedback({ message: '', error: false });
    try {
      await saveCapture(client, owner, draft, preference.current);
      if (draft.capture_source === 'share') {
        await removeShare(draft.id).catch(() => undefined);
        if (location.hash === `#share=${draft.id}`) history.replaceState(null, '', location.pathname);
        setShared((value) => value?.id === draft.id ? null : value);
      } else {
        manualDraft.current = null;
        setText('');
      }
      setRevision((value) => value + 1);
      setFeedback({ message: 'Salvato nell’Inbox.', error: false });
    } catch {
      setFeedback({ message: 'Invio da completare. Controlla la connessione e riprova.', error: true });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [client, owner]);

  useEffect(() => {
    let active = true;
    async function receive() {
      const hash = location.hash;
      if (hash === '#share-error') {
        setProjectView(null);
        setLinkItemId(null);
        history.replaceState(null, '', location.pathname);
        setFeedback({ message: 'Condivisione non ricevuta. Puoi incollare qui il testo o il link.', error: true });
        return;
      }
      const id = /^#share=([a-f\d-]{36})$/i.exec(hash)?.[1];
      if (!id) return;
      setProjectView(null);
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
      manualDraft.current ??= makeCapture(text, 'manual');
      void save(manualDraft.current);
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
        <button className="quiet" type="button" aria-current={projectView === null ? 'page' : undefined}
          onClick={() => setProjectView(null)}>Inbox</button>
        <button className="quiet" type="button" aria-current={projectView !== null ? 'page' : undefined}
          onClick={() => setProjectView('list')}>Progetti</button>
      </nav>
      <main>
        {projectView === null && <section className="capture" aria-labelledby="capture-title">
          <h1 id="capture-title">Salva al volo</h1>
          <form onSubmit={submit}>
            <label className="sr-only" htmlFor="capture">Testo o link</label>
            <textarea id="capture" rows={4} placeholder="Scrivi una nota o incolla un link…" maxLength={maxCaptureLength}
              value={shared?.raw_text ?? text} readOnly={busy || !!shared} onChange={(event) => {
                manualDraft.current = null;
                setText(event.target.value);
              }} />
            <label className="consent">
              <input type="checkbox" checked={aiAllowed} disabled={busy} onChange={(event) => {
                preference.current = event.target.checked;
                applyPreference(owner, preference.current);
                setAiAllowed(preference.current);
              }} />
              <span>Classifica i prossimi salvataggi con Groq</span>
            </label>
            <div className="capture-actions">
              <button className="primary" disabled={busy || !(shared?.raw_text ?? text).trim()}>
                {busy ? 'Salvataggio…' : shared ? 'Riprova salvataggio' : 'Salva'}
              </button>
              {shared && <button className="quiet" type="button" disabled={busy} onClick={() => void discardShare(shared)}>Scarta invio</button>}
              <p role="status" className={feedback.error ? 'feedback error' : 'feedback'}>{feedback.message}</p>
            </div>
          </form>
        </section>}
        {projectView === null && <Inbox client={client} owner={owner} revision={revision} onLink={setLinkItemId} />}
        {projectView === 'list' && <Projects client={client} owner={owner}
          onOpen={(project) => setProjectView((view) => view === 'list' ? project : view)} />}
        {projectView && projectView !== 'list' && <>
          <section aria-labelledby="project-title">
            <button className="quiet project-title" type="button" onClick={() => setProjectView('list')}>Tutti i progetti</button>
            <h1 id="project-title" className="project-description">{projectView.name}</h1>
            {projectView.description && <p className="project-description">{projectView.description}</p>}
          </section>
          <Inbox key={projectView.id} client={client} owner={owner} revision={revision} projectId={projectView.id} />
        </>}
      </main>
      {linkItemId && <ProjectLinkDialog key={linkItemId} client={client} owner={owner} itemId={linkItemId}
        onClose={() => setLinkItemId(null)} onOpenProjects={() => {
          setLinkItemId(null);
          setProjectView('list');
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
