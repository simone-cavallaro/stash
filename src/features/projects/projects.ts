import type { StashClient } from '../../supabase.ts';

export type Project = { id: string; name: string; description: string | null };

export async function listProjects(client: StashClient, owner: string) {
  const projects: Project[] = [];
  const pageSize = 100;
  for (;;) {
    let query = client.from('projects').select('id,name,description').eq('user_id', owner).order('id').limit(pageSize);
    const cursor = projects.at(-1);
    if (cursor) query = query.gt('id', cursor.id);
    const { data, error } = await query.overrideTypes<Project[], { merge: false }>();
    if (error) throw error;
    projects.push(...data);
    if (data.length < pageSize) break;
  }
  return projects.sort((a, b) => a.name.localeCompare(b.name, 'it') || a.id.localeCompare(b.id));
}

export async function createProject(client: StashClient, owner: string, project: Project) {
  const { error } = await client.from('projects').upsert({ ...project, user_id: owner },
    { onConflict: 'user_id,id', ignoreDuplicates: true });
  if (error) throw error;
}

export async function linkProjectItem(client: StashClient, owner: string, projectId: string, itemId: string) {
  const { error } = await client.from('project_items')
    .upsert({ user_id: owner, project_id: projectId, item_id: itemId },
      { onConflict: 'user_id,project_id,item_id', ignoreDuplicates: true });
  if (error) throw error;
}

export async function unlinkProjectItem(client: StashClient, owner: string, projectId: string, itemId: string) {
  const { error } = await client.from('project_items').delete()
    .eq('user_id', owner).eq('project_id', projectId).eq('item_id', itemId);
  if (error) throw error;
}
