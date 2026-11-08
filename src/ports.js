import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const portOpen = (port, host = '127.0.0.1') => new Promise(resolve => {
  const socket = net.connect({ port, host });
  const finish = value => { socket.destroy(); resolve(value); };
  socket.setTimeout(350);
  socket.once('connect', () => finish(true));
  socket.once('error', () => finish(false));
  socket.once('timeout', () => finish(false));
});

// Probe binds, not just connections: an occupied non-HTTP listener also counts.
export async function available(port) {
  // macOS can allow a wildcard bind alongside a specific-address listener.
  if ((await Promise.all([portOpen(port), portOpen(port, '::1')])).some(Boolean)) return false;
  const sockets = [];
  try {
    for (const host of ['0.0.0.0', '::']) {
      const server = net.createServer();
      sockets.push(server);
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen({ port, host, ipv6Only: true, exclusive: true }, resolve);
        });
      } catch (error) {
        if (host === '::' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) continue;
        return false;
      }
    }
    return true;
  } finally {
    await Promise.all(sockets.map(server => new Promise(resolve => server.close(() => resolve()))));
  }
}

export async function choosePort(app, excluded, previous) {
  const start = 20000 + parseInt(app.id.slice(0, 8), 16) % 20000;
  const candidates = [previous, app.port];
  for (let offset = 0; offset < 20000; offset++) candidates.push(20000 + (start - 20000 + offset) % 20000);
  for (const port of new Set(candidates)) {
    if (port && !excluded.has(port) && await available(port)) return port;
  }
  throw new Error('No local server address is available.');
}

// Match listening sockets to the process group we started. An unrelated server
// answering HTTP must never make an app look ready or become its browser URL.
export async function listenersByGroup() {
  const [processes, listeners] = await Promise.all([
    exec('ps', ['-axo', 'pid=,pgid='], { timeout: 4000, maxBuffer: 4 * 1024 * 1024 }),
    exec('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], { timeout: 4000, maxBuffer: 4 * 1024 * 1024 }).catch(error => {
      if (error.code === 1 && !error.stderr) return { stdout: '' };
      throw error;
    }),
  ]);
  const groups = new Map(processes.stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number)));
  const result = new Map();
  let pid;
  for (const line of listeners.stdout.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    if (line[0] !== 'n' || !groups.has(pid)) continue;
    const match = line.match(/:(\d+)$/);
    if (!match) continue;
    const group = groups.get(pid);
    const ports = result.get(group) || new Set();
    ports.add(Number(match[1]));
    result.set(group, ports);
  }
  return result;
}
