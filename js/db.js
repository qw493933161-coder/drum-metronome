// Thin IndexedDB wrapper. Plans/patterns/settings are small JSON; score images/PDFs
// and imported music tracks are stored as Blobs in their own store since localStorage
// can't hold binary data at any real size.
(function (root) {
  const DB_NAME = 'drum-metronome-db';
  const DB_VERSION = 1;
  const STORES = ['plans', 'patterns', 'files', 'settings'];

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        STORES.forEach(name => {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
        });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(storeName, mode) {
    return open().then(db => db.transaction(storeName, mode).objectStore(storeName));
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  const DB = {
    async getAll(storeName) {
      const store = await tx(storeName, 'readonly');
      return reqToPromise(store.getAll());
    },
    async get(storeName, id) {
      const store = await tx(storeName, 'readonly');
      return reqToPromise(store.get(id));
    },
    async put(storeName, value) {
      const store = await tx(storeName, 'readwrite');
      await reqToPromise(store.put(value));
      return value;
    },
    async delete(storeName, id) {
      const store = await tx(storeName, 'readwrite');
      return reqToPromise(store.delete(id));
    },
    async clear(storeName) {
      const store = await tx(storeName, 'readwrite');
      return reqToPromise(store.clear());
    }
  };

  root.DB = DB;
  root.DB_STORES = STORES;
}(typeof window !== 'undefined' ? window : globalThis));
