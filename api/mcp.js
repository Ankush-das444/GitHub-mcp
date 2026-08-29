import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Octokit } from "octokit";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------
export const SERVER_INFO = { name: "github-mcp-server", version: "1.1.0" };
const PROTOCOL_VERSION = "2024-11-05";

// Largest file body we'll hand back to a model. Beyond this the tool still
// succeeds but truncates, so a stray 8 MB JSON dump can't blow up a context.
const MAX_FILE_CHARS = 200_000;

// GitHub's contents API is base64, and the write endpoint caps at 1 MB.
const MAX_PUSH_BYTES = 1_000_000;

// ---------------------------------------------------------------------------
// CORS — this endpoint is called from browsers (the /public dashboard) and
// from MCP clients on other origins, so it has to answer preflights.
// ---------------------------------------------------------------------------
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, mcp-session-id, mcp-protocol-version, last-event-id",
  "Access-Control-Expose-Headers": "mcp-session-id, mcp-protocol-version",
  "Access-Control-Max-Age": "86400",
};

function applyCors(res) {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
}

function sendJson(res, status, payload) {
  applyCors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

// ---------------------------------------------------------------------------
// Auth: the caller supplies a GitHub Personal Access Token in the
// `Authorization: Bearer <token>` header of the MCP request. Nothing is
// stored server-side — each request is stateless, which is what makes this
// safe to run on serverless (no local process, no disk, no session file).
// ---------------------------------------------------------------------------
function readToken(req) {
  const header = req?.headers?.["authorization"] ?? req?.headers?.["Authorization"];
  if (typeof header === "string") {
    // RFC 6750 says the scheme is case-insensitive; be forgiving about it
    // and about extra whitespace.
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match?.[1]) return match[1].trim();
  }
  const fromEnv = process.env.GITHUB_TOKEN?.trim();
  return fromEnv || undefined;
}

class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthError";
    this.status = 401;
  }
}

function getOctokit(req) {
  const token = readToken(req);
  if (!token) {
    throw new AuthError(
      "No GitHub token provided. Send 'Authorization: Bearer <PAT>' with the request, " +
        "or set a GITHUB_TOKEN environment variable on the server."
    );
  }
  // Cheap sanity checks that catch the common copy-paste mistakes before we
  // spend a round trip on api.github.com.
  if (/\s/.test(token)) {
    throw new AuthError("The token contains whitespace — it looks like more than one token was pasted.");
  }
  if (/^https?:\/\//i.test(token)) {
    throw new AuthError("That looks like a URL, not a GitHub token.");
  }
  if (/^Bearer$/i.test(token)) {
    throw new AuthError("Got the literal word 'Bearer' as the token. The header should be 'Bearer <PAT>'.");
  }
  return new Octokit({ auth: token });
}

// ---------------------------------------------------------------------------
// Errors: every failure becomes a normal MCP tool result with isError: true,
// never a raw JSON-RPC -32603. Clients (and the models behind them) can only
// react to what's inside a tool result, and a GitHub 404 is a data problem,
// not a protocol problem.
// ---------------------------------------------------------------------------
function describeError(err) {
  const status = err?.status;
  const base = err?.message || String(err);
  if (status === 401) return `401 from GitHub — the token was rejected. ${base}`;
  if (status === 403)
    return `403 from GitHub — the token lacks a required scope, or the rate limit is exhausted. ${base}`;
  if (status === 404)
    return `404 from GitHub — wrong owner/repo/path, the branch does not exist, or the token cannot see this resource. ${base}`;
  if (status === 409) return `409 from GitHub — the repo is empty or the ref conflicts. ${base}`;
  if (status === 422) return `422 from GitHub — a value failed GitHub's own validation. ${base}`;
  if (status >= 500) return `GitHub is having a moment (${status}). ${base}`;
  return base;
}

