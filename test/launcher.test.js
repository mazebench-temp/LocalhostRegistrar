import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createLauncher } from '../src/server.js';
import { portOpen } from '../src/manager.js';

const fixture = fileURLToPath(new URL('./fixtures/server.js', import.meta.url));
const serverFile = fileURLToPath(new URL('../src/server.js', import.meta.url));
const cliFile = fileURLToPath(new URL('../bin/localhost.js', import.meta.url));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const command = `${quote(process.execPath)} ${quote(fixture)}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function until(predicate, message = 'condition', timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await delay(75); }
  throw new Error(`Timed out waiting for ${message}`);
}
async function register(root, name, config = {}) {
  const dir = path.join(root, name, '.localhost');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'app.json'), JSON.stringify({ command, port: await freePort(), ...config }));
  return dir;
}
async function setup(t, managerOptions, includeSelf = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'localhost-test-'));
  const launcher = await createLauncher({ root, listenPort: 0, managerOptions, includeSelf });
  const url = `http://127.0.0.1:${launcher.server.address().port}`;
  t.after(async () => { await launcher.close(); await fs.rm(root, { recursive: true, force: true }); });
  // Use http.request so forged Host and Fetch Metadata headers reach the server
  // unchanged; fetch can overwrite these as forbidden browser-style headers.
  const request = (route, method = 'GET', headers = {}) => new Promise((resolve, reject) => {
    const req = http.request(url + route, { method, headers: { ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...headers } }, res => {
      let body = ''; res.on('data', chunk => { body += chunk; });
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(body) }); } catch (error) { reject(error); } });
    });
    req.on('error', reject); req.end(method === 'POST' ? '{}' : undefined);
  });
  return { ...launcher, root, url, request };
}

test('discovery uses each project’s .localhost folder, optional settings and icon', async t => {
  const { root, registry, scan, request } = await setup(t);
  const dir = await register(root, 'Garden', { name: 'My Garden', cwd: 'site', icon: '🌱', color: '#123456', env: { GREETING: 'hello' } });
  await fs.mkdir(path.join(root, 'Garden/site'));
  await register(root, 'Notebook');
  const icon = '<svg xmlns="http://www.w3.org/2000/svg"/>';
  await fs.writeFile(path.join(root, 'Notebook/.localhost/icon.svg'), icon);
  const configFile = path.join(root, 'Notebook/.localhost/app.json');
  const config = JSON.parse(await fs.readFile(configFile)); config.icon = 'icon.svg';
  await fs.writeFile(configFile, JSON.stringify(config));
  await scan();
  const { data } = await request('/api/apps');
  assert.equal(data.apps.length, 2); assert.deepEqual(data.issues, []);
  assert.equal(data.apps[0].name, 'My Garden');
  assert.equal(data.apps[0].cwd, await fs.realpath(path.join(root, 'Garden/site')));
  assert.equal(data.apps[0].emoji, '🌱'); assert.equal(data.apps[0].status, 'stopped');
  assert.equal(data.apps[0].env, undefined, 'environment values stay out of API responses');
  const notebook = data.apps.find(app => app.name === 'Notebook');
  const response = await fetch(`http://127.0.0.1:${registry.serverPort}${notebook.icon}`);
  assert.equal(await response.text(), icon);
  assert.match(response.headers.get('content-security-policy'), /sandbox/);
});

test('invalid registrations are reported while duplicate legacy port hints stay registered', async t => {
  const { root, registry, scan } = await setup(t);
  const sharedPort = await freePort();
  await register(root, 'One', { port: sharedPort }); await register(root, 'Two', { port: sharedPort });
  const broken = await register(root, 'Broken'); await fs.writeFile(path.join(broken, 'app.json'), '{');
  await register(root, 'Typo', { commmand: 'oops' });
  const escaped = await register(root, 'Escape', { icon: '../../external.png' });
  await fs.writeFile(path.join(root, 'external.png'), 'fake image');
  // Existing target outside icon root still cannot be served.
  await fs.writeFile(path.join(root, 'Escape/external.png'), 'fake image');
  await fs.symlink(path.join(root, 'external.png'), path.join(escaped, 'outside.png'));
  await scan();
  assert.equal(registry.apps.size, 2); assert.equal(registry.issues.length, 3);
  assert.ok(registry.issues.some(issue => /Unknown field/.test(issue.message)));
  assert.ok(registry.issues.some(issue => /inside .localhost/.test(issue.message)));
});

