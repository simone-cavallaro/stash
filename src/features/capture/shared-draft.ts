import type { Capture } from './capture.ts';

type SharedDraft = Capture & { owner?: string };

function transaction<T>(act: (store: IDBObjectStore, done: (result: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('stash', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('shares', { keyPath: 'id' });
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('shares', 'readwrite');
      let result: T;
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onabort = () => { db.close(); reject(tx.error); };
      act(tx.objectStore('shares'), (value) => { result = value; });
    };
  });
}

export function storeShare(capture: Capture) {
  return transaction<void>((store) => { store.add(capture); });
}

export function claimShare(id: string, owner: string) {
  return transaction<SharedDraft | undefined>((store, done) => {
    const request = store.get(id);
    request.onsuccess = () => {
      const draft: SharedDraft | undefined = request.result;
      if (!draft || (draft.owner && draft.owner !== owner)) {
        done(undefined);
        return;
      }
      store.put({ ...draft, owner });
      done(draft);
    };
  });
}

export function removeShare(id: string) {
  return transaction<void>((store) => { store.delete(id); });
}