function toolError(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------
const perPage = z.number().int().min(1).max(100).optional();

const TOOLS = [
  {
    name: "list_repos",
    description: "List repositories for the authenticated GitHub user, most recently updated first.",
    inputSchema: {
      type: "object",
      properties: {
        per_page: { type: "number", description: "Max results, 1-100 (default 20)" },
      },
    },
    schema: z.object({ per_page: perPage }),
    handler: async (octokit, args) => {
      const { data } = await octokit.rest.repos.listForAuthenticatedUser({
        per_page: args.per_page ?? 20,
        sort: "updated",
      });
      return data.map((r) => ({ name: r.full_name, private: r.private, url: r.html_url }));
    },
  },
  {
    name: "get_repo",
    description: "Get details about a specific repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
      },
      required: ["owner", "repo"],
    },
    schema: z.object({ owner: z.string().min(1), repo: z.string().min(1) }),
    handler: async (octokit, args) => {
      const { data } = await octokit.rest.repos.get({ owner: args.owner, repo: args.repo });
      return {
        full_name: data.full_name,
        description: data.description,
        stars: data.stargazers_count,
        open_issues: data.open_issues_count,
        default_branch: data.default_branch,
        url: data.html_url,
      };
    },
  },
  {
    name: "list_issues",
    description: "List issues in a repository. Pull requests are excluded unless you ask for them.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        state: { type: "string", enum: ["open", "closed", "all"] },
        per_page: { type: "number", description: "Max results, 1-100 (default 30)" },
        include_pull_requests: {
          type: "boolean",
          description: "GitHub's issues endpoint also returns PRs; set true to keep them (default false)",
        },
      },
      required: ["owner", "repo"],
    },
    schema: z.object({
      owner: z.string().min(1),
      repo: z.string().min(1),
      state: z.enum(["open", "closed", "all"]).optional(),
      per_page: perPage,
      include_pull_requests: z.boolean().optional(),
    }),
    handler: async (octokit, args) => {
      const { data } = await octokit.rest.issues.listForRepo({
        owner: args.owner,
        repo: args.repo,
        state: args.state ?? "open",
        per_page: args.per_page ?? 30,
      });
      return data
        .filter((i) => args.include_pull_requests || !i.pull_request)
        .map((i) => ({
          number: i.number,
          title: i.title,
          state: i.state,
          url: i.html_url,
        }));
    },
  },
  {
    name: "create_issue",
    description: "Create a new issue in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["owner", "repo", "title"],
    },
    schema: z.object({
      owner: z.string().min(1),
      repo: z.string().min(1),
      title: z.string().min(1),
      body: z.string().optional(),
    }),
    handler: async (octokit, args) => {
      const { data } = await octokit.rest.issues.create({
        owner: args.owner,
        repo: args.repo,
        title: args.title,
        body: args.body,
      });
      return { number: data.number, url: data.html_url };
    },
  },
  {
    name: "get_file_contents",
    description:
      "Read a file's contents from a repository, or list a directory when the path is a folder.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        path: { type: "string" },
        ref: { type: "string", description: "Branch, tag, or commit SHA (optional)" },
      },
      required: ["owner", "repo", "path"],
    },
    schema: z.object({
      owner: z.string().min(1),
      repo: z.string().min(1),
      path: z.string().min(1),
      ref: z.string().optional(),
    }),
    handler: async (octokit, args) => {
      const { data } = await octokit.rest.repos.getContent({
        owner: args.owner,
        repo: args.repo,
        path: args.path,
        ref: args.ref,
      });

      if (Array.isArray(data)) {
        return data.map((f) => ({ name: f.name, type: f.type, path: f.path, size: f.size }));
      }

      // The API omits `content` for files over ~1 MB.
      if (!data.content) {
        return {
          path: data.path,
          size: data.size,
          too_large: true,
          download_url: data.download_url,
          note: "GitHub did not return inline content for a file this large. Use the download_url.",
        };
      }

      const full = Buffer.from(data.content, data.encoding).toString("utf-8");
      if (full.length > MAX_FILE_CHARS) {
        return {
          path: data.path,
          size: data.size,
          truncated: true,
          total_chars: full.length,
          content: full.slice(0, MAX_FILE_CHARS),
          note: `Truncated at ${MAX_FILE_CHARS} characters. Re-read with a narrower path if you need the rest.`,
        };
      }
      return { path: data.path, size: data.size, content: full };
    },
  },
  {
    name: "push_file",
    description:
      "Create or update a single file in a repo, committing it directly to a branch. This is the API equivalent of a git push for one file — it creates a real commit. For a new file, just give the content; for an existing file, this reads its current sha first and updates it.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        path: { type: "string", description: "File path within the repo, e.g. src/index.js" },
        content: { type: "string", description: "Full file content, plain text (not base64)" },
        message: { type: "string", description: "Commit message" },
        branch: { type: "string", description: "Branch to commit to (default: repo's default branch)" },
      },
      required: ["owner", "repo", "path", "content", "message"],
    },
    schema: z.object({
      owner: z.string().min(1),
      repo: z.string().min(1),
      path: z.string().min(1),
      content: z.string(),
      message: z.string().min(1),
      branch: z.string().optional(),
    }),
    handler: async (octokit, args) => {
      const bytes = Buffer.byteLength(args.content, "utf-8");
      if (bytes > MAX_PUSH_BYTES) {
        throw Object.assign(
          new Error(
            `File is ${(bytes / 1024 / 1024).toFixed(2)} MB; GitHub's contents API accepts up to 1 MB per request.`
          ),
          { status: 422 }
        );
      }

      // If the file already exists, GitHub requires its current sha to update it.
      let sha;
      try {
        const existing = await octokit.rest.repos.getContent({
          owner: args.owner,
          repo: args.repo,
          path: args.path,
          ref: args.branch,
        });
        if (!Array.isArray(existing.data)) sha = existing.data.sha;
      } catch (err) {
        if (err.status !== 404) throw err; // 404 just means it's a new file
      }

      const { data } = await octokit.rest.repos.createOrUpdateFileContents({
        owner: args.owner,
        repo: args.repo,
        path: args.path,
        message: args.message,
        content: Buffer.from(args.content, "utf-8").toString("base64"),
        branch: args.branch,
        sha,
      });

      return {
        created: !sha,
        commit_sha: data.commit.sha,
        commit_url: data.commit.html_url,
        file_url: data.content.html_url,
      };
    },
  },
];

