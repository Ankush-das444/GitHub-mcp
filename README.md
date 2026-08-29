# github-mcp-server

Your own remote MCP server that talks to GitHub. Runs on Vercel's serverless
functions — no device stays on, no self-hosting. Ship it once, then point any
MCP client at the URL.

**What's in the box**

| | |
|---|---|
| `api/mcp.js` | the MCP server — Streamable HTTP transport, stateless (a fresh instance spins up per request, which is exactly how serverless works) |
| `public/index.html` | a dashboard that handshakes with the live endpoint, lists the tools it reports, and lets you run them |
| `dev.mjs` | zero-dependency dev server (`npm run serve`) — no Vercel login needed |
| `test/` | 25 tests that boot the real handler and speak MCP to it |
| 6 GitHub tools | 4 reads, 2 writes |

**Auth:** send your GitHub PAT as `Authorization: Bearer <token>` on each request,
or set a `GITHUB_TOKEN` env var on Vercel if this deployment is only for you.
The server stores nothing.

---

## The tools

| tool | kind | arguments |
|---|---|---|
| `list_repos` | read | `per_page?` |
| `get_repo` | read | `owner`, `repo` |
| `list_issues` | read | `owner`, `repo`, `state?`, `per_page?`, `include_pull_requests?` |
| `get_file_contents` | read | `owner`, `repo`, `path`, `ref?` |
| `create_issue` | **write** | `owner`, `repo`, `title`, `body?` |
| `push_file` | **write** | `owner`, `repo`, `path`, `content`, `message`, `branch?` |

`push_file` creates a **real commit**. For a new file it just writes; for an
existing file it reads the current blob sha first, then updates it. Files over
1 MB are rejected up front — that's GitHub's own limit for the contents API.

`get_file_contents` returns a directory listing when the path is a folder, and
truncates files past 200 000 characters so one big file can't eat a context
window.

---

## 1. Get a GitHub token

GitHub → Settings → Developer settings → Personal access tokens → generate one.
Fine-grained, scoped to the repos it should touch:

- **Contents: read/write** — only if you want `push_file`
- **Issues: read/write** — only if you want `create_issue`
- Read-only tokens still get all four read tools

## 2. Deploy to Vercel

```bash
git clone https://github.com/Ankush-das444/GitHub-mcp.git
cd GitHub-mcp
npm install

npm install -g vercel   # if you don't have it
vercel login
vercel --prod
```

Vercel gives you a URL like `https://github-mcp-server-yourname.vercel.app`.
Your MCP endpoint is `https://github-mcp-server-yourname.vercel.app/api/mcp`,
and the dashboard is at the root of that same deployment.

To bake the token in server-side instead of sending it per request:

```bash
vercel env add GITHUB_TOKEN
```

## 3. Test it locally

No Vercel account required — `dev.mjs` serves `public/` and routes `/api/mcp`
to the exact handler Vercel runs:

```bash
npm run serve          # http://localhost:3000
```

Or use Vercel's own runner:

```bash
npm run dev            # vercel dev
```

Then in another terminal:

```bash
# health check — plain JSON, no token needed
curl http://localhost:3000/api/mcp

# the real thing — MCP over POST
curl -X POST http://localhost:3000/api/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer YOUR_GITHUB_PAT" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Both headers matter: the Streamable HTTP transport returns **406** if `Accept`
doesn't list both `application/json` and `text/event-stream`. Replies come back
as an SSE stream (`data: {…}`), so pipe through `grep '^data: '` if you want
just the JSON.

## 4. Run the tests

```bash
npm test
```

They boot `api/mcp.js` and `dev.mjs` behind real HTTP servers and speak MCP to
them: the handshake, `tools/list`, CORS preflight, path traversal, every error
path, and the dashboard's own script in a DOM. The one test that reaches
api.github.com skips itself when there's no network.

## 5. Connect it anywhere — the URL is the whole setup

A remote MCP server is just a URL. You do **not** need a settings file.

- **claude.ai:** Settings → Connectors → *Add custom connector* → paste
  `https://YOUR-DEPLOY.vercel.app/api/mcp`.
