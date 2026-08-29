import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Octokit } from "octokit";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Auth: the caller supplies a GitHub Personal Access Token in the
// `Authorization: Bearer <token>` header of the MCP request. Nothing is
// stored server-side — each request is stateless, which is what makes this
// safe to run on serverless (no local process, no disk, no session file).
// ---------------------------------------------------------------------------
function getOctokit(req) {
  const auth = req.headers["authorization"] || req.headers["Authorization"];
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "No GitHub token provided. Send 'Authorization: Bearer <PAT>' or set GITHUB_TOKEN env var on the server."
    );
  }
  return new Octokit({ auth: token });
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: "list_repos",
    description: "List repositories for the authenticated GitHub user.",
    inputSchema: {
      type: "object",
      properties: {
        per_page: { type: "number", description: "Max results (default 20)" },
      },
    },
    schema: z.object({ per_page: z.number().optional() }),
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
    schema: z.object({ owner: z.string(), repo: z.string() }),
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
    description: "List issues in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        state: { type: "string", enum: ["open", "closed", "all"] },
      },
      required: ["owner", "repo"],
    },
    schema: z.object({
      owner: z.string(),
      repo: z.string(),
      state: z.enum(["open", "closed", "all"]).optional(),
    }),
    handler: async (octokit, args) => {
      const { data } = await octokit.rest.issues.listForRepo({
        owner: args.owner,
        repo: args.repo,
        state: args.state ?? "open",
        per_page: 30,
      });
      return data.map((i) => ({ number: i.number, title: i.title, state: i.state, url: i.html_url }));
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
      owner: z.string(),
      repo: z.string(),
      title: z.string(),
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
    description: "Read a file's contents from a repository.",
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
      owner: z.string(),
      repo: z.string(),
      path: z.string(),
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
        return data.map((f) => ({ name: f.name, type: f.type, path: f.path }));
      }
      const content = Buffer.from(data.content, data.encoding).toString("utf-8");
      return { path: data.path, content };
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
      owner: z.string(),
      repo: z.string(),
      path: z.string(),
      content: z.string(),
      message: z.string(),
      branch: z.string().optional(),
    }),
    handler: async (octokit, args) => {
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
        commit_sha: data.commit.sha,
        commit_url: data.commit.html_url,
        file_url: data.content.html_url,
      };
    },
  },
];

function buildServer(req) {
  const server = new Server(
    { name: "github-mcp-server", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = TOOLS.find((t) => t.name === request.params.name);
    if (!tool) throw new Error(`Unknown tool: ${request.params.name}`);

    const args = tool.schema.parse(request.params.arguments ?? {});
    // req is captured via closure from the per-request buildServer(req) call
    // below — simpler and more version-proof than threading it through the
    // SDK's handler "extra" context, which varies across SDK releases.
    const octokit = getOctokit(req);
    try {
      const result = await tool.handler(octokit, args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// Vercel serverless entrypoint — stateless: a fresh Server + transport per
// request, since there's no long-lived process to keep session state in.
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: "Method not allowed. MCP uses POST." }));
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
    
