import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { HumanActor } from '../../../packages/contracts/src/simulation.js';
import { AppError } from '../../../packages/contracts/src/errors.js';

const cookieToken = (request?: FastifyRequest) => request?.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('viseca_ui='))?.slice('viseca_ui='.length);

export function createHumanChannel() {
  // One browser cookie, with a separate CSRF-bound actor for each customer tab.
  const sessions = new Map<string, { actors: Map<string, HumanActor>; expires: number }>();
  return {
    issue(customerId: string, reply: FastifyReply, request?: FastifyRequest) {
      for (const [key, session] of sessions) if (session.expires <= Date.now()) sessions.delete(key);
      const existing = cookieToken(request);
      const id = existing && sessions.has(existing) ? existing : randomBytes(32).toString('hex');
      const session = sessions.get(id) ?? { actors: new Map<string, HumanActor>(), expires: 0 };
      const prior = [...session.actors].find(([, actor]) => actor.customer_id === customerId);
      const csrf = prior?.[0] ?? randomBytes(32).toString('hex');
      const actor: HumanActor = prior?.[1] ?? { actor_id: 'LOCAL_UI_' + customerId, role: 'simulated_human', customer_id: customerId, channel: 'local_ui', authenticated_by_server: true };
      session.actors.set(csrf, actor);
      session.expires = Date.now() + 3_600_000;
      sessions.set(id, session);
      reply.header('Set-Cookie', `viseca_ui=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`);
      reply.header('Cache-Control', 'no-store');
      return { csrf, actor, mode: 'human_simulation', notice: 'Demo customer confirmation. This is not bank identity verification.' };
    },
    actor(request: FastifyRequest): HumanActor {
      const token = cookieToken(request);
      const session = token ? sessions.get(token) : undefined;
      const csrf = request.headers['x-csrf-token'];
      const actor = typeof csrf === 'string' ? session?.actors.get(csrf) : undefined;
      if (!session || session.expires <= Date.now() || !actor) throw new AppError(403, 'G03_HUMAN_CHANNEL_REQUIRED', 'Open the customer confirmation page before responding.');
      return actor;
    },
  };
}
export type HumanChannel = ReturnType<typeof createHumanChannel>;
