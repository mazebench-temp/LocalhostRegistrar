import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Registry } from './registry.js';
import { Manager } from './manager.js';
import { port, projectsDir, baseURL } from './config.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const files = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/order.js', ['order.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']], ['/favicon.svg', ['favicon.svg', 'image/svg+xml']]]);
export async function createLauncher({ root = projectsDir, listenPort = port, managerOptions, includeSelf = true } = {}) {
  const registry = new Registry(root, listenPort, { includeSelf });
  await registry.scan();
  const manager = new Manager(registry, managerOptions);
  let scanning;
  const scan = () => scanning ||= (async () => { await registry.scan(); await manager.sync(); })().finally(() => { scanning = null; });
  const send = (res, status, data, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
    res.end(type === 'application/json' ? JSON.stringify(data) : data);
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const actualPort = server.address()?.port;
      const hosts = [`localhost:${actualPort}`, `127.0.0.1:${actualPort}`];
      if (!hosts.includes(req.headers.host)) return send(res, 403, { error: 'Use the localhost address to access this launcher.' });
      if ((req.headers.origin && !hosts.map(h => `http://${h}`).includes(req.headers.origin)) || req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, { error: 'Cross-origin requests are not allowed.' });
      if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { error: 'Method not allowed.' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      const pathname = url.pathname;
      if (req.method === 'GET') {
        if (pathname === '/api/health') return send(res, 200, { service: 'localhost-registrar', version: 1, pid: process.pid });
        if (pathname === '/api/apps') return send(res, 200, { apps: manager.list(), issues: registry.issues, projectsDir: root });
        const match = pathname.match(/^\/api\/apps\/([a-f0-9]{16})\/(logs|icon)$/);
        if (match) {
          const app = registry.apps.get(match[1]);
          if (!app) return send(res, 404, { error: 'App not found.' });
          if (match[2] === 'logs') return send(res, 200, { logs: manager.state(app.id).logs });
          if (!app.iconFile) return send(res, 404, { error: 'No icon.' });
          // Recheck containment in case a symlink changed since the last scan.
          const icon = await fs.realpath(app.iconFile);
          const iconRoot = await fs.realpath(path.join(app.projectDir, '.localhost'));
          if (!icon.startsWith(iconRoot + path.sep)) return send(res, 403, { error: 'Icon must be inside .localhost/.' });
          if ((await fs.stat(icon)).size > 2 * 1024 * 1024) return send(res, 413, { error: 'Icon exceeds 2 MB.' });
          res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
          return send(res, 200, await fs.readFile(icon), app.iconType);
        }
        if (files.has(pathname)) {
          const [filename, type] = files.get(pathname);
          return send(res, 200, await fs.readFile(path.join(publicDir, filename)), type);
        }
      } else {
        // JSON-only writes + strict origin/host checks prevent browser form and
        // DNS-rebinding requests from driving the local command runner.
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return send(res, 415, { error: 'Send Content-Type: application/json.' });
        if (Number(req.headers['content-length']) > 1024) return send(res, 413, { error: 'Request is too large.' });
        let body = '';
        for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 1024) return send(res, 413, { error: 'Request is too large.' }); }
        if (body) { try { JSON.parse(body); } catch { return send(res, 400, { error: 'Invalid JSON.' }); } }
        if (pathname === '/api/refresh') { await scan(); return send(res, 200, { apps: manager.list(), issues: registry.issues }); }
        if (pathname === '/api/stop-all') { await manager.stopAll(); return send(res, 200, { apps: manager.list() }); }
        if (pathname === '/api/shutdown') { await manager.close(); send(res, 200, { stopped: true }); setImmediate(() => server.close()); return; }
        const match = pathname.match(/^\/api\/apps\/([a-f0-9]{16})\/(launch|stop)$/);
        if (match) {
          if (!registry.apps.has(match[1])) return send(res, 404, { error: 'App not found.' });
          if (registry.apps.get(match[1]).isSelf && match[2] === 'stop') {
            await manager.close();
            send(res, 200, { app: { ...manager.describe(registry.apps.get(match[1])), status: 'stopped', pid: null }, stopped: true });
            setImmediate(() => server.close());
            return;
          }
          const app = await manager[match[2]](match[1]);
          return send(res, app.status === 'error' ? 409 : 200, { app });
        }
      }
      send(res, 404, { error: 'Not found.' });
    } catch (error) { if (!res.headersSent) send(res, 500, { error: error.message }); else res.end(); }
  });
  server.requestTimeout = 10_000;
  const timer = setInterval(() => scan().catch(error => console.error('Scan:', error.message)), 2000);
  timer.unref();
  server.on('close', () => clearInterval(timer));
  const close = async () => { clearInterval(timer); await manager.close(); await new Promise(resolve => server.close(resolve)); };
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(listenPort, '127.0.0.1', resolve); });
  } catch (error) { clearInterval(timer); await manager.close(); throw error; }
  // Tests can ask the OS for a free port.
  registry.serverPort = server.address().port;
  for (const app of registry.apps.values()) if (app.isSelf) { app.port = registry.serverPort; app.url = `http://localhost:${registry.serverPort}/`; }
  return { server, manager, registry, close, scan };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform === 'win32') throw new Error('Localhost currently supports macOS and Linux. Use WSL on Windows.');
  const launcher = await createLauncher();
  console.log(`Localhost is ready at ${baseURL}\nWatching ${projectsDir}/*/.localhost/app.json`);
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await launcher.close();
    process.exit(0);
  });
}