test('launch waits for HTTP readiness; repeat launch restarts; stop kills descendants', async t => {
  const { root, scan, manager, request } = await setup(t);
  const appPort = await freePort();
  await register(root, 'NestedServer', { port: appPort, env: { FIXTURE_CHILD: '1' } }); await scan();
  const app = manager.list()[0];
  let response = await request(`/api/apps/${app.id}/launch`, 'POST');
  assert.equal(response.status, 200); assert.equal(response.data.app.status, 'starting');
  await until(() => manager.state(app.id).status === 'running', 'app readiness');
  const first = await (await fetch(app.url)).json();
  assert.match(manager.state(app.id).logs, /Fixture ready/);
  response = await request(`/api/apps/${app.id}/launch`, 'POST');
  assert.equal(response.status, 200);
  await until(() => manager.state(app.id).status === 'running', 'restarted app');
  const second = await (await fetch(app.url)).json(); assert.notEqual(second.pid, first.pid);
  await request(`/api/apps/${app.id}/stop`, 'POST');
  assert.equal(manager.state(app.id).status, 'stopped'); assert.equal(await portOpen(appPort), false);
  await delay(300); assert.equal(await portOpen(appPort), false, 'explicit stop must not auto-restart');
});

test('crashed app restarts automatically and stop cancels queued retries', async t => {
  const { root, scan, manager } = await setup(t, { retryDelay: 400 });
  await register(root, 'Crash'); await scan(); const app = manager.list()[0];
  await manager.launch(app.id); await until(() => manager.state(app.id).status === 'running');
  const first = await (await fetch(app.url)).json(); process.kill(first.pid, 'SIGTERM');
  await until(() => manager.state(app.id).status === 'restarting', 'retry state');
  await until(() => manager.state(app.id).status === 'running', 'automatic restart');
  const second = await (await fetch(app.url)).json(); assert.notEqual(first.pid, second.pid);
  process.kill(second.pid, 'SIGTERM');
  await until(() => manager.state(app.id).status === 'restarting');
  await manager.stop(app.id); await delay(700);
  assert.equal(manager.state(app.id).status, 'stopped'); assert.equal(await portOpen(app.port), false);
});

test('occupied ports automatically move to a free address without stopping unrelated servers', async t => {
  const { root, scan, manager, request } = await setup(t);
  const other = http.createServer((req, res) => res.end('untouched'));
  await new Promise(resolve => other.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => other.close(resolve)));
  const appPort = other.address().port;
  await register(root, 'Conflict', { port: appPort }); await scan(); const app = manager.list()[0];
  const response = await request(`/api/apps/${app.id}/launch`, 'POST');
  assert.equal(response.status, 200);
  assert.notEqual(response.data.app.port, appPort);
  await until(() => manager.state(app.id).status === 'running');
  assert.equal((await (await fetch(manager.list()[0].url)).json()).message, 'Fixture app is ready');
  assert.equal(await (await fetch(app.url)).text(), 'untouched');
});

test('simultaneous launches with the same legacy hint get distinct owned servers', async t => {
  const { root, scan, manager } = await setup(t);
  const sharedPort = await freePort();
  await register(root, 'One', { port: sharedPort });
  await register(root, 'Two', { port: sharedPort });
  await register(root, 'Automatic', { port: undefined });
  await scan();
  const apps = manager.list();
  await Promise.all(apps.map(app => manager.launch(app.id)));
  await until(() => manager.list().every(app => app.status === 'running'));
  const running = manager.list();
  assert.equal(new Set(running.map(app => app.port)).size, 3);
  const pids = await Promise.all(running.map(async app => (await (await fetch(app.url)).json()).pid));
  assert.equal(new Set(pids).size, 3);
  await scan();
  assert.deepEqual(manager.list().map(app => app.url), running.map(app => app.url), 'rescans retain actual endpoints');
});

