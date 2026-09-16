import type { AlphaPayload } from "./provider";
export interface SavedStock {
  ticker: string;
  fetchedAt: string;
  payload: AlphaPayload;
}
const DATABASE = "financials-alphavantage-v1";
export const KEY_STORAGE = "financials.alphavantage.key";

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("stocks", { keyPath: "ticker" });
      request.result.createObjectStore("pending", { keyPath: "ticker" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        new Error(
          "Local storage is unavailable. Allow site storage in your browser to save and load statements.",
        ),
      );
    request.onblocked = () =>
      reject(
        new Error(
          "Close other tabs of this dashboard, then try again. Local storage needs an update.",
        ),
      );
  });
}
async function operation<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = run(tx.objectStore(store));
    tx.oncomplete = () => {
      db.close();
      resolve(request.result);
    };
    tx.onabort = tx.onerror = () => {
      db.close();
      reject(
        new Error(
          "Could not save or read local data. Check available disk space and browser storage settings.",
        ),
      );
    };
  });
}
export const savedStock = (ticker: string) =>
  operation<SavedStock | undefined>("stocks", "readonly", (s) => s.get(ticker));
export const savedStocks = () =>
  operation<SavedStock[]>("stocks", "readonly", (s) => s.getAll());
export const pendingStock = (ticker: string) =>
  operation<SavedStock | undefined>("pending", "readonly", (s) =>
    s.get(ticker),
  );
export const savePending = (record: SavedStock) =>
  operation("pending", "readwrite", (s) => s.put(record));
export async function saveStock(record: SavedStock) {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["stocks", "pending"], "readwrite");
    tx.objectStore("stocks").put(record);
    tx.objectStore("pending").delete(record.ticker);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = tx.onabort = () => {
      db.close();
      reject(
        new Error(
          "Statements loaded, but could not be saved to disk. Free browser storage and try again.",
        ),
      );
    };
  });
}
export async function clearStocks() {
  // One transaction removes complete and interrupted downloads together.
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["stocks", "pending"], "readwrite");
    tx.objectStore("stocks").clear();
    tx.objectStore("pending").clear();
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onabort = tx.onerror = () => {
      db.close();
      reject(new Error("Could not clear saved statements."));
    };
  });
}
export function loadKey(): string {
  try {
    return (
      sessionStorage.getItem(KEY_STORAGE) ||
      localStorage.getItem(KEY_STORAGE) ||
      ""
    );
  } catch {
    return "";
  }
}
export function storeKey(key: string, remember: boolean) {
  localStorage.removeItem(KEY_STORAGE);
  sessionStorage.removeItem(KEY_STORAGE);
  if (key) (remember ? localStorage : sessionStorage).setItem(KEY_STORAGE, key);
}
export async function protectStorage(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
