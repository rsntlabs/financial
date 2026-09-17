// Memoizes a promise-returning factory; a rejected attempt is not cached, so
// the next call retries instead of repeating the same failure forever.
export function loadOnce<T>(factory: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | undefined;
  return () => {
    promise ??= factory().catch((error) => {
      promise = undefined;
      throw error;
    });
    return promise;
  };
}

type Engine = typeof import("../wasm/financial_core");

export const loadEngine = loadOnce<Engine>(async () => {
  const engine = await import("../wasm/financial_core");
  await engine.default();
  return engine;
});