// Which tools mutate state — the dashboard uses this to warn before running one.
const WRITE_TOOLS = new Set(["create_issue", "push_file"]);

function buildServer(req) {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = TOOLS.find((t) => t.name === request.params.name);
    if (!tool) {
      return toolError(
        `Unknown tool: ${request.params.name}. Available: ${TOOLS.map((t) => t.name).join(", ")}.`
      );
    }

    // req is captured via closure from the per-request buildServer(req) call
    // below — simpler and more version-proof than threading it through the
    // SDK's handler "extra" context, which varies across SDK releases.
    //
    // Arguments are validated before auth: schema checking is free and local,
    // so a client with a malformed payload is told about the payload instead
    // of being sent off to discover its token is missing first.
    let octokit;
    let args;
    try {
      args = tool.schema.parse(request.params.arguments ?? {});
    } catch (err) {
      if (err?.name === "ZodError") {
        const issues = (err.issues ?? [])
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        return toolError(`Invalid arguments for ${tool.name}. ${issues}`);
      }
      return toolError(describeError(err));
    }

    try {
      octokit = getOctokit(req);
    } catch (err) {
      if (err instanceof AuthError) return toolError(err.message);
      return toolError(describeError(err));
    }

    try {
      const result = await tool.handler(octokit, args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return toolError(`Error in ${tool.name}: ${describeError(err)}`);
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// Vercel serverless entrypoint — stateless: a fresh Server + transport per
// request, since there's no long-lived process to keep session state in.
//
// GET is a health check (used by the dashboard and by uptime monitors).
// MCP itself is POST-only.
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  applyCors(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method === "GET") {
    sendJson(res, 200, {
      status: "ok",
      server: SERVER_INFO,
      protocol: PROTOCOL_VERSION,
      transport: "streamable-http",
      endpoint: "/api/mcp",
      tools: TOOLS.map((t) => ({ name: t.name, writes: WRITE_TOOLS.has(t.name) })),
      auth: readToken(req) ? "token present" : "token required per request",
      hint: "MCP requests go to POST /api/mcp with Accept: application/json, text/event-stream",
    });
    return;
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, GET, OPTIONS");
    sendJson(res, 405, { error: `Method not allowed: ${req.method}. MCP uses POST.` });
    return;
  }

  const server = buildServer(req);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode: no session to persist between calls
  });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

// Exported so the local dev server and the smoke tests can share one source
// of truth with the deployed function.
export { TOOLS, WRITE_TOOLS };
