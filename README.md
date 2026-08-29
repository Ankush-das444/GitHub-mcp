# github-mcp-server

Your own remote MCP server that talks to GitHub. Runs on Vercel's serverless
functions — no device stays on, no self-hosting.

## What's inside

- `api/mcp.js` — the MCP server (Streamable HTTP transport, stateless — a
  fresh instance spins up per request, which is exactly how serverless works)
- 5 GitHub tools: `list_repos`, `get_repo`, `list_issues`, `create_issue`,
  `get_file_contents`
- Auth: send your GitHub PAT as `Authorization: Bearer <token>` on each
  request, or set a `GITHUB_TOKEN` env var on Vercel if this is just for you

## 1. Get a GitHub token

GitHub → Settings → Developer settings → Personal access tokens → generate
one (fine-grained, scoped to the repos you want it to touch).

## 2. Deploy to Vercel

```bash
npm install -g vercel   # if you don't have it
cd github-mcp-server
vercel login
vercel --prod
```

Vercel gives you a URL like `https://github-mcp-server-yourname.vercel.app`.
Your MCP endpoint is `https://github-mcp-server-yourname.vercel.app/api/mcp`.

If you want the token baked in server-side instead of sent per-request:

```bash
vercel env add GITHUB_TOKEN
```

## 3. Test it locally first (optional)

```bash
vercel dev
```

Then in another terminal:

```bash
curl -X POST http://localhost:3000/api/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_GITHUB_PAT" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

You should get back the 5 tools as JSON.

## 4. Connect it anywhere

Any MCP client that supports remote/HTTP servers can point at your deployed
URL. In Claude (or Claude Code), add it as a custom connector using:

- URL: `https://your-deployment.vercel.app/api/mcp`
- Header: `Authorization: Bearer <your GitHub PAT>` (if you didn't set
  `GITHUB_TOKEN` server-side)

## Adding more tools

Add an entry to the `TOOLS` array in `api/mcp.js` — `name`, `description`,
`inputSchema` (JSON schema for the client), `schema` (zod, for runtime
validation), and `handler(octokit, args)`. Octokit's REST methods cover
almost everything: https://octokit.github.io/rest.js

## Notes

- The `@modelcontextprotocol/sdk` API shifts between versions — if
  `npm install` pulls a newer major version and something breaks, pin the
  version in `package.json` to the one used here (`^1.12.0`) or check the
  SDK's changelog for the Streamable HTTP transport signature.
- This is stateless by design (`sessionIdGenerator: undefined`), which fits
  serverless perfectly but means no persistent session across calls — each
  tool call is a self-contained request. That's fine for GitHub API calls.
- Never commit your PAT. Use Vercel env vars or pass it per-request from the
  client config.
