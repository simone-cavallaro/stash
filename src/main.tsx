import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { openStash } from './supabase.ts';
import './styles.css';

createRoot(document.getElementById('root')!).render(<App client={openStash()} />);

if ('serviceWorker' in navigator) {
  const url = import.meta.env.DEV ? '/src/sw.ts' : '/sw.js';
  void navigator.serviceWorker.register(url, { type: 'module', scope: '/', updateViaCache: 'none' }).catch(() => {
    // Manual entry stays available if the browser disallows service workers.
  });
}
