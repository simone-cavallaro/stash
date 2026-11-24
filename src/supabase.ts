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
export async function saveCapture(client: StashClient, owner: string, capture: Capture, aiAllowed: boolean) {
  const { id, raw_text, source_url, capture_source } = capture;
  const { error } = await client.from('items').upsert(
    { id, user_id: owner, raw_text, source_url, capture_source, ai_allowed: aiAllowed },
    { onConflict: 'user_id,id', ignoreDuplicates: true },
  );
  if (error) throw error;
}

export async function retryItem(client: StashClient, owner: string, id: string) {
  const { error } = await client.from('item_classifications').update({ status: 'pending' })
    .eq('user_id', owner).eq('item_id', id).eq('status', 'failed');
  if (error) throw error;
}
