import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import net from 'node:net';

const runner = fileURLToPath(new URL('./runner.js', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export const portOpen = (port, host = '127.0.0.1') => new Promise(resolve => {
  const socket = net.connect({ port, host });
  const finish = value => { socket.destroy(); resolve(value); };
  socket.setTimeout(350);
  socket.once('connect', () => finish(true));
  socket.once('error', () => finish(false));
  socket.once('timeout', () => finish(false));
});
function ready(url) {
  return new Promise(resolve => {
    const req = http.get(url, { timeout: 1200 }, res => { res.destroy(); resolve(res.statusCode < 500); });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

export class Manager {
  constructor(registry, { startupTimeout = 90_000, retryDelay = 2000 } = {}) {
    this.registry = registry;
    this.states = new Map();
    this.queue = Promise.resolve();
    this.startupTimeout = startupTimeout;
    this.retryDelay = retryDelay;
    this.closing = false;
    this.ticker = setInterval(() => this.checkReadiness(), 500);
    this.ticker.unref();
  }
  serial(task) {
    const result = this.queue.then(task);
    this.queue = result.catch(() => {});
    return result;
  }
  state(id) {
    if (!this.states.has(id)) this.states.set(id, { status: 'stopped', desired: false, child: null, retries: 0, logs: '', error: null, startedAt: null });
    return this.states.get(id);
  }
  log(state, text) { state.logs = (state.logs + text).slice(-64 * 1024); }
  describe(app) {
    if (app.isSelf) return { id: app.id, isSelf: true, name: app.name, project: app.project, cwd: app.cwd, command: app.command, port: this.registry.serverPort, url: `http://localhost:${this.registry.serverPort}/`, color: app.color, emoji: app.emoji, icon: app.iconFile ? `/api/apps/${app.id}/icon?v=${app.revision}` : null, status: this.closing ? 'stopping' : 'running', error: null, pid: process.pid, startedAt: null, retries: 0, configChanged: false };
    const state = this.state(app.id);
    const current = state.config && state.desired ? state.config : app;
    return { id: app.id, name: app.name, project: app.project, cwd: current.cwd, command: current.command, port: current.port, url: current.url, color: app.color, emoji: app.emoji, icon: app.iconFile ? `/api/apps/${app.id}/icon?v=${app.revision}` : null, status: state.status, error: state.error, pid: state.child?.pid || null, startedAt: state.startedAt, retries: state.retries, configChanged: !!state.config && state.desired && state.config.revision !== app.revision };
  }
  list() { return [...this.registry.apps.values()].map(app => this.describe(app)); }
  launch(id) {
    return this.serial(async () => {
      if (this.closing) throw new Error('Launcher is shutting down.');
      const app = this.registry.apps.get(id);
      if (!app) throw new Error('Project is no longer registered.');
      // The launcher already owns this process; never spawn a nested launcher.
      if (app.isSelf) return this.describe(app);
      const state = this.state(id);
      await this.stopState(state);
      state.retries = 0;
      state.error = null;
      state.desired = true;
      await this.spawn(app, state);
      return this.describe(app);
    });
  }
  async spawn(app, state) {
    if (!state.desired || this.closing) return;
    if ((await Promise.all([portOpen(app.port), portOpen(app.port, '::1')])).some(Boolean)) {
      state.status = 'error'; state.desired = false;
      state.error = `Port ${app.port} is already in use. Stop its existing server, then try again.`;
      this.log(state, `\n[localhost] ${state.error}\n`);
      return;
    }
    state.status = 'starting';
    state.config = app;
    state.error = null;
    state.startedAt = new Date().toISOString();
    state.readySince = null;
    this.log(state, `\n[localhost] Starting ${app.command} in ${app.cwd}\n`);
    let child;
    try {
      child = fork(runner, [app.command], { cwd: app.cwd, detached: true, env: { ...process.env, ...app.env, PORT: String(app.port), FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    } catch (error) {
      state.desired = false; state.status = 'error'; state.error = error.message;
      this.log(state, `\n[localhost] ${error.message}\n`);
      return;
    }
    state.child = child;
    child.stdout.on('data', data => this.log(state, data.toString()));
    child.stderr.on('data', data => this.log(state, data.toString()));
    let exitDetail = '';
    child.on('message', message => { if (message.type === 'exit') exitDetail = message.error || (message.signal ? `signal ${message.signal}` : `code ${message.code}`); });
    child.on('error', error => { exitDetail = error.message; this.log(state, `\n[localhost] ${error.message}\n`); });
    const ended = () => {
      if (state.child !== child) return;
      state.child = null;
      if (state.desired && !this.closing) {
        state.retries++;
        state.status = 'restarting';
        const backoff = Math.min(this.retryDelay * 2 ** Math.min(state.retries - 1, 4), 30_000);
        state.error = `Process exited${exitDetail ? ` (${exitDetail})` : ''}. Retrying in ${Math.ceil(backoff / 1000)}s.`;
        this.log(state, `\n[localhost] ${state.error}\n`);
        state.retryTimer = setTimeout(() => this.serial(async () => {
          const current = this.registry.apps.get(app.id);
          if (current && state.desired && !this.closing) await this.spawn(current, state);
        }).catch(error => { state.status = 'error'; state.error = error.message; state.desired = false; }), backoff);
      } else if (state.status !== 'error') state.status = 'stopped';
    };
    child.once('exit', ended);
    child.once('error', ended);
  }
  async checkReadiness() {
    if (this.checking || this.closing) return;
    this.checking = true;
    try {
      await Promise.all([...this.states.values()].map(async state => {
        if (!state.child || !['starting', 'running'].includes(state.status)) return;
        const child = state.child;
        const healthy = await ready(state.config.url);
        if (state.child !== child || !state.desired || !['starting', 'running'].includes(state.status)) return;
        if (healthy) {
          if (state.status === 'starting') { state.status = 'running'; state.readySince = Date.now(); state.error = null; }
          if (Date.now() - state.readySince > 30_000) state.retries = 0;
        } else if (state.status === 'running') {
          state.status = 'starting'; state.startedAt = new Date().toISOString(); state.error = 'Waiting for the app to respond…';
        } else if (Date.now() - Date.parse(state.startedAt) > this.startupTimeout) {
          state.desired = false;
          state.status = 'error';
          state.error = `No HTTP response on port ${state.config.port} after ${Math.round(this.startupTimeout / 1000)}s. Check the command and port in .localhost/app.json.`;
          this.log(state, `\n[localhost] ${state.error}\n`);
          try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already gone. */ }
        }
      }));
    } finally { this.checking = false; }
  }
  async stopState(state) {
    state.desired = false;
    clearTimeout(state.retryTimer);
    const child = state.child;
    if (child) {
      state.status = 'stopping';
      try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      const deadline = Date.now() + 3000;
      while (state.child === child && Date.now() < deadline) await delay(40);
      if (state.child === child) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        await delay(100);
      }
      if (state.child === child) throw new Error('Could not stop the app process. Try again.');
    }
    state.status = 'stopped'; state.error = null; state.startedAt = null; state.retries = 0;
  }
  stop(id) { return this.serial(async () => { const app = this.registry.apps.get(id); if (app?.isSelf) throw new Error('Stop the launcher through its HTTP shutdown route.'); await this.stopState(this.state(id)); return app ? this.describe(app) : { id, status: 'stopped' }; }); }
  stopAll() { return this.serial(async () => { await Promise.all([...this.states.values()].map(state => this.stopState(state))); }); }
  sync() { return this.serial(async () => { for (const [id, state] of this.states) if (!this.registry.apps.has(id)) { await this.stopState(state); this.states.delete(id); } }); }
  async close() { this.closing = true; clearInterval(this.ticker); await this.stopAll(); }
}
