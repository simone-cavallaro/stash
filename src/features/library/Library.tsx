import { useEffect, useState, type FormEvent } from 'react';
import type { StashClient } from '../../supabase.ts';
import { Inbox } from '../inbox/Inbox.tsx';
import { intentionLabels, kindLabels, statusLabels, type Filters } from '../items/items.ts';
import { listProjects, type Project } from '../projects/projects.ts';

export function Library({ client, owner, revision, onChanged, onLink }: {
  client: StashClient; owner: string; revision: number; onChanged: () => void; onLink: (id: string) => void;
}) {
  const [filters, setFilters] = useState<Filters>({});
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectError, setProjectError] = useState(false);

  useEffect(() => {
    let active = true;
    void listProjects(client, owner).then((rows) => {
      if (active) {
        setProjects(rows);
        setProjectError(false);
      }
    }, () => { if (active) setProjectError(true); });
    return () => { active = false; };
  }, [client, owner, revision]);

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const values = Object.fromEntries(Object.entries(Object.fromEntries(data)).filter(([, value]) => !!value));
    setFilters(values as Filters);
  }

  return <>
    <h1>Libreria</h1>
    <form className="project-form" onSubmit={search} onReset={() => setFilters({})}>
      <label htmlFor="library-query">Cerca nelle note salvate</label>
      <input type="search" name="query" id="library-query" placeholder="Testo, link, progetto, tag o nome file" maxLength={200} />
      <details className="attachments">
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
        {projectError && <p className="feedback error" role="alert">Impossibile caricare i filtri per progetto.</p>}
      </details>
      <div className="project-actions">
        <button className="primary">Cerca</button>
        <button className="quiet" type="reset">Azzera</button>
      </div>
    </form>
    <Inbox key={JSON.stringify(filters)} client={client} owner={owner} revision={revision} filters={filters}
      onLink={onLink} onChanged={onChanged} />
  </>;
}