test('a server choosing its own ephemeral port is discovered without a configuration warning', async t => {
  const { root, scan, manager } = await setup(t);
  await register(root, 'OwnAddress', { port: undefined, path: '/hello', env: { FIXTURE_PORT: '0' } });
  await scan();
  const app = manager.list()[0];
  await manager.launch(app.id);
  const suggested = manager.state(app.id).targetPort;
  await until(() => manager.state(app.id).status === 'running');
  const actual = manager.list()[0];
  assert.notEqual(actual.port, suggested);
  assert.equal(actual.error, null);
  assert.ok(actual.url.endsWith('/hello'));
  assert.equal((await (await fetch(actual.url)).json()).message, 'Fixture app is ready');
});

test('an unrelated HTTP responder cannot satisfy startup readiness', async t => {
  const { root, scan, manager } = await setup(t, { startupTimeout: 1500 });
  await register(root, 'NotAServer', { port: undefined, env: { FIXTURE_HANG: '1' } });
  await scan();
  const app = manager.list()[0];
  await manager.launch(app.id);
  const other = http.createServer((req, res) => res.end('unrelated'));
  await new Promise(resolve => other.listen(manager.state(app.id).targetPort, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => other.close(resolve)));
  let claimedRunning = false;
  const watch = setInterval(() => { claimedRunning ||= manager.state(app.id).status === 'running'; }, 20);
  t.after(() => clearInterval(watch));
  await until(() => manager.state(app.id).status === 'error');
  assert.equal(claimedRunning, false);
  assert.equal(await (await fetch(`http://127.0.0.1:${other.address().port}`)).text(), 'unrelated');
});

test('a port taken between allocation and bind is retried automatically', async t => {
  const { root, scan, manager } = await setup(t);
  await register(root, 'Race', { port: undefined, env: { FIXTURE_DELAY: '600' } });
  await scan();
  const app = manager.list()[0];
  await manager.launch(app.id);
  const firstPort = manager.state(app.id).targetPort;
  const other = http.createServer((req, res) => res.end('untouched'));
  await new Promise(resolve => other.listen(firstPort, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => other.close(resolve)));
  await until(() => manager.state(app.id).status === 'running', 'automatic conflict recovery');
  assert.notEqual(manager.list()[0].port, firstPort);
  assert.equal(manager.list()[0].error, null);
  assert.equal(await (await fetch(`http://127.0.0.1:${firstPort}`)).text(), 'untouched');
});

test('npm workspace dev scripts receive automatic Vite arguments while preserving lifecycle scripts', async t => {
  const { root, scan, manager } = await setup(t);
  const dir = await register(root, 'Workspace', { command: 'npm run dev --workspace @test/site', port: undefined });
  const project = path.dirname(dir);
  const site = path.join(project, 'site');
  await fs.mkdir(path.join(site, 'node_modules/.bin'), { recursive: true });
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ private: true, workspaces: ['site'] }));
  await fs.writeFile(path.join(site, 'package.json'), JSON.stringify({ name: '@test/site', scripts: { predev: 'node -e "require(\'fs\').writeFileSync(\'lifecycle-ran\', \'yes\')"', dev: 'vite --port 3000' } }));
  // A small CLI fixture with Vite's last-value-wins port behavior. The selected
  // address must reach the CLI through npm, not just appear in an env variable.
  await fs.writeFile(path.join(site, 'node_modules/.bin/vite'), `#!${process.execPath}\nprocess.env.FIXTURE_PORT = process.argv[process.argv.lastIndexOf('--port') + 1];\nimport(${JSON.stringify(new URL('./fixtures/server.js', import.meta.url).href)});\n`, { mode: 0o755 });
  await scan();
  const app = manager.list()[0];
  await manager.launch(app.id);
  await until(() => manager.state(app.id).status === 'running', 'workspace dev server');
  assert.notEqual(manager.list()[0].port, 3000);
  assert.equal(manager.list()[0].port, manager.state(app.id).targetPort);
  assert.equal(await fs.readFile(path.join(site, 'lifecycle-ran'), 'utf8'), 'yes');
});

