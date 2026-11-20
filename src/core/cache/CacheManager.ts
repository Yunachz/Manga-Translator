type CacheName = 'panel' | 'ocr' | 'translation' | 'render' | 'transfer' | 'chapter';
interface RecordValue<T> { key: string; value: T; expires: number; saved: number }
const caches: Record<CacheName, [number, number]> = {
  panel: [200, 14], ocr: [180, 14], translation: [300, 14], render: [32, 7], chapter: [210, 1], transfer: [20, 1 / 144],
};
let database: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  if (database) return database;
  database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('manga-translator-cache-v1', 2);
    request.onupgradeneeded = () => {
      for (const name of Object.keys(caches)) {
        if (request.result.objectStoreNames.contains(name)) continue;
        const store = request.result.createObjectStore(name, { keyPath: 'key' });
        store.createIndex('saved', 'saved');
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); database = undefined; };
      resolve(request.result);
    };
    request.onerror = () => { database = undefined; reject(request.error); };
  });
  return database;
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('Cache transaction aborted'));
  });
}

export class CacheManager {
  async get<T>(name: CacheName, key: string): Promise<T | undefined> {
    try {
      const database = await openDatabase();
      const entry = await result<RecordValue<T> | undefined>(database.transaction(name).objectStore(name).get(key));
      if (entry && entry.expires > Date.now()) return entry.value;
    } catch (error) {
      if (name === 'transfer' || name === 'chapter') throw error;
    }
  }

  async set<T>(name: CacheName, key: string, value: T): Promise<void> {
    try {
      const database = await openDatabase();
      const transaction = database.transaction(name, 'readwrite');
      const store = transaction.objectStore(name);
      const [limit, days] = caches[name];
      const time = Date.now();
      const done = completed(transaction);
      store.put({ key, value, saved: time, expires: time + days * 86_400_000 });
      const count = store.count();
      count.onsuccess = () => {
        let surplus = count.result - limit;
        if (surplus <= 0) return;
        const scan = store.index('saved').openCursor();
        scan.onsuccess = () => {
          const cursor = scan.result;
          if (!cursor || surplus <= 0) return;
          cursor.delete();
          surplus--;
          cursor.continue();
        };
      };
      await done;
    } catch (error) {
      if (name === 'transfer' || name === 'chapter') throw error;
    }
  }

  async delete(name: CacheName, key: string): Promise<void> {
    try {
      const database = await openDatabase();
      const transaction = database.transaction(name, 'readwrite');
      transaction.objectStore(name).delete(key);
      await completed(transaction);
    } catch {
      // Transfer entries also expire if cleanup is interrupted.
    }
  }

  async deleteChapterPatches(tabId: number, documentId: string): Promise<void> {
    const database = await openDatabase();
    const transaction = database.transaction('chapter', 'readwrite');
    const prefix = `${tabId}:${documentId}:`;
    const keys = IDBKeyRange.bound(prefix, prefix + '\uffff');
    transaction.objectStore('chapter').delete(keys);
    await completed(transaction);
  }

  async clear(): Promise<void> {
    const database = await openDatabase();
    const names = Object.keys(caches).filter(name => name !== 'transfer');
    const transaction = database.transaction(names, 'readwrite');
    for (const name of names) transaction.objectStore(name).clear();
    await completed(transaction);
  }
}

export const cache = new CacheManager();
