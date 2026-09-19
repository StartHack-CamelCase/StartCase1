import type { LiveSessionOptions } from './live-session-service.js';

export type LiveConnectionOptions = Omit<LiveSessionOptions, 'stateDir'> & { environment?: 'mock' | 'remote' | 'disabled' };

export function liveConnectionFromEnv(env: NodeJS.ProcessEnv = process.env): LiveConnectionOptions {
  const mode = env['VISECA_API_MODE'];
  if (mode === 'disabled') return { environment: 'disabled', baseUrl: '', apiKey: '' };
  if (mode && mode !== 'mock' && mode !== 'remote') throw new Error('VISECA_API_MODE must be mock, remote or disabled.');
  const baseUrl = env['LEASH_BASE_URL'] ?? '';
  if (mode === 'mock') {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new Error('Mock mode requires an explicit loopback HTTP address.');
    }
  }
  return { environment: mode === 'mock' ? 'mock' : 'remote', baseUrl, apiKey: env['TEAM_API_KEY'] ?? '' };
}