test('Python HTTP server startup needs no port in its command or manifest', async t => {
  const { root, scan, manager } = await setup(t);
  await register(root, 'Python', { command: 'python3 -u -m http.server --bind 127.0.0.1', port: undefined });
  await fs.writeFile(path.join(root, 'Python/index.html'), 'Python is ready');
  await scan();
  const app = manager.list()[0];
  await manager.launch(app.id);
  await until(() => manager.state(app.id).status === 'running', 'Python server');
  assert.equal(await (await fetch(manager.list()[0].url)).text(), 'Python is ready');
  assert.equal(manager.list()[0].port, manager.state(app.id).targetPort);
});

test('startup timeout gives actionable error and stops process', async t => {
  const { root, scan, manager } = await setup(t, { startupTimeout: 700 });
  await register(root, 'NoHttp', { env: { FIXTURE_HANG: '1' } }); await scan(); const app = manager.list()[0];
  await manager.launch(app.id);
  await until(() => manager.state(app.id).status === 'error', 'startup timeout');
  assert.match(manager.state(app.id).error, /did not start an HTTP server/);
  await until(() => !manager.state(app.id).child, 'timed out process exit');
  assert.equal(manager.state(app.id).desired, false);
});

test('stop-all and manifest removal clean up every managed app', async t => {
  const { root, scan, manager, request } = await setup(t);
  await register(root, 'One'); await register(root, 'Two'); await scan();
  const apps = manager.list();
  await Promise.all(apps.map(app => manager.launch(app.id)));
  await until(() => apps.every(app => manager.state(app.id).status === 'running'));
  const response = await request('/api/stop-all', 'POST'); assert.equal(response.status, 200);
  assert.ok(manager.list().every(app => app.status === 'stopped'));
  for (const app of apps) assert.equal(await portOpen(app.port), false);
  await manager.launch(apps[0].id); await until(() => manager.state(apps[0].id).status === 'running');
  await fs.rm(path.join(root, apps[0].project, '.localhost'), { recursive: true }); await scan();
  assert.equal(manager.list().length, 1); assert.equal(await portOpen(apps[0].port), false);
});

