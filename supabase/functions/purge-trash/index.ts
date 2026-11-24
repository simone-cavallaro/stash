import { createClient } from 'npm:@supabase/supabase-js@2.119.2';
import { matchesSecret } from '../_shared/worker-auth.ts';

Deno.serve(async (request) => {
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  const secret = Deno.env.get('PURGE_WORKER_SECRET');
  if (!secret || secret.length < 32 || !await matchesSecret(request.headers.get('authorization') ?? '', secret)) {
    return new Response(null, { status: 401 });
  }

  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return new Response(null, { status: 503 });
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.rpc('files_for_cleanup');
  if (error) return new Response(null, { status: 503 });

  const paths = (data as { object_path: string }[]).map((file) => file.object_path);
  let failed = false;
  if (paths.length) {
    const { error: storageError } = await client.storage.from('stash-attachments').remove(paths);
    failed = !!storageError;
    // The database only forgets paths which are actually gone, even on a partial Storage failure.
    const { error: finishError } = await client.rpc('finish_file_cleanup', { p_paths: paths });
    failed ||= !!finishError;
  }
  const { error: purgeError } = await client.rpc('purge_expired_items');
  return new Response(null, { status: failed || purgeError ? 503 : 204 });
});
