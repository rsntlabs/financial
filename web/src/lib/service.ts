type ProviderResponse =
  { id: number; result: unknown } | { id: number; error: string };

type PendingRequest = {
  resolve(value: unknown): void;
  reject(reason: Error): void;
};

let nextId = 0;
let providerWorker: Worker | undefined;
const pending = new Map<number, PendingRequest>();

function worker() {
  if (providerWorker) return providerWorker;
  const instance = new Worker(
    new URL("../workers/provider.worker.ts", import.meta.url),
    { type: "module", name: "financial-providers" },
  );
  instance.addEventListener(
    "message",
    (event: MessageEvent<ProviderResponse>) => {
      const request = pending.get(event.data.id);
      if (!request) return;
      pending.delete(event.data.id);
      if ("error" in event.data) request.reject(new Error(event.data.error));
      else request.resolve(event.data.result);
    },
  );
  instance.addEventListener("error", () => {
    const error = new Error(
      "The provider worker could not load. Refresh the page and try again.",
    );
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    instance.terminate();
    if (providerWorker === instance) providerWorker = undefined;
  });
  providerWorker = instance;
  return instance;
}

export async function providerRequest<T>(
  endpoint: "financials" | "prices",
  ticker: string,
  apiKey: string,
  endYear?: number,
): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
    });
    worker().postMessage({ id, endpoint, ticker, apiKey, endYear });
  });
}