test('HTTP API blocks cross-origin commands, rebinding hosts, forms, invalid JSON and traversal', async t => {
  const { url, request } = await setup(t);
  assert.equal((await request('/api/stop-all', 'POST', { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await request('/api/apps', 'GET', { Host: 'evil.example' })).status, 403);
  assert.equal((await request('/api/apps', 'GET', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await request('/api/stop-all', 'POST', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await fetch(url + '/api/stop-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await request('/api/apps/0000000000000000/launch', 'POST')).status, 404);
  assert.equal((await fetch(url + '/src/server.js')).status, 404);
  assert.equal((await fetch(url)).status, 200);
});

test('unexpected daemon death cleans up its detached application group', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'localhost-lifeline-'));
  const launcherPort = await freePort(); const appPort = await freePort();
  await register(root, 'Lifeline', { port: appPort, env: { FIXTURE_CHILD: '1' } });
  const daemon = spawn(process.execPath, [serverFile], { env: { ...process.env, LOCALHOST_PROJECTS_DIR: root, LOCALHOST_PORT: String(launcherPort) }, stdio: 'ignore' });
  t.after(async () => { if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL'); await until(async () => !await portOpen(appPort)); await fs.rm(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${launcherPort}`;
  await until(async () => { try { return (await fetch(url + '/api/health')).ok; } catch { return false; } });
  const { apps } = await (await fetch(url + '/api/apps')).json();
  await fetch(url + `/api/apps/${apps[0].id}/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await until(() => portOpen(appPort));
  const exit = once(daemon, 'exit'); daemon.kill('SIGKILL'); await exit;
  await until(async () => !await portOpen(appPort), 'orphan app cleanup');
});

test('hot config edits preserve the current URL until restart and scanner discovers new apps', async t => {
  const { root, manager, registry } = await setup(t);
  const dir = await register(root, 'HotReload');
  await until(() => registry.apps.size === 1, 'automatic discovery');
  const original = manager.list()[0];
  await manager.launch(original.id); await until(() => manager.state(original.id).status === 'running');
  const nextPort = await freePort();
  await fs.writeFile(path.join(dir, 'app.json'), JSON.stringify({ command, port: nextPort, name: 'Renamed' }));
  await until(() => manager.list()[0]?.configChanged, 'automatic config update');
  assert.equal(manager.list()[0].name, 'Renamed');
  assert.equal(manager.list()[0].url, original.url, 'running app retains its real endpoint');
  await manager.launch(original.id); await until(() => manager.state(original.id).status === 'running');
  assert.equal(manager.list()[0].port, nextPort); assert.equal(manager.list()[0].configChanged, false);
  assert.equal(await portOpen(original.port), false);
});

test('CLI registers without overwriting, starts a persistent daemon, lists and stops apps', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'localhost-cli-'));
  const project = path.join(root, 'CLI project'); await fs.mkdir(project);
  const launcherPort = await freePort(); const appPort = await freePort();
  const env = { ...process.env, LOCALHOST_PROJECTS_DIR: root, LOCALHOST_PORT: String(launcherPort), LOCALHOST_DATA_DIR: path.join(root, '.state') };
  const cli = args => promisify(execFile)(process.execPath, [cliFile, ...args], { cwd: project, env, timeout: 15_000 });
  t.after(async () => { await cli(['shutdown']).catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  await cli(['init', '--port', String(appPort), '--command', command]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(project, '.localhost/app.json'))), { command, port: appPort });
  await assert.rejects(cli(['init', '--port', String(appPort)]), /already exists/);
  assert.match((await cli(['--no-open'])).stdout, /Localhost →/);
  assert.match((await cli(['list'])).stdout, /CLI project/);
  const url = `http://127.0.0.1:${launcherPort}`;
  const { apps } = await (await fetch(url + '/api/apps')).json();
  await fetch(url + `/api/apps/${apps[0].id}/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await until(() => portOpen(appPort));
  assert.match((await cli(['stop', 'CLI project'])).stdout, /Stopped CLI project/);
  assert.equal(await portOpen(appPort), false);
  assert.match((await cli(['stop', 'Localhost'])).stdout, /Stopped Localhost/);
  await until(async () => !await portOpen(launcherPort), 'launcher shutdown');
});

test('localhost init registers a project without asking for a port', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'localhost-auto-init-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { ...process.env, LOCALHOST_PROJECTS_DIR: root, LOCALHOST_PORT: String(await freePort()) };
  await promisify(execFile)(process.execPath, [cliFile, 'init'], { cwd: root, env });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, '.localhost/app.json'))), { command: 'npm run dev' });
});

test('Localhost registers itself on the active port and can shut down itself and its apps', async t => {
  const { root, scan, manager, request, server } = await setup(t, undefined, true);
  const launcherPort = server.address().port;
  const self = manager.list().find(app => app.isSelf);
  assert.ok(self, 'launcher is registered even with a custom projects directory');
  assert.equal(self.name, 'Localhost');
  assert.equal(self.status, 'running');
  assert.equal(self.pid, process.pid);
  assert.equal(self.port, launcherPort);
  assert.equal(self.url, `http://localhost:${launcherPort}/`);
  assert.ok(self.icon);
  const launched = await request(`/api/apps/${self.id}/launch`, 'POST');
  assert.equal(launched.status, 200);
  assert.equal(launched.data.app.pid, self.pid, 'self launch must reuse the current process');
  assert.equal(manager.states.has(self.id), false, 'the launcher is not a managed subprocess');
  await register(root, 'Managed'); await scan();
  assert.equal(manager.list().filter(app => app.isSelf).length, 1);
  const app = manager.list().find(app => !app.isSelf);
  await manager.launch(app.id);
  await until(() => manager.state(app.id).status === 'running');
  const stopped = await request(`/api/apps/${self.id}/stop`, 'POST');
  assert.equal(stopped.status, 200);
  assert.equal(stopped.data.app.status, 'stopped');
  assert.equal(stopped.data.stopped, true);
  await until(async () => !await portOpen(launcherPort), 'self shutdown');
  assert.equal(await portOpen(app.port), false, 'self shutdown also stops managed apps');
});
