import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { StashClient } from '../../supabase.ts';
import { Inbox } from '../inbox/Inbox.tsx';
import { intentionLabels, kindLabels, statusLabels, type Filters } from '../items/items.ts';
import { listProjects, type Project } from '../projects/projects.ts';

export function Library({ client, owner, revision, focusSearch, onChanged, onLink, onHome }: {
  client: StashClient; owner: string; revision: number; focusSearch: boolean;
  onChanged: () => void; onLink: (id: string) => void; onHome: () => void;
}) {
  const [filters, setFilters] = useState<Filters>({});
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectError, setProjectError] = useState(false);
  const [projectRetry, retryProjects] = useState(0);
  const form = useRef<HTMLFormElement>(null);
  const query = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusSearch) query.current?.focus();
  }, [focusSearch]);

  useEffect(() => {
    let active = true;
    void listProjects(client, owner).then((rows) => {
      if (active) {
        setProjects(rows);
        setProjectError(false);
      }
    }, () => { if (active) setProjectError(true); });
    return () => { active = false; };
  }, [client, owner, revision, projectRetry]);

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const values = Object.fromEntries(Object.entries(Object.fromEntries(data)).filter(([, value]) => !!value));
    setFilters(values as Filters);
  }

  const applied = [
    filters.query && `Ricerca «${filters.query}»`,
    filters.format && ({ text: 'Testo', link: 'Link', file: 'Con allegati' } as Record<string, string>)[filters.format],
    filters.kind && kindLabels[filters.kind as keyof typeof kindLabels],
    filters.intention && intentionLabels[filters.intention as keyof typeof intentionLabels],
    filters.project && (projects.find((project) => project.id === filters.project)?.name ?? 'Progetto'),
    filters.tag && `Tag «${filters.tag}»`,
    filters.status && statusLabels[filters.status as keyof typeof statusLabels],
  ].filter(Boolean);

  return <>
    <h1>Libreria</h1>
    <form ref={form} className="project-form library-search" onSubmit={search} onReset={() => setFilters({})}>
      <label htmlFor="library-query">Cerca nelle note salvate</label>
      <div className="search-row"><input ref={query} type="search" name="query" id="library-query" placeholder="Testo, link, progetto, tag o nome file" maxLength={200} />
        <button className="primary">Cerca</button>
      </div>
      <details className="filters">
        <summary>Filtri</summary>
        <div className="filter-fields">
          <label>Formato<select name="format"><option value="">Tutti</option><option value="text">Testo</option>
            <option value="link">Link</option><option value="file">Con allegati</option></select></label>
          <label>Tipo<select name="kind"><option value="">Tutti</option>
            {Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
          <label>Intenzione<select name="intention"><option value="">Tutte</option>
            {Object.entries(intentionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
          <label>Progetto<select name="project"><option value="">Tutti</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select></label>
          <label>Tag<input name="tag" maxLength={40} /></label>
          <label>Classificazione<select name="status"><option value="">Tutte</option>
            {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
        </div>
        {projectError && <div className="inline-feedback">
          <p className="feedback error" role="alert">Impossibile caricare i filtri per progetto.</p>
          <button className="quiet" type="button" onClick={() => retryProjects((value) => value + 1)}>Riprova</button>
        </div>}
      </details>
      {applied.length > 0 && <div className="project-actions">
        <ul className="tags" aria-label="Ricerca e filtri attivi">
          {applied.map((label, index) => <li key={index}>{label}</li>)}
        </ul>
        <button className="quiet" type="reset">Azzera ricerca e filtri</button>
      </div>}
    </form>
    <Inbox key={JSON.stringify(filters)} client={client} owner={owner} revision={revision} filters={filters}
      onLink={onLink} onChanged={onChanged} onEmpty={onHome} onReset={() => form.current?.reset()} />
  </>;
}
