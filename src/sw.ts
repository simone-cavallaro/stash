import { fromShare } from './features/capture/capture.ts';
import { storeShare } from './features/capture/shared-draft.ts';

const worker = self as unknown as ServiceWorkerGlobalScope;
worker.addEventListener('install', (event) => event.waitUntil(worker.skipWaiting()));
worker.addEventListener('activate', (event) => event.waitUntil(worker.clients.claim()));

worker.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.origin !== worker.location.origin || url.pathname !== '/share') return;
  event.respondWith(receiveShare(request));
});

async function receiveShare(request: Request) {
  const site = request.headers.get('sec-fetch-site');
  const origin = request.headers.get('origin');
  if (request.mode !== 'navigate' || (site && site !== 'same-origin' && site !== 'none') ||
      (origin && origin !== 'null' && origin !== worker.location.origin)) {
    return new Response('Condivisione non disponibile.', { status: 403 });
  }

  try {
    const capture = fromShare(await request.formData());
    await storeShare(capture);
    return Response.redirect(new URL(`/#share=${capture.id}`, worker.location.origin), 303);
  } catch {
    return Response.redirect(new URL('/#share-error', worker.location.origin), 303);
  }
}
