// Static/dev-server tests: same public/ + api routing the user gets from
// `npm run serve`, on an ephemeral port.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createDevServer, safeJoin } from "../dev.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const server = createDevServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

test("GET / serves the dashboard, not a 400", async () => {
  const res = await fetch(base + "/");
  assert.equal(res.status, 200, "the root route must return the dashboard");
  assert.match(res.headers.get("content-type"), /text\/html/);
  const html = await res.text();
  assert.match(html, /github-mcp-server/);
  assert.match(html, /id="toolList"/, "dashboard markup should include the tool list mount");
});

test("an explicit file path resolves too", async () => {
  const res = await fetch(base + "/index.html");
  assert.equal(res.status, 200);
});

test("unknown files 404 instead of leaking the filesystem", async () => {
  const res = await fetch(base + "/nope.html");
  assert.equal(res.status, 404);
  assert.equal(await res.text(), "not found");
});

test("path traversal is refused", async () => {
  for (const evil of ["/../package.json", "/..%2fpackage.json", "/%2e%2e%2fpackage.json", "/../../etc/passwd"]) {
    const res = await fetch(base + evil);
    assert.ok([400, 404].includes(res.status), `${evil} → ${res.status}`);
    const body = await res.text();
    assert.ok(!body.includes('"dependencies"'), `${evil} leaked package.json`);
    assert.ok(!body.includes("root:"), `${evil} leaked /etc/passwd`);
  }
});

test("safeJoin only ever returns paths inside public/", () => {
  assert.equal(safeJoin(PUBLIC, "/index.html"), join(PUBLIC, "index.html"));
  assert.equal(safeJoin(PUBLIC, "/"), PUBLIC, "a bare slash maps to the directory itself; the server rewrites it to /index.html first");
  assert.equal(safeJoin(PUBLIC, "/%"), null, "malformed percent-encoding must not throw");

  // normalize() collapses ".." segments that sit at the root, so these decode to
  // ordinary paths *inside* public/ — where no such file exists, so they 404.
  assert.equal(safeJoin(PUBLIC, "/../package.json"), join(PUBLIC, "package.json"));
  assert.equal(safeJoin(PUBLIC, "/.."), PUBLIC);
  assert.equal(safeJoin(PUBLIC, "/%2e%2e/secret"), join(PUBLIC, "secret"));
  assert.equal(safeJoin(PUBLIC, "/%2e%2e%2f%2e%2e%2fpackage.json"), join(PUBLIC, "package.json"));

  // The invariant that actually matters: nothing escapes public/, whatever the input.
  const nasty = [
    "/../package.json", "/..", "/../../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd",
    "/a/../../../etc/passwd", "/%252e%252e%252fpackage.json", "/..%2f..%2fpackage.json",
    "/..\\..\\package.json", "/sub/../../package.json", "/./../../package.json",
  ];
  for (const input of nasty) {
    const out = safeJoin(PUBLIC, input);
    if (out === null) continue;
    assert.ok(
      out === PUBLIC || out.startsWith(PUBLIC + sep),
      `${input} escaped public/ → ${out}`
    );
  }
});

test("the dashboard and the MCP endpoint share one origin", async () => {
  const res = await fetch(base + "/api/mcp", { method: "GET" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "ok");
  assert.equal(body.tools.length, 6);
});

test("MCP POST works through the dev server's body parsing", async () => {
  const res = await fetch(base + "/api/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  const msgs = text
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)));
  assert.equal(msgs.find((m) => m.id === 1).result.tools.length, 6);
});

after(() => server.close());
