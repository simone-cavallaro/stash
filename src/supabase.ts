import { createClient } from '@supabase/supabase-js';
import type { Capture } from './features/capture/capture.ts';

const url = import.meta.env.VITE_SUPABASE_URL;
const publicKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export function openStash() {
  try {
    return url && publicKey ? createClient(url, publicKey) : null;
  } catch {
    return null;
  }
}

export type StashClient = NonNullable<ReturnType<typeof openStash>>;
export type Item = Capture & {
  captured_at: string;
  item_classifications: null | {
    status: 'pending' | 'ready' | 'failed' | 'skipped';
    result: null | { kind: string; intentions: string[]; needs_clarification: boolean };
  };
};

export async function saveCapture(client: StashClient, owner: string, capture: Capture, aiAllowed: boolean) {
  const { id, raw_text, source_url, capture_source } = capture;
  const { error } = await client.from('items').upsert(
    { id, user_id: owner, raw_text, source_url, capture_source, ai_allowed: aiAllowed },
    { onConflict: 'user_id,id', ignoreDuplicates: true },
  );
  if (error) throw error;
}

export async function listItems(client: StashClient, owner: string, cursor?: Item, projectId?: string) {
  const columns = 'id,raw_text,source_url,capture_source,captured_at,item_classifications(status,result)';
  let query = client.from('items')
    .select(projectId ? `${columns},project_items!inner(project_id)` : columns)
    .eq('user_id', owner)
    .order('captured_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(30);
  if (projectId) query = query.eq('project_items.project_id', projectId);
  if (cursor) {
    query = query.or(`captured_at.lt.${cursor.captured_at},and(captured_at.eq.${cursor.captured_at},id.lt.${cursor.id})`);
  }
  const { data, error } = await query.overrideTypes<Item[], { merge: false }>();
  if (error) throw error;
  return data;
}

export async function retryItem(client: StashClient, owner: string, id: string) {
  const { error } = await client.from('item_classifications').update({ status: 'pending' })
    .eq('user_id', owner).eq('item_id', id).eq('status', 'failed');
  if (error) throw error;
}