- **Claude Desktop / Cursor:** the same "add a server by URL" dialog.

That's it. The only extra field is an optional header —
`Authorization: Bearer <PAT>` — and only if this deployment doesn't carry its
own `GITHUB_TOKEN`. Set the token on Vercel and the bare URL is the entire
configuration.

If some older client genuinely only reads a file, the same URL goes in as:

**Claude Code**

```bash
claude mcp add --transport http github https://YOUR-DEPLOY.vercel.app/api/mcp \
  --header "Authorization: Bearer YOUR_GITHUB_PAT"
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://YOUR-DEPLOY.vercel.app/api/mcp",
      "headers": { "Authorization": "Bearer YOUR_GITHUB_PAT" }
    }
  }
}
```

---

## The dashboard

`public/index.html` is a single file, no build step, no external requests. Open
it at the root of your deployment (or `npm run serve` locally) and it:

- performs a real MCP `initialize` + `tools/list` against the endpoint and shows
  the server name, version, tool count and handshake latency — the flow diagram
  only animates when the handshake actually succeeds
- builds each tool's argument form from the `inputSchema` the server reports, so
  adding a tool server-side adds it to the UI with no frontend change
- runs tool calls for real and shows the exact JSON-RPC request, the response,
  and the equivalent `curl`
- refuses to run `create_issue` or `push_file` until you tick a box acknowledging
  that it writes to GitHub
- keeps your token in `sessionStorage` for the tab only — never `localStorage`,
  never sent anywhere but the endpoint you typed

If the endpoint is unreachable it falls back to the documented tool list and
says so, rather than silently showing a stale "online".

---

## How it behaves under failure

Every failure a tool hits comes back as a normal MCP tool result with
`isError: true` and a human-readable message — never a bare JSON-RPC `-32603`.
A model can only act on what's inside a tool result, and a GitHub 404 is a data
problem, not a protocol problem. So you get:

```
401 from GitHub — the token was rejected. Bad credentials
403 from GitHub — the token lacks a required scope, or the rate limit is exhausted. …
404 from GitHub — wrong owner/repo/path, the branch does not exist, or the token cannot see this resource. …
Invalid arguments for get_repo. owner: Required
```

Argument validation runs **before** auth, so a malformed call is told about the
payload instead of being sent off to discover its token is missing. Obviously
wrong tokens (`Bearer Bearer`, a pasted URL, two tokens in one header) are
rejected before any request leaves the function.

## Notes

- **SDK version.** `@modelcontextprotocol/sdk` moves between releases. This is
  tested against **1.30.0**, resolved from the `^1.12.0` range. If a future major
  breaks the Streamable HTTP signature, pin the version and check the changelog.
- **Stateless by design** (`sessionIdGenerator: undefined`). Each request builds a
  fresh `Server` + transport, so there's no session to persist — which is the
  only thing that works on serverless. Each tool call is self-contained.
- **GET is a health check.** It returns the server identity and tool list as
  JSON. MCP itself is POST-only; `PUT`/`DELETE` get a 405 with an `Allow` header.
- **CORS is open** (`Access-Control-Allow-Origin: *`) and `OPTIONS` preflights
  are answered, because browser-based clients need it. That is safe *because*
  auth is per-request: the server holds no credentials of its own. If you bake
  `GITHUB_TOKEN` into the deployment, tighten `CORS_HEADERS` in `api/mcp.js` to
  your own origin.
- **Never commit your PAT.** Use a Vercel env var, or pass it per request from
  the client config.

## Adding more tools

Add an entry to the `TOOLS` array in `api/mcp.js` — `name`, `description`,
`inputSchema` (JSON schema for the client), `schema` (zod, for runtime
validation), and `handler(octokit, args)`. If it mutates anything, add its name
to `WRITE_TOOLS` so the dashboard gates it. Octokit's REST methods cover almost
everything: <https://octokit.github.io/rest.js>
