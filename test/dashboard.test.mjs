// Drives public/index.html in a real DOM (jsdom) against a real instance of the
// dev server, so the dashboard's own script is what gets exercised.
//
// jsdom isn't a runtime dependency — install it to run this file:
//   npm install --no-save jsdom && node --test test/dashboard.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createDevServer } from "../dev.mjs";

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "public", "index.html"), "utf8");

const server = createDevServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

function boot() {
  const dom = new JSDOM(HTML, {
    url: base + "/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
      window.fetch = (input, init) => fetch(typeof input === "string" ? input : input.url, init);
    },
  });
  return dom;
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await tick(25);
  }
  return false;
}

test("the dashboard boots, handshakes and renders the live tool list", async () => {
  const dom = boot();
  const doc = dom.window.document;

  const ready = await waitFor(() => doc.getElementById("statusText").textContent.includes("bridge online"));
  const status = doc.getElementById("statusText").textContent;
  assert.ok(ready, "status never went online, got: " + status);
  assert.match(status, /github-mcp-server/, "status should name the server from the initialize result");
  assert.match(doc.getElementById("chipTools").textContent, /6/, "tool chip should show the live count");
  assert.match(doc.getElementById("chipLatency").textContent, /\d+ ms/);
  assert.equal(doc.getElementById("pulse").className, "pulse online");

  const buttons = [...doc.querySelectorAll(".tool-btn")];
  assert.equal(buttons.length, 6, "all six tools should render from tools/list");
  assert.deepEqual(
    buttons.map((b) => b.querySelector("span:nth-child(2)").textContent),
    ["list_repos", "get_repo", "list_issues", "get_file_contents", "create_issue", "push_file"],
    "reads should be grouped before writes"
  );
  assert.ok(doc.querySelectorAll(".tdot.write").length === 2, "two tools should be flagged as writes");
  assert.match(doc.getElementById("toolCount").textContent, /6 live/, "the list should be marked live, not documented");

  dom.window.close();
});

test("selecting a tool builds its argument form from the live schema", async () => {
  const dom = boot();
  const doc = dom.window.document;
  await waitFor(() => doc.getElementById("statusText").textContent.includes("bridge online"));

  const find = (name) => [...doc.querySelectorAll(".tool-btn")].find((b) => b.textContent.includes(name));

  find("get_repo").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  let fields = [...doc.querySelectorAll("#argForm [name]")].map((i) => i.name);
  assert.deepEqual(fields, ["owner", "repo"]);
  assert.equal(doc.querySelectorAll("#argForm .req").length, 2, "both are required");
  assert.equal(doc.getElementById("writeGuardWrap").hidden, true);

  find("list_issues").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  fields = [...doc.querySelectorAll("#argForm [name]")].map((i) => i.name);
  assert.deepEqual(fields, ["owner", "repo", "state", "per_page", "include_pull_requests"]);
  const state = doc.querySelector('#argForm [name="state"]');
  assert.equal(state.tagName, "SELECT", "an enum should render as a select");
  assert.deepEqual([...state.options].map((o) => o.value).filter(Boolean), ["open", "closed", "all"]);

  find("push_file").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  fields = [...doc.querySelectorAll("#argForm [name]")].map((i) => i.name);
  assert.deepEqual(fields, ["owner", "repo", "path", "content", "message", "branch"]);
  assert.equal(doc.querySelector('#argForm [name="content"]').tagName, "TEXTAREA", "content should be a textarea");
  assert.equal(doc.getElementById("writeGuardWrap").hidden, false, "write tools must show the acknowledgement");
  assert.equal(doc.getElementById("run").disabled, true, "a write tool must not run unacknowledged");

  doc.getElementById("writeGuard").checked = true;
  doc.getElementById("writeGuard").dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  assert.equal(doc.getElementById("run").disabled, false, "acknowledging should unlock the button");

  dom.window.close();
});

test("running a tool posts real MCP and renders the tool's error text", async () => {
  const dom = boot();
  const doc = dom.window.document;
  await waitFor(() => doc.getElementById("statusText").textContent.includes("bridge online"));

  [...doc.querySelectorAll(".tool-btn")]
    .find((b) => b.textContent.includes("get_repo"))
    .dispatchEvent(new dom.window.Event("click", { bubbles: true }));

  doc.querySelector('#argForm [name="owner"]').value = "octocat";
  doc.querySelector('#argForm [name="repo"]').value = "Hello-World";
  doc.getElementById("token").value = "ghp_thisisnotarealtoken0000000000000000";
  doc.getElementById("token").dispatchEvent(new dom.window.Event("input", { bubbles: true }));

  doc.getElementById("run").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  const done = await waitFor(() => doc.querySelector("#responseBanner .banner") !== null);
  assert.ok(done, "no response banner was rendered");

  const banner = doc.querySelector("#responseBanner .banner");
  assert.equal(banner.className, "banner error");
  assert.match(banner.textContent, /401 from GitHub/, "GitHub's 401 should surface verbatim: " + banner.textContent);

  // the request tab must show the exact body that was sent
  const req = doc.getElementById("requestBody").textContent;
  assert.match(req, /"method": "tools\/call"/);
  assert.match(req, /"name": "get_repo"/);
  assert.match(req, /octocat/);
  assert.match(doc.getElementById("curlBody").textContent, /Authorization: Bearer ghp_/);
  assert.match(doc.getElementById("chipLast").textContent, /200 · \d+ ms/);

  dom.window.close();
});

test("a missing required argument is caught client-side", async () => {
  const dom = boot();
  const doc = dom.window.document;
  await waitFor(() => doc.getElementById("statusText").textContent.includes("bridge online"));

  [...doc.querySelectorAll(".tool-btn")]
    .find((b) => b.textContent.includes("get_repo"))
    .dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  doc.getElementById("run").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  await waitFor(() => doc.querySelector("#responseBanner .banner") !== null);

  assert.match(doc.querySelector("#responseBanner .banner").textContent, /missing required argument: owner/);
  dom.window.close();
});

test("an unreachable endpoint degrades to the documented tool list", async () => {
  const dom = new JSDOM(HTML, {
    url: base + "/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
      window.fetch = () => Promise.reject(new TypeError("Failed to fetch"));
    },
  });
  const doc = dom.window.document;

  const offline = await waitFor(() => doc.getElementById("statusText").textContent.includes("unreachable"));
  assert.ok(offline, "the dashboard should report an unreachable endpoint");
  assert.equal(doc.getElementById("pulse").className, "pulse offline");
  assert.equal(doc.querySelectorAll(".tool-btn").length, 6, "the fallback list still documents every tool");
  assert.match(doc.getElementById("toolCount").textContent, /6 documented/);
  assert.ok(!doc.querySelector(".track.live"), "the flow animation must stop when offline");

  dom.window.close();
});

after(() => server.close());
