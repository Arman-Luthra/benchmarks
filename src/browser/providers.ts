import { browserbase } from '@computesdk/browserbase';
import { browseruse } from '@computesdk/browseruse';
import { hyperbrowser } from '@computesdk/hyperbrowser';
import { kernel } from '@computesdk/kernel';
import { notte } from '@computesdk/notte';
import { steel } from '@computesdk/steel';
import type { BrowserProviderConfig } from './types.js';

/**
 * Tilion has no @computesdk package yet; this inline adapter matches the
 * session.create/destroy shape the benchmark expects.
 */
const tilion = (config: { apiKey: string; baseUrl?: string }) => {
  const base = config.baseUrl ?? 'https://tilion-control.fly.dev';
  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
  };
  return {
    session: {
      create: async (_opts: Record<string, unknown> = {}) => {
        const res = await fetch(`${base}/v1/session`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ mode: 'ephemeral' }),
        });
        if (!res.ok) {
          throw new Error(`tilion session create failed: HTTP ${res.status} - ${await res.text()}`);
        }
        const data = await res.json() as { session_id?: string; connect_url?: string };
        if (!data.session_id || !data.connect_url) {
          throw new Error('Invalid tilion session response');
        }
        return { sessionId: data.session_id, connectUrl: data.connect_url };
      },
      destroy: async (sessionId: string) => {
        const res = await fetch(`${base}/v1/session/${sessionId}`, {
          method: 'DELETE',
          headers,
        });
        if (!res.ok) {
          throw new Error(`tilion session destroy failed: HTTP ${res.status} - ${await res.text()}`);
        }
      },
    },
  };
};

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
  },
  // add browser providers above
];
