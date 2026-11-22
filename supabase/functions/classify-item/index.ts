import { createClient } from 'npm:@supabase/supabase-js@2.119.2';
import { classify } from './classifier.ts';

async function matchesSecret(provided: string, expected: string) {
  const encoder = new TextEncoder();
  const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  const [left, right] = await Promise.all([digest(provided), digest(`Bearer ${expected}`)]);
  return left.reduce((difference, byte, index) => difference | (byte ^ right[index]), 0) === 0;
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  const secret = Deno.env.get('CLASSIFY_WORKER_SECRET');
  if (!secret || secret.length < 32 || !await matchesSecret(request.headers.get('authorization') ?? '', secret)) {
    return new Response(null, { status: 401 });
  }

  const url = Deno.env.get('SUPABASE_URL');
  const adminKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !adminKey) return new Response(null, { status: 503 });
  const client = createClient(url, adminKey, { auth: { persistSession: false, autoRefreshToken: false } });

  for (let index = 0; index < 4; index++) {
    const { data: job, error: claimError } = await client.rpc('claim_item_classification').maybeSingle<{
      user_id: string; item_id: string; lease_token: string; raw_text: string; ai_allowed: boolean;
    }>();
    if (claimError) return new Response(null, { status: 503 });
    if (!job) break;

    const outcome = await classify(job, Deno.env.get('GROQ_API_KEY'));
    const { error: updateError } = await client.from('item_classifications')
      .update({ ...outcome, lease_token: null, lease_until: null })
      .eq('user_id', job.user_id).eq('item_id', job.item_id).eq('status', 'pending').eq('lease_token', job.lease_token);
    if (updateError) return new Response(null, { status: 503 });
  }

  return new Response(null, { status: 204 });
});
