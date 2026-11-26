import type { Intention, Kind } from '../../../supabase/functions/_shared/item-types.ts';
import type { Capture } from '../capture/capture.ts';
import type { ItemFile } from '../files/files.ts';
import type { StashClient } from '../../supabase.ts';

export const kindLabels: Record<Kind, string> = {
  person: 'Persona', tool: 'Strumento', model: 'Modello', concept: 'Concetto',
  article: 'Articolo', document: 'Documento', idea: 'Idea', task: 'Azione', other: 'Altro',
};
export const intentionLabels: Record<Intention, string> = { remember: 'Da ricordare', explore: 'Da esplorare', act: 'Da fare' };
export const statusLabels = {
  off: 'AI disattivata', pending: 'In attesa', ready: 'Completata', failed: 'Non riuscita', skipped: 'Omessa',
} as const;

export type Overrides = {
  kind_override: Kind | null;
  intentions_override: Intention[] | null;
  tags_override: string[] | null;
};

export type OrganizedItem = Capture & Overrides & {
  captured_at: string;
  edited: boolean;
  revision: number;
  kind: Kind | null;
  intentions: Intention[];
  tags: string[];
  classification: { status: Exclude<keyof typeof statusLabels, 'off'>; result: { needs_clarification: boolean } | null } | null;
  clarification_available?: boolean;
  clarification_context?: string | null;
  project_suggestion: string | null;
  task_suggestion: string | null;
  files: ItemFile[];
};

export type Filters = {
  query?: string;
  project?: string;
  format?: string;
  kind?: string;
  intention?: string;
  tag?: string;
  status?: string;
};

export const pageSize = 30;

export async function listItems(client: StashClient, cursor?: OrganizedItem, filters?: Filters) {
  const { data, error } = await client.rpc('list_organized_items', {
    p_before: cursor?.captured_at ?? null, p_before_id: cursor?.id ?? null,
    p_project: filters?.project || null, p_query: filters?.query ?? '',
    p_format: filters?.format || null, p_kind: filters?.kind || null,
    p_intention: filters?.intention || null, p_tag: filters?.tag?.trim() || null, p_status: filters?.status || null,
  });
  if (error) throw error;
  return (data ?? []) as OrganizedItem[];
}

export async function editItem(client: StashClient, item: OrganizedItem, text: string, url: string | null, ai: boolean) {
  const { data, error } = await client.rpc('edit_item', {
    p_id: item.id, p_revision: item.revision, p_text: text, p_url: url, p_ai: ai,
  });
  if (error) throw error;
  return data === true;
}

export async function correctItem(client: StashClient, item: OrganizedItem, values: Overrides) {
  const { data, error } = await client.from('items').update(values)
    .eq('id', item.id).eq('revision', item.revision).select('id').maybeSingle();
  if (error) throw error;
  return !!data;
}

export async function trashItem(client: StashClient, item: OrganizedItem) {
  const { data, error } = await client.rpc('trash_item', { p_id: item.id, p_revision: item.revision });
  if (error) throw error;
  return data === true;
}

export type TrashedItem = { id: string; revision: number; text: string; trashed_at: string; expires_at: string };

export async function listTrash(client: StashClient, cursor?: TrashedItem) {
  const { data, error } = await client.rpc('list_trashed_items', {
    p_before: cursor?.trashed_at ?? null, p_before_id: cursor?.id ?? null,
  });
  if (error) throw error;
  return (data ?? []) as TrashedItem[];
}

export async function restoreItem(client: StashClient, item: TrashedItem) {
  const { data, error } = await client.rpc('restore_item', { p_id: item.id, p_revision: item.revision });
  if (error) throw error;
  return data === true;
}

export async function acceptSuggestion(client: StashClient, item: OrganizedItem, type: 'project' | 'task') {
  const { data, error } = await client.rpc('accept_item_suggestion', {
    p_id: item.id, p_revision: item.revision, p_type: type,
  });
  if (error) throw error;
  return data === true;
}
