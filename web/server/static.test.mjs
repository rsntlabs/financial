import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "./index.mjs";
test("static server serves WASM and has no financial proxy", async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(base + "/")).status, 200);
    assert.equal((await fetch(base + "/api/health")).status, 200);
    assert.equal(
      (await fetch(base + "/api/financials?ticker=IBM")).status,
      404,
    );
    assert.equal((await fetch(base + "/", { method: "POST" })).status, 405);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
