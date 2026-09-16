import type { AlphaPayload } from "./provider";
import type { PriceHistory } from "./types";
export interface SavedStock {
  ticker: string;
  fetchedAt: string;
  payload: AlphaPayload;
}
const DATABASE = "financials-alphavantage-v1";
export const KEY_STORAGE = "financials.alphavantage.key";

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 3);
    request.onupgradeneeded = () => {
      for (const name of ["stocks", "pending", "prices"]) {
        if (!request.result.objectStoreNames.contains(name))
          request.result.createObjectStore(name, { keyPath: "ticker" });
      }
      if (!request.result.objectStoreNames.contains("metadata"))
        request.result.createObjectStore("metadata");
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
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
export const savedPrices = (ticker: string) =>
  operation<PriceHistory | undefined>("prices", "readonly", (s) =>
    s.get(ticker),
  );
export const priceCacheGeneration = async () =>
  (await operation<number | undefined>("metadata", "readonly", (s) =>
    s.get("price-generation"),
  )) ?? 0;
export async function savePrices(record: PriceHistory, generation: number) {
  const db = await database();
  return new Promise<boolean>((resolve, reject) => {
    // The comparison and write must be atomic with clearing, including across tabs.
    const tx = db.transaction(["prices", "metadata"], "readwrite");
    const current = tx.objectStore("metadata").get("price-generation");
    let saved = false;
    current.onsuccess = () => {
      if ((current.result ?? 0) !== generation) return;
      tx.objectStore("prices").put(record);
      saved = true;
    };
    tx.oncomplete = () => {
      db.close();
      resolve(saved);
    };
    tx.onabort = tx.onerror = () => {
      db.close();
      reject(new Error("Could not save prices to browser storage."));
    };
  });
}
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
  // One transaction removes statements, interrupted downloads and prices together.
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(
      ["stocks", "pending", "prices", "metadata"],
      "readwrite",
    );
    const metadata = tx.objectStore("metadata");
    const generation = metadata.get("price-generation");
    generation.onsuccess = () => {
      metadata.put((generation.result ?? 0) + 1, "price-generation");
    };
    tx.objectStore("stocks").clear();
    tx.objectStore("pending").clear();
    tx.objectStore("prices").clear();
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
