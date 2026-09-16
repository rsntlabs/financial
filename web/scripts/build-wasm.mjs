import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../../", import.meta.url));
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error || result.status !== 0) {
    console.error(
      `Could not run ${command}. Install Rust's wasm32-unknown-unknown target and the wasm-bindgen CLI version listed in Cargo.lock. See web/README.md.`,
    );
    process.exit(result.status || 1);
  }
}
run("cargo", [
  "build",
  "--locked",
  "--release",
  "--lib",
  "--target",
  "wasm32-unknown-unknown",
  "-p",
  "financial-providers",
]);
const target = process.env.CARGO_TARGET_DIR
  ? path.resolve(root, process.env.CARGO_TARGET_DIR)
  : path.join(root, "target");
run("wasm-bindgen", [
  "--target",
  "web",
  "--out-dir",
  "web/src/wasm",
  "--out-name",
  "financial_core",
  path.join(target, "wasm32-unknown-unknown/release/financial_providers.wasm"),
]);
console.log("Rust WASM engine and Yahoo, EDGAR, Alpha Vantage clients built successfully.");
