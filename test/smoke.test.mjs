// Real smoke tests: they boot the actual exported Vercel handler from
// api/mcp.js behind an http server and speak MCP to it over a real socket —
// the same code path Vercel invokes in production.
//
//   npm test
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import handler, { TOOLS } from "../api/mcp.js";

let base;
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    req.body = raw ? JSON.parse(raw) : undefined;
  } catch {
    req.body = undefined;
  }
  await handler(req, res);
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
base = `http://127.0.0.1:${server.address().port}/api/mcp`;

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

function parseBody(text, contentType) {
  if (contentType?.includes("text/event-stream")) {
    return text
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)));
  }
  return text ? [JSON.parse(text)] : [];
}

async function rpc(payload, headers = {}) {
  const res = await fetch(base, {
    method: "POST",
    headers: { ...MCP_HEADERS, ...headers },
    body: JSON.stringify(payload),
  });
  const ct = res.headers.get("content-type") || "";
  return { status: res.status, ct, msgs: parseBody(await res.text(), ct) };
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
};

const call = (name, args, headers) =>
  rpc({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } }, headers);

// ---------------------------------------------------------------------------
test("GET /api/mcp is a health check, not a 405", async () => {
  const res = await fetch(base, { method: "GET" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "ok");
  assert.equal(body.server.name, "github-mcp-server");
  assert.equal(body.tools.length, TOOLS.length);
  assert.deepEqual(
    body.tools.filter((t) => t.writes).map((t) => t.name).sort(),
    ["create_issue", "push_file"]
  );
});

test("OPTIONS preflight answers 204 with CORS headers", async () => {
  const res = await fetch(base, { method: "OPTIONS" });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.match(res.headers.get("access-control-allow-headers"), /Authorization/);
});

test("PUT is rejected with an Allow header", async () => {
  const res = await fetch(base, { method: "PUT" });
  assert.equal(res.status, 405);
  assert.match(res.headers.get("allow"), /POST/);
});

test("initialize reports the server identity", async () => {
  const { status, msgs } = await rpc(initialize);
  assert.equal(status, 200);
  const result = msgs.find((m) => m.id === 1)?.result;
  assert.equal(result.serverInfo.name, "github-mcp-server");
  assert.ok(result.capabilities.tools, "server must advertise the tools capability");
});

test("tools/list returns every tool with a JSON schema", async () => {
  const { msgs } = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const tools = msgs.find((m) => m.id === 2)?.result?.tools;
  assert.equal(tools.length, 6);
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    [
      "create_issue",
      "get_file_contents",
      "get_repo",
      "list_issues",
      "list_repos",
      "push_file",
    ]
  );
  for (const t of tools) {
    assert.equal(t.inputSchema.type, "object", `${t.name} needs an object inputSchema`);
    assert.ok(t.description?.length > 10, `${t.name} needs a description`);
  }
});

// Every failure mode below must come back as a tool result with isError: true.
// A JSON-RPC error object here means the client/model sees nothing useful.
function assertToolError(msgs, needle) {
  const msg = msgs.find((m) => m.id === 9);
  assert.ok(msg, `expected a response with id 9, got ${JSON.stringify(msgs)}`);
  assert.ok(!msg.error, `must not be a JSON-RPC error, got ${JSON.stringify(msg.error)}`);
  assert.equal(msg.result.isError, true);
  const text = msg.result.content[0].text;
  assert.match(text, needle);
  return text;
}

test("missing token is a readable tool error", async () => {
  const { msgs } = await call("list_repos", {});
  assertToolError(msgs, /No GitHub token provided/);
});

test("malformed token is caught before hitting GitHub", async () => {
  const { msgs } = await call("list_repos", {}, { Authorization: "Bearer Bearer" });
  assertToolError(msgs, /literal word 'Bearer'/);
});

test("an obvious non-token (a URL) is rejected early", async () => {
  const { msgs } = await call("list_repos", {}, { Authorization: "Bearer https://github.com/x" });
  assertToolError(msgs, /looks like a URL/);
});

test("invalid arguments are a tool error, not a -32603", async () => {
  const { msgs } = await call("get_repo", { repo: "x" });
  const text = assertToolError(msgs, /Invalid arguments for get_repo/);
  assert.match(text, /owner/);
});

test("out-of-range per_page is rejected by the schema", async () => {
  const { msgs } = await call("list_repos", { per_page: 5000 });
  assertToolError(msgs, /Invalid arguments for list_repos/);
});

test("unknown tool names are handled, not thrown", async () => {
  const { msgs } = await call("delete_the_internet", {});
  assertToolError(msgs, /Unknown tool: delete_the_internet/);
});

test("push_file refuses >1 MB payloads without calling GitHub", async () => {
  const { msgs } = await call(
    "push_file",
    {
      owner: "a",
      repo: "b",
      path: "big.txt",
      message: "too big",
      content: "x".repeat(1_100_000),
    },
    { Authorization: "Bearer ghp_fake_token_for_validation_only" }
  );
  assertToolError(msgs, /contents API accepts up to 1 MB/);
});

// Reaches api.github.com. Skipped automatically when there's no network.
test("a bad token surfaces GitHub's 401 through the tool result", async (t) => {
  let res;
  try {
    res = await call("get_repo", { owner: "octocat", repo: "Hello-World" }, {
      Authorization: "Bearer ghp_thisisnotarealtoken0000000000000000",
    });
  } catch (err) {
    if (err?.cause?.code === "ENOTFOUND" || err?.cause?.code === "ECONNREFUSED") {
      return t.skip("no network");
    }
    throw err;
  }
  assertToolError(res.msgs, /401 from GitHub/);
});

// node:test runs queued tests after the module body finishes, so the server
// has to stay up until the run is over.
after(() => server.close());
