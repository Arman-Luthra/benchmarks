import { browserbase } from '@computesdk/browserbase';
import { browseruse } from '@computesdk/browseruse';
import { hyperbrowser } from '@computesdk/hyperbrowser';
import { kernel } from '@computesdk/kernel';
import { notte } from '@computesdk/notte';
import { steel } from '@computesdk/steel';
import type { BrowserProviderConfig } from './types.js';

/**
 * Tilion Cloud adapter — plain HTTP API, no SDK package.
 * session.create() opens an ephemeral stealth browser and fetches its CDP
 * passthrough URL; session.destroy() tears it down.
 */
function tilion(opts: { apiKey: string; baseUrl?: string }) {
  const base = opts.baseUrl ?? 'https://tilion-control.fly.dev';
  const authHeader = { Authorization: `Bearer ${opts.apiKey}` };
  const jsonHeaders = { ...authHeader, 'Content-Type': 'application/json' };

  return {
    session: {
      async create(_options: Record<string, unknown> = {}) {
        const res = await fetch(`${base}/v1/session`, {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify({ mode: 'ephemeral' }),
        });
        if (!res.ok) throw new Error(`tilion session create failed: ${res.status} ${await res.text()}`);
        const session = await res.json() as { session_id: string };

        const conn = await fetch(`${base}/v1/session/${session.session_id}/connect`, { headers: authHeader });
        if (!conn.ok) throw new Error(`tilion CDP connect failed: ${conn.status} ${await conn.text()}`);
        const { connect_url } = await conn.json() as { connect_url: string };

        return { sessionId: session.session_id, connectUrl: connect_url };
      },
      async destroy(sessionId: string) {
        const res = await fetch(`${base}/v1/session/${sessionId}`, { method: 'DELETE', headers: authHeader });
        if (!res.ok && res.status !== 404) {
          throw new Error(`tilion session destroy failed: ${res.status} ${await res.text()}`);
        }
      },
    },
  };
}

/**
 * Browser provider benchmark configurations.
 *
 * All providers use ComputeSDK's browser packages directly (no ComputeSDK API key).
 */
export const browserProviders: BrowserProviderConfig[] = [
  {
    name: 'browserbase',
    requiredEnvVars: ['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID'],
    createBrowserProvider: () => browserbase({
      apiKey: process.env.BROWSERBASE_API_KEY!,
      projectId: process.env.BROWSERBASE_PROJECT_ID!,
    }),
    sessionCreateOptions: {
      region: 'us-east-1',
      stealth: false,
      recordSession: false,
      enableNativeSelectPolyfill: false,
    },
  },
  {
    name: 'browseruse',
    requiredEnvVars: ['BROWSER_USE_API_KEY'],
    createBrowserProvider: () => browseruse({
      apiKey: process.env.BROWSER_USE_API_KEY!
    }),
    sessionCreateOptions: {
      proxies: false,
      stealth: false,
    },
  },
  {
    name: 'hyperbrowser',
    requiredEnvVars: ['HYPERBROWSER_API_KEY'],
    createBrowserProvider: () => hyperbrowser({
      apiKey: process.env.HYPERBROWSER_API_KEY!
    }),
    sessionCreateOptions: {
      region: 'us-east',
      stealth: false,
    },
  },
  {
    name: 'kernel',
    requiredEnvVars: ['KERNEL_API_KEY'],
    createBrowserProvider: () => kernel({
      apiKey: process.env.KERNEL_API_KEY!
    }),
    sessionCreateOptions: { stealth: false },
  },
  {
    name: 'notte',
    requiredEnvVars: ['NOTTE_API_KEY'],
    createBrowserProvider: () => notte({
      apiKey: process.env.NOTTE_API_KEY!
    }),
    sessionCreateOptions: { stealth: false },
  },
  {
    name: 'steel',
    requiredEnvVars: ['STEEL_API_KEY'],
    createBrowserProvider: () => steel({
      apiKey: process.env.STEEL_API_KEY!
    }),
    sessionCreateOptions: { stealth: false },
  },
  {
    name: 'tilion',
    requiredEnvVars: ['TILION_API_KEY'],
    createBrowserProvider: () => tilion({
      apiKey: process.env.TILION_API_KEY!,
    }),
    sessionCreateOptions: {},
  },
  // add browser providers above
];
