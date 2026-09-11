/**
 * Helper extension for the standalone system-prompt diagnostic.
 *
 * It runs inside pi so pi's normal module resolver can load discovery.ts and
 * its pi dependencies. The outer Node script intentionally does not import
 * discovery.ts directly: extension packages are available to pi, but are not
 * necessarily on Node's ordinary ESM resolution path when this repository is
 * run from a checkout.
 */

import { mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { randomUUID } from 'node:crypto';
import { discoverAgents } from '../src/core/discovery.ts';

function canonicalCwd(cwd) {
  const resolved = resolvePath(cwd);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function projectTrustedForCwd(cwd, ctx) {
  if (typeof ctx.cwd !== 'string' || canonicalCwd(cwd) !== canonicalCwd(ctx.cwd)) return false;
  if (typeof ctx.isProjectTrusted !== 'function') return false;
  try {
    return ctx.isProjectTrusted() === true;
  } catch {
    return false;
  }
}

export default function resolveAgent(pi) {
  const target = process.env.PI_AGENT_DISCOVERY_FILE;
  if (!target) return;

  pi.on('session_start', (_event, ctx) => {
    let result;
    try {
      const scope = process.env.PI_AGENT_DISCOVERY_SCOPE ?? 'user';
      const cwd = process.env.PI_AGENT_DISCOVERY_CWD ?? process.cwd();
      const name = process.env.PI_AGENT_DISCOVERY_NAME ?? '';
      const projectTrusted = projectTrustedForCwd(cwd, ctx);
      const found = discoverAgents(cwd, scope, { projectTrusted }).agents.find(
        agent => agent.name === name
      );
      result = found
        ? { ok: true, agent: found }
        : { ok: false, error: `Agent not found: ${name}` };
    } catch (error) {
      result = { ok: false, error: String(error?.message ?? error) };
    }

    try {
      mkdirSync(dirname(target), { recursive: true });
      const temporary = `${target}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify(result), { encoding: 'utf8', mode: 0o600 });
      renameSync(temporary, target);
    } finally {
      ctx.shutdown();
    }
  });
}
