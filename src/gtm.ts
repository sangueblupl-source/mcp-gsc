import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';

/**
 * Google Tag Manager API v2 tools: read anything, and edit / version /
 * publish with an explicit confirm flag after user approval.
 */

const BASE = 'https://tagmanager.googleapis.com/tagmanager/v2';

const READ = { readOnlyHint: true, openWorldHint: true } as const;
const WRITE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

// accounts, accounts/1/containers/2/workspaces/3/tags/4, ...:publish, ...:create_version
const PATH_RE = /^accounts(\/[A-Za-z0-9_\-]+)*(:[a-z_A-Z]+)?$/;

function out(data: unknown) {
  const s = JSON.stringify(data, null, 2);
  return {
    content: [{ type: 'text' as const, text: s.length > 90_000 ? `${s.slice(0, 90_000)}\n…[truncated]` : s }],
  };
}
function fail(e: unknown) {
  return { content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }], isError: true };
}

export const GTM_TOOL_CATALOG = [
  { name: 'gtm.get', description: 'Read Google Tag Manager accounts, containers, workspaces, tags, triggers, variables, versions, environments, built-in variables.' },
  { name: 'gtm.write', description: 'Create, update or delete GTM entities, create versions and publish. Requires confirm=true after user approval.' },
] as const;

export function registerGtmTools(server: McpServer, getToken: () => Promise<string>): void {
  async function call(method: string, path: string, query?: Record<string, string>, body?: unknown) {
    const url = new URL(`${BASE}/${path}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    const res = await fetch(url.toString(), {
      method,
      headers: { authorization: `Bearer ${await getToken()}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    let parsed: unknown = raw;
    try { parsed = raw ? JSON.parse(raw) : {}; } catch { /* keep text */ }
    if (!res.ok) throw new Error(`Tag Manager API ${res.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
    return parsed;
  }

  server.registerTool(
    'gtm.get',
    {
      title: 'Read Google Tag Manager',
      description:
        "GET any Tag Manager API v2 resource or list. Start with path 'accounts', then 'accounts/A/containers', 'accounts/A/containers/C/workspaces', and inside a workspace: '/tags', '/triggers', '/variables', '/built_in_variables', '/folders', '/templates', '/clients', '/zones', ':status' (pending changes). Versions: 'accounts/A/containers/C/version_headers', 'accounts/A/containers/C/versions/live', 'accounts/A/containers/C/versions/V'. Environments: 'accounts/A/containers/C/environments'.",
      inputSchema: {
        path: z.string().regex(PATH_RE),
        query: z.record(z.string(), z.string()).optional(),
      },
      annotations: READ,
    },
    async ({ path, query }) => {
      try { return out(await call('GET', path, query)); } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    'gtm.write',
    {
      title: 'Change Google Tag Manager',
      description:
        "Create/update/delete GTM entities and publish. IMPORTANT: describe the exact change to the user and get explicit approval first, then call with confirm=true. Edits happen in a workspace and are NOT live until published. Examples: create tag -> POST 'accounts/A/containers/C/workspaces/W/tags' body {name,type:'gaawe',parameter:[...],firingTriggerId:['T']}; update tag -> PUT 'accounts/A/containers/C/workspaces/W/tags/ID' with the full tag body (optionally query {fingerprint}); delete -> DELETE same path; enable built-in vars -> POST 'accounts/A/containers/C/workspaces/W/built_in_variables' query {type:'pageUrl'}; create version -> POST 'accounts/A/containers/C/workspaces/W:create_version' body {name,notes}; publish (goes live on the site) -> POST 'accounts/A/containers/C/versions/V:publish'.",
      inputSchema: {
        method: z.enum(['POST', 'PUT', 'DELETE']),
        path: z.string().regex(PATH_RE),
        query: z.record(z.string(), z.string()).optional(),
        body: z.record(z.string(), z.unknown()).optional(),
        confirm: z.boolean().describe('Must be true, only after the user explicitly approved this exact change.'),
      },
      annotations: WRITE,
    },
    async ({ method, path, query, body, confirm }) => {
      if (confirm !== true) return fail('Not executed: describe the change to the user, get explicit approval, then retry with confirm=true.');
      try {
        return out({ executed: { method, path }, result: await call(method, path, query, method === 'DELETE' ? undefined : (body ?? {})) });
      } catch (e) { return fail(e); }
    },
  );
}
