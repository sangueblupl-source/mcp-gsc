import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';

/**
 * Google Analytics 4 tools: reporting (Data API) plus read/write access to
 * property settings (Admin API). Writes require an explicit confirm flag so
 * the assistant has to restate the change and get the user's approval first.
 */

const DATA_API = 'https://analyticsdata.googleapis.com/v1beta';
const ADMIN_API = 'https://analyticsadmin.googleapis.com';

const READ = { readOnlyHint: true, openWorldHint: true } as const;
const WRITE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

// Admin resource paths must start with one of these collections.
const ADMIN_PATH_RE =
  /^(accounts|properties|accountSummaries)(\/[A-Za-z0-9_\-:.~]+)*(:[A-Za-z]+)?$/;

const PROPERTY_SCHEMA = z
  .string()
  .regex(/^(properties\/)?\d+$/)
  .describe("GA4 property ID, e.g. '123456789' or 'properties/123456789'. Use ga4.account_summaries to find it.");

function propertyName(p: string): string {
  return p.startsWith('properties/') ? p : `properties/${p}`;
}

async function gaFetch(
  token: string,
  url: string,
  init: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    /* keep raw text */
  }
  if (!res.ok) {
    throw new Error(`Google Analytics API ${res.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
  }
  return parsed;
}

function ok(data: unknown) {
  const text = JSON.stringify(data, null, 2);
  // Keep responses bounded for MCP clients.
  const bounded = text.length > 90_000 ? `${text.slice(0, 90_000)}\n…[truncated]` : text;
  return { content: [{ type: 'text' as const, text: bounded }] };
}

function err(e: unknown) {
  return {
    content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }],
    isError: true,
  };
}

const JSON_OBJECT = z.record(z.string(), z.unknown());

export const GA4_TOOL_CATALOG = [
  { name: 'ga4.account_summaries', description: 'List GA4 accounts and properties the connected Google account can access.' },
  { name: 'ga4.run_report', description: 'Run a GA4 Data API report (dimensions, metrics, date ranges, filters, ordering).' },
  { name: 'ga4.run_realtime_report', description: 'Run a GA4 realtime report (last 30 minutes).' },
  { name: 'ga4.get_metadata', description: 'List dimensions and metrics (including custom ones) available for a property.' },
  { name: 'ga4.admin_get', description: 'Read any GA4 Admin API resource or list (property settings, data streams, custom dimensions/metrics, key events, retention, links, audiences, etc.).' },
  { name: 'ga4.admin_write', description: 'Create, update, archive or delete GA4 Admin API settings. Requires confirm=true after explicit user approval.' },
] as const;

export function registerGa4Tools(
  server: McpServer,
  getToken: () => Promise<string>,
): void {
  server.registerTool(
    'ga4.account_summaries',
    {
      title: 'List GA4 accounts and properties',
      description:
        'List every Google Analytics account and GA4 property the connected Google account can access, with property IDs needed by the other ga4.* tools.',
      inputSchema: {},
      annotations: READ,
    },
    async () => {
      try {
        const token = await getToken();
        const out: unknown[] = [];
        let pageToken: string | undefined;
        do {
          const url = new URL(`${ADMIN_API}/v1beta/accountSummaries`);
          url.searchParams.set('pageSize', '200');
          if (pageToken) url.searchParams.set('pageToken', pageToken);
          const page = (await gaFetch(token, url.toString())) as {
            accountSummaries?: unknown[];
            nextPageToken?: string;
          };
          out.push(...(page.accountSummaries ?? []));
          pageToken = page.nextPageToken;
        } while (pageToken);
        return ok({ accountSummaries: out });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    'ga4.run_report',
    {
      title: 'Run GA4 report',
      description:
        "Run a GA4 Data API runReport. Pass the request body fields as in Google's RunReportRequest: dateRanges [{startDate,endDate}] (YYYY-MM-DD, 'today', 'yesterday', 'NdaysAgo'), dimensions [{name}], metrics [{name}], optional dimensionFilter, metricFilter, orderBys, limit, offset, keepEmptyRows, comparisons. Use two dateRanges to compare periods. Call ga4.get_metadata to discover valid names.",
      inputSchema: {
        property: PROPERTY_SCHEMA,
        request: JSON_OBJECT.describe('RunReportRequest body (without property).'),
      },
      annotations: READ,
    },
    async ({ property, request }) => {
      try {
        const token = await getToken();
        return ok(
          await gaFetch(token, `${DATA_API}/${propertyName(property)}:runReport`, {
            method: 'POST',
            body: request,
          }),
        );
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    'ga4.run_realtime_report',
    {
      title: 'Run GA4 realtime report',
      description:
        'Run a GA4 runRealtimeReport (last 30 minutes). Body fields: dimensions, metrics, dimensionFilter, metricFilter, limit, orderBys, minuteRanges.',
      inputSchema: {
        property: PROPERTY_SCHEMA,
        request: JSON_OBJECT.describe('RunRealtimeReportRequest body.'),
      },
      annotations: READ,
    },
    async ({ property, request }) => {
      try {
        const token = await getToken();
        return ok(
          await gaFetch(token, `${DATA_API}/${propertyName(property)}:runRealtimeReport`, {
            method: 'POST',
            body: request,
          }),
        );
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    'ga4.get_metadata',
    {
      title: 'GA4 dimensions and metrics',
      description: 'List all dimensions and metrics (standard and custom) usable in reports for a property.',
      inputSchema: { property: PROPERTY_SCHEMA },
      annotations: READ,
    },
    async ({ property }) => {
      try {
        const token = await getToken();
        const meta = (await gaFetch(token, `${DATA_API}/${propertyName(property)}/metadata`)) as {
          dimensions?: { apiName: string; uiName?: string; customDefinition?: boolean }[];
          metrics?: { apiName: string; uiName?: string; customDefinition?: boolean }[];
        };
        const slim = (xs: { apiName: string; uiName?: string; customDefinition?: boolean }[] = []) =>
          xs.map((x) => ({ apiName: x.apiName, uiName: x.uiName, custom: x.customDefinition ?? false }));
        return ok({ dimensions: slim(meta.dimensions), metrics: slim(meta.metrics) });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    'ga4.admin_get',
    {
      title: 'Read GA4 settings',
      description:
        "GET any GA4 Admin API resource or collection. path examples: 'properties/123', 'properties/123/dataStreams', 'properties/123/customDimensions', 'properties/123/customMetrics', 'properties/123/keyEvents', 'properties/123/dataRetentionSettings', 'properties/123/googleSignalsSettings', 'properties/123/googleAdsLinks', 'properties/123/firebaseLinks', 'properties/123/bigQueryLinks', 'properties/123/audiences', 'properties/123/dataStreams/456/measurementProtocolSecrets', 'properties/123/dataStreams/456/enhancedMeasurementSettings', 'properties/123/attributionSettings', 'accounts/789', 'accounts/789/dataSharingSettings'. Use api_version 'v1alpha' for alpha-only resources (audiences, enhanced measurement, attribution, Google Signals, BigQuery links, channel groups, event create rules).",
      inputSchema: {
        path: z.string().regex(ADMIN_PATH_RE).describe('Admin API resource path without version.'),
        api_version: z.enum(['v1beta', 'v1alpha']).default('v1beta'),
        query: z.record(z.string(), z.string()).optional().describe('Optional query params, e.g. {pageSize:"200"}.'),
      },
      annotations: READ,
    },
    async ({ path, api_version, query }) => {
      try {
        const token = await getToken();
        const url = new URL(`${ADMIN_API}/${api_version}/${path}`);
        for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
        return ok(await gaFetch(token, url.toString()));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    'ga4.admin_write',
    {
      title: 'Change GA4 settings',
      description:
        "Create, update, archive or delete GA4 settings via the Admin API. IMPORTANT: before calling, describe the exact change to the user and get explicit approval; then call with confirm=true. Calls without confirm=true are rejected. Examples: create custom dimension -> method POST, path 'properties/123/customDimensions', body {parameterName, displayName, scope:'EVENT'}; create key event -> POST 'properties/123/keyEvents' body {eventName, countingMethod:'ONCE_PER_EVENT'}; set retention -> PATCH 'properties/123/dataRetentionSettings' update_mask 'eventDataRetention' body {eventDataRetention:'FOURTEEN_MONTHS'}; archive custom dimension -> POST 'properties/123/customDimensions/ID:archive'; rename property -> PATCH 'properties/123' update_mask 'displayName'.",
      inputSchema: {
        method: z.enum(['POST', 'PATCH', 'DELETE']),
        path: z.string().regex(ADMIN_PATH_RE).describe('Admin API resource path (may end with :action, e.g. :archive).'),
        api_version: z.enum(['v1beta', 'v1alpha']).default('v1beta'),
        update_mask: z.string().optional().describe('Comma-separated fields for PATCH.'),
        body: JSON_OBJECT.optional(),
        confirm: z.boolean().describe('Must be true, only after the user explicitly approved this exact change.'),
      },
      annotations: WRITE,
    },
    async ({ method, path, api_version, update_mask, body, confirm }) => {
      if (confirm !== true) {
        return err('Not executed: describe the change to the user, get explicit approval, then retry with confirm=true.');
      }
      try {
        const token = await getToken();
        const url = new URL(`${ADMIN_API}/${api_version}/${path}`);
        if (update_mask) url.searchParams.set('updateMask', update_mask);
        const result = await gaFetch(token, url.toString(), {
          method,
          body: method === 'DELETE' ? undefined : (body ?? {}),
        });
        return ok({ executed: { method, path, api_version, update_mask }, result });
      } catch (e) {
        return err(e);
      }
    },
  );
}
