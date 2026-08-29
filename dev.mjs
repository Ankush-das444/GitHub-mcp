// Zero-dependency dev server so `npm run serve` works without the Vercel CLI
// or a Vercel login. Serves public/ as static files and routes /api/mcp to the
// exact handler that Vercel runs, so the dashboard's live checks work locally.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import handler from "./api/mcp.js";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const PUBLIC_DIR = join(ROOT, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

// Keeps `..` from escaping public/ — the preview host and localhost both hit this.
// The leading slash has to go first, or resolve() treats it as filesystem-absolute
// and the containment check rejects every real request.
export function safeJoin(base, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // malformed percent-encoding
  }
  const rel = normalize(decoded).replace(/^[/\\]+/, "");
  if (rel.split(sep).includes("..")) return null;
  const target = resolve(base, rel);
  return target === base || target.startsWith(base + sep) ? target : null;
}

export function createDevServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/api/mcp" || url.pathname === "/api/mcp/") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString("utf8");
      // Vercel's Node runtime parses JSON bodies for you; mirror that here.
      try {
        req.body = raw ? JSON.parse(raw) : undefined;
      } catch {
        req.body = undefined;
      }
      return handler(req, res);
    }

    const filePath = safeJoin(PUBLIC_DIR, url.pathname === "/" ? "/index.html" : url.pathname);
    if (!filePath) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("bad path");
    }
    try {
      const body = await readFile(filePath);
      res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
    }
  });
}

// Only bind a port when run directly (`npm run serve`), never when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const PORT = Number(process.env.PORT || 3000);
  const HOST = process.env.HOST || "0.0.0.0";
  createDevServer().listen(PORT, HOST, () => {
    console.log(`github-mcp-server dev → http://localhost:${PORT}`);
    console.log(`  dashboard : http://localhost:${PORT}/`);
    console.log(`  mcp       : http://localhost:${PORT}/api/mcp`);
  });
}
