import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';

/**
 * Google Ads API tools: account listing, GAQL reporting, and mutations.
 * Every mutation supports validate_only (dry run) and requires confirm=true,
 * so the assistant must describe the change and get the user's approval first.
 */

export interface GoogleAdsConfig {
  developerToken?: string;
  loginCustomerId?: string;
  apiVersion?: string;
}

const READ = { readOnlyHint: true, openWorldHint: true } as const;
const WRITE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const CUSTOMER_ID = z
  .string()
  .regex(/^\d{3}-?\d{3}-?\d{4}$/)
  .describe("Google Ads customer ID, e.g. '341-203-0164' or '3412030164'. Use ads.list_accounts to find it.");

function cid(id: string): string {
  return id.replace(/-/g, '');
}

function text(data: unknown) {
  const s = JSON.stringify(data, null, 2);
  const bounded = s.length > 90_000 ? `${s.slice(0, 90_000)}\n…[truncated]` : s;
  return { content: [{ type: 'text' as const, text: bounded }] };
}

function fail(e: unknown) {
  return {
    content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }],
    isError: true,
  };
}

export const ADS_TOOL_CATALOG = [
  { name: 'ads.list_accounts', description: 'List Google Ads accounts accessible to the connected Google account (and under the manager account).' },
  { name: 'ads.search', description: 'Run a Google Ads Query Language (GAQL) report: campaigns, ad groups, keywords, search terms, ads, conversions, budgets, assets, settings.' },
  { name: 'ads.mutate', description: 'Create, update or remove Google Ads entities (budgets, bids, campaigns, keywords, negatives, ads, status). Supports dry-run validation; requires confirm=true after user approval.' },
] as const;

export function registerGoogleAdsTools(
  server: McpServer,
  getToken: () => Promise<string>,
  config: GoogleAdsConfig,
): void {
  const version = config.apiVersion || 'v26';
  const base = `https://googleads.googleapis.com/${version}`;

  async function adsFetch(url: string, init: { method?: string; body?: unknown; loginCustomerId?: string } = {}) {
    if (!config.developerToken) {
      throw new Error(
        'Google Ads is not configured yet: the GOOGLE_ADS_DEVELOPER_TOKEN secret is missing on the server.',
      );
    }
    const token = await getToken();
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      'developer-token': config.developerToken,
      'content-type': 'application/json',
    };
    const login = init.loginCustomerId ?? config.loginCustomerId;
    if (login) headers['login-customer-id'] = cid(login);
    const res = await fetch(url, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const raw = await res.text();
    let parsed: unknown = raw;
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      /* keep text */
    }
    if (!res.ok) {
      throw new Error(`Google Ads API ${res.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
    }
    return parsed;
  }

  server.registerTool(
    'ads.list_accounts',
    {
      title: 'List Google Ads accounts',
      description:
        'List Google Ads accounts the connected Google account can access, plus (when a manager account is configured) every client account under it with name, currency, time zone, status and whether it is a manager.',
      inputSchema: {},
      annotations: READ,
    },
    async () => {
      try {
        const accessible = (await adsFetch(`${base}/customers:listAccessibleCustomers`, {
          loginCustomerId: '',
        })) as { resourceNames?: string[] };
        let hierarchy: unknown = null;
        if (config.loginCustomerId) {
          hierarchy = await adsFetch(`${base}/customers/${cid(config.loginCustomerId)}/googleAds:search`, {
            method: 'POST',
            body: {
              query:
                'SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.time_zone, customer_client.status, customer_client.manager, customer_client.level FROM customer_client',
            },
          });
        }
        return text({ accessible: accessible.resourceNames ?? [], manager_hierarchy: hierarchy });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'ads.search',
    {
      title: 'Google Ads report (GAQL)',
      description:
        "Run a Google Ads Query Language query against one account. Examples: \"SELECT campaign.name, campaign.status, metrics.clicks, metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date DURING LAST_30_DAYS\"; search terms: \"SELECT search_term_view.search_term, metrics.clicks, metrics.cost_micros, metrics.conversions FROM search_term_view WHERE segments.date DURING LAST_30_DAYS ORDER BY metrics.cost_micros DESC LIMIT 100\"; keywords: FROM keyword_view with ad_group_criterion.keyword.text. cost_micros / 1,000,000 = account currency. Use segments.date BETWEEN 'YYYY-MM-DD' AND 'YYYY-MM-DD' for custom ranges. Pass page_token from next_page_token to continue.",
      inputSchema: {
        customer_id: CUSTOMER_ID,
        query: z.string().min(10).max(10_000),
        page_token: z.string().optional(),
      },
      annotations: READ,
    },
    async ({ customer_id, query, page_token }) => {
      try {
        const out = (await adsFetch(`${base}/customers/${cid(customer_id)}/googleAds:search`, {
          method: 'POST',
          body: { query, ...(page_token ? { pageToken: page_token } : {}) },
        })) as { results?: unknown[]; nextPageToken?: string; fieldMask?: string };
        return text({
          row_count: out.results?.length ?? 0,
          results: out.results ?? [],
          next_page_token: out.nextPageToken ?? null,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'ads.mutate',
    {
      title: 'Change Google Ads',
      description:
        "Create, update or remove Google Ads entities. IMPORTANT: first call with validate_only=true to check the change, describe the exact change (including money/budget effects) to the user, get explicit approval, then call again with validate_only=false and confirm=true. service defaults to 'googleAds:mutate' with body {mutateOperations:[...]}, e.g. pause a campaign: {mutateOperations:[{campaignOperation:{update:{resourceName:'customers/123/campaigns/456',status:'PAUSED'},updateMask:'status'}}]}; change a budget: {campaignBudgetOperation:{update:{resourceName:'customers/123/campaignBudgets/789',amountMicros:'500000000'},updateMask:'amount_micros'}}; add a negative keyword: {campaignCriterionOperation:{create:{campaign:'customers/123/campaigns/456',negative:true,keyword:{text:'free',matchType:'PHRASE'}}}}. Other services (e.g. 'campaignCriteria:mutate' with {operations:[...]}) can be passed in service.",
      inputSchema: {
        customer_id: CUSTOMER_ID,
        service: z
          .string()
          .regex(/^[A-Za-z]+:mutate[A-Za-z]*$/)
          .default('googleAds:mutate'),
        body: z.record(z.string(), z.unknown()),
        validate_only: z.boolean().default(true),
        confirm: z.boolean().default(false).describe('Must be true for a real (non-validate-only) change, only after explicit user approval.'),
      },
      annotations: WRITE,
    },
    async ({ customer_id, service, body, validate_only, confirm }) => {
      if (!validate_only && confirm !== true) {
        return fail('Not executed: validate first, describe the change to the user, get explicit approval, then retry with validate_only=false and confirm=true.');
      }
      try {
        const result = await adsFetch(`${base}/customers/${cid(customer_id)}/${service}`, {
          method: 'POST',
          body: { ...body, validateOnly: validate_only },
        });
        return text({ executed: !validate_only, validate_only, service, result });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
