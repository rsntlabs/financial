import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".woff2": "font/woff2",
};
export function createServer({ staticRoot = dist } = {}) {
  return http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      res.writeHead(400);
      return res.end("Invalid request URL.");
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    if (url.pathname.startsWith("/api/")) {
      const json = (status, data) => {
        res.writeHead(status, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(data));
      };
      if (req.method !== "GET")
        return json(405, { error: "Only GET is supported." });
      if (url.pathname === "/api/health") return json(200, { status: "ok" });
      return json(404, {
        error:
          "No financial-data proxy. Statements are fetched directly from Alpha Vantage in your browser.",
      });
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405);
      return res.end();
    }
    try {
      const pathname = decodeURIComponent(url.pathname);
      const file = path.resolve(
        staticRoot,
        "." + (pathname === "/" ? "/index.html" : pathname),
      );
      if (!file.startsWith(path.resolve(staticRoot) + path.sep)) {
        res.writeHead(403);
        return res.end();
      }
      if (!(await stat(file)).isFile()) {
        res.writeHead(404);
        return res.end();
      }
      const body = await readFile(file);
      res.writeHead(200, {
        "Content-Type": mime[path.extname(file)] || "application/octet-stream",
        "Cache-Control": pathname.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      });
      return res.end(req.method === "HEAD" ? undefined : body);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found. Build the web app with npm run build first.");
    }
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const server = createServer();
  const port = Number(process.env.PORT || 3000);
  server.listen(port, process.env.HOST || "0.0.0.0", () =>
    console.log(`Financials web app: http://localhost:${port}`),
  );
}
