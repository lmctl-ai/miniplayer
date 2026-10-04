import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function sessionHome(env = process.env) {
  return resolve(env.MINIPLAYER_HOME || join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'miniplayer'));
}

/** Private, atomically replaced native history; no credentials or provider config stored. */
export class SessionStore {
  constructor(home) { this.directory = join(home, 'sessions'); }
  path(id) {
    if (typeof id !== 'string' || !ID.test(id)) throw new Error('Invalid miniplayer session ID');
    return join(this.directory, `${id}.json`);
  }
  create(cwd, model) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const now = new Date().toISOString();
    const session = { version: 2, id: randomUUID(), cwd, ...(model ? { requestedModel: model } : {}),
      createdAt: now, updatedAt: now, turns: [] };
    writeFileSync(this.path(session.id), JSON.stringify(session), { flag: 'wx', mode: 0o600 });
    return session;
  }
  load(id) {
    const path = this.path(id);
    if (!existsSync(path)) throw new Error(`Miniplayer session ${id} does not exist`);
    const session = JSON.parse(readFileSync(path, 'utf8'));
    if (session.version !== 2 || session.id !== id || typeof session.cwd !== 'string'
      || !Array.isArray(session.turns) || session.turns.some(turn => !turn || typeof turn !== 'object'
        || typeof turn.responseId !== 'string' || (turn.nativeResponseId !== undefined && typeof turn.nativeResponseId !== 'string')
        || !['running', 'complete', 'aborted', 'failed'].includes(turn.status)
        || (turn.usageConvention !== undefined && !['input-includes-cache', 'input-excludes-cache', 'unknown', 'synthetic'].includes(turn.usageConvention))
        || (turn.cacheWriteInputTokens !== undefined && !Number.isFinite(turn.cacheWriteInputTokens))
        || typeof turn.input?.text !== 'string' || (turn.output !== undefined && typeof turn.output?.text !== 'string'))) {
      throw new Error(`Invalid miniplayer session ${id}`);
    }
    return session;
  }
  save(session) {
    const path = this.path(session.id);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(session), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, path);
    } finally { rmSync(temporary, { force: true }); }
  }
  /** Refuse concurrent writers, including other ACP processes. Never steal a lease. */
  lock(id) {
    const path = `${this.path(id)}.lock`;
    let fd;
    try {
      fd = openSync(path, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error(`Miniplayer session ${id} is busy (lock: ${path}); a crashed owner's lock requires operator recovery`);
      throw error;
    }
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); }
    catch (error) { closeSync(fd); rmSync(path, { force: true }); throw error; }
    closeSync(fd);
    let released = false;
    return () => { if (!released) { released = true; rmSync(path, { force: true }); } };
  }
}
