export type LocalReaderFormat = 'pdf' | 'epub' | 'unknown';

export type LocalReaderBook = {
  id: string;
  title: string;
  fileName: string;
  mimeType: string;
  format: LocalReaderFormat;
  sizeBytes: number;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number | null;
};

type LocalReaderBookRecord = LocalReaderBook & {
  blob: Blob;
};

const DB_NAME = 'tws-local-reader';
const DB_VERSION = 1;
const BOOK_STORE = 'books';

let dbPromise: Promise<IDBDatabase> | null = null;

function requestToPromise<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function openDatabase() {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = window.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(BOOK_STORE)) {
          const store = db.createObjectStore(BOOK_STORE, { keyPath: 'id' });
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
          store.createIndex('lastOpenedAt', 'lastOpenedAt', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Unable to open local reader storage'));
    });
  }
  return dbPromise;
}

function inferFormat(fileName: string, mimeType?: string | null): LocalReaderFormat {
  const lowerName = fileName.toLowerCase();
  const lowerMime = (mimeType ?? '').toLowerCase();
  if (lowerName.endsWith('.pdf') || lowerMime === 'application/pdf') return 'pdf';
  if (
    lowerName.endsWith('.epub') ||
    lowerMime === 'application/epub+zip' ||
    lowerMime === 'application/x-zip-compressed'
  ) {
    return 'epub';
  }
  return 'unknown';
}

function titleFromFileName(fileName: string) {
  const withoutExt = fileName.replace(/\.[^.]+$/, '');
  const normalized = withoutExt
    .replace(/[_]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s*-\s*/g, ' - ')
    .trim();
  return normalized || fileName;
}

function mapRecord(record: LocalReaderBookRecord): LocalReaderBook {
  const { blob: _blob, ...book } = record;
  return book;
}

function createId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `book-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function isReaderFileSupported(file: File) {
  return inferFormat(file.name, file.type) !== 'unknown';
}

export async function listLocalReaderBooks(): Promise<LocalReaderBook[]> {
  const db = await openDatabase();
  const transaction = db.transaction(BOOK_STORE, 'readonly');
  const store = transaction.objectStore(BOOK_STORE);
  const request = store.getAll();
  const records = (await requestToPromise(request)) as LocalReaderBookRecord[];
  await transactionDone(transaction);
  return records
    .map(mapRecord)
    .sort((a, b) => {
      const aRank = a.lastOpenedAt ?? a.updatedAt ?? a.createdAt;
      const bRank = b.lastOpenedAt ?? b.updatedAt ?? b.createdAt;
      return bRank - aRank;
    });
}

export async function addLocalReaderBooks(files: File[]): Promise<LocalReaderBook[]> {
  const acceptedFiles = files.filter(isReaderFileSupported);
  if (!acceptedFiles.length) return [];

  const now = Date.now();
  const db = await openDatabase();
  const transaction = db.transaction(BOOK_STORE, 'readwrite');
  const store = transaction.objectStore(BOOK_STORE);
  const inserted: LocalReaderBook[] = [];

  for (const file of acceptedFiles) {
    const record: LocalReaderBookRecord = {
      id: createId(),
      title: titleFromFileName(file.name),
      fileName: file.name,
      mimeType: file.type || (inferFormat(file.name) === 'epub' ? 'application/epub+zip' : 'application/pdf'),
      format: inferFormat(file.name, file.type),
      sizeBytes: file.size,
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: null,
      blob: file
    };
    store.put(record);
    inserted.push(mapRecord(record));
  }

  await transactionDone(transaction);
  return inserted;
}

export async function openLocalReaderBook(id: string): Promise<{ book: LocalReaderBook; blob: Blob } | null> {
  const db = await openDatabase();
  const transaction = db.transaction(BOOK_STORE, 'readwrite');
  const store = transaction.objectStore(BOOK_STORE);
  const existing = (await requestToPromise(store.get(id))) as LocalReaderBookRecord | undefined;
  if (!existing) {
    await transactionDone(transaction);
    return null;
  }

  const updated: LocalReaderBookRecord = {
    ...existing,
    lastOpenedAt: Date.now(),
    updatedAt: Date.now()
  };
  store.put(updated);
  await transactionDone(transaction);

  return {
    book: mapRecord(updated),
    blob: updated.blob
  };
}

export async function deleteLocalReaderBook(id: string): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(BOOK_STORE, 'readwrite');
  transaction.objectStore(BOOK_STORE).delete(id);
  await transactionDone(transaction);
}
