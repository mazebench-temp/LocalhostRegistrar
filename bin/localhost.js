#!/usr/bin/env node
import fs from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { port, baseURL, dataDir, projectsDir } from '../src/config.js';

const serverPath = fileURLToPath(new URL('../src/server.js', import.meta.url));
const args = process.argv.slice(2);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function health() {
  try {
    const response = await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(700) });
    const data = await response.json();
    if (data.service !== 'localhost-registrar') throw new Error('different-service');
    return data;
  } catch (error) {
    if (error.message === 'different-service') throw new Error(`Port ${port} belongs to another service. Set LOCALHOST_PORT to a free port.`);
    return null;
  }
}
async function ensureServer() {
  if (await health()) return;
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(dataDir, 'launcher.log');
  try { if ((await fs.stat(logPath)).size > 2 * 1024 * 1024) await fs.rename(logPath, `${logPath}.1`); } catch { /* First launch. */ }
  const log = openSync(logPath, 'a', 0o600);
  const child = spawn(process.execPath, [serverPath], { detached: true, stdio: ['ignore', log, log], env: process.env });
  closeSync(log);
  let spawnError;
  child.on('error', error => { spawnError = error; });
  child.unref();
  for (let i = 0; i < 40; i++) {
    if (spawnError) throw spawnError;
    await delay(150);
    if (await health()) return;
  }
  throw new Error(`Could not start Localhost. Read ${logPath}.`);
}
async function api(endpoint, method = 'GET') {
  const res = await fetch(baseURL + endpoint, { method, headers: method === 'POST' ? { 'Content-Type': 'application/json' } : {}, body: method === 'POST' ? '{}' : undefined });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || data.app?.error || `Request failed (${res.status}).`);
  return data;
}
async function openBrowser() {
  const child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [baseURL], { stdio: 'ignore', detached: true });
  child.on('error', () => console.log(`Open ${baseURL} in your browser.`));
  child.unref();
}
async function main() {
  const command = args[0];
  if (['--help', '-h', 'help'].includes(command)) {
    console.log(`Localhost — your projects, one home screen\n\n  localhost                   Start the launcher and open your browser\n  localhost --no-open         Start the launcher without opening a browser\n  localhost init             Register this project (command defaults to npm run dev)\n    --command "…" --name "…"  Optional project settings\n  localhost list              List registered apps and their status\n  localhost stop [name|id]     Stop one app, or all apps when omitted\n  localhost shutdown          Stop all apps and the launcher\n\nRegistration: ${projectsDir}/<project>/.localhost/app.json\nExample: { "command": "npm run dev" }\nOptional icon: .localhost/icon.png\n\nSettings: LOCALHOST_PROJECTS_DIR, LOCALHOST_PORT (7777), LOCALHOST_DATA_DIR\nRequires Node.js 22+ on macOS or Linux.`);
    return;
  }
  if (command === 'init') {
    const options = {};
    for (let i = 1; i < args.length; i += 2) {
      if (!['--port', '--command', '--name'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Usage: localhost init [--command "npm run dev"] [--name "My app"]');
      options[args[i].slice(2)] = args[i + 1];
    }
    const appPort = options.port === undefined ? null : Number(options.port);
    if (appPort !== null && (!Number.isInteger(appPort) || appPort < 1 || appPort > 65535)) throw new Error('--port must be an integer from 1–65535. You can omit it for automatic setup.');
    const dir = path.join(process.cwd(), '.localhost');
    await fs.mkdir(dir, { recursive: true });
    const config = { ...(options.name ? { name: options.name } : {}), command: options.command || 'npm run dev', ...(appPort === null ? {} : { port: appPort }) };
    await fs.writeFile(path.join(dir, 'app.json'), JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
    console.log(`Created ${path.join(dir, 'app.json')}\nAdd an optional icon.png alongside it.`);
    if (path.dirname(process.cwd()) !== projectsDir) console.log(`This folder is outside ${projectsDir}. Set LOCALHOST_PROJECTS_DIR to its parent before starting the launcher.`);
    if (await health()) await api('/api/refresh', 'POST');
    return;
  }
  if (command && !['--no-open', 'list', 'stop', 'shutdown'].includes(command)) throw new Error(`Unknown command "${command}". Run localhost --help.`);
  if (command === 'shutdown' || command === 'stop') {
    if (!await health()) { console.log('Localhost is not running.'); return; }
  } else await ensureServer();
  if (command === 'list') {
    const { apps, issues } = await api('/api/apps');
    for (const app of apps) console.log(`${app.status.padEnd(12)} ${app.name.padEnd(24)} ${app.url || ''}  ${app.id}`);
    for (const issue of issues) console.error(`${issue.project}: ${issue.message}`);
    if (!apps.length) console.log(`No apps yet. Add .localhost/app.json to a project in ${projectsDir}.`);
  } else if (command === 'stop') {
    if (!args[1]) { await api('/api/stop-all', 'POST'); console.log('All apps stopped.'); }
    else {
      const { apps } = await api('/api/apps');
      const matches = apps.filter(app => app.id === args[1] || app.name.toLowerCase() === args[1].toLowerCase());
      if (matches.length !== 1) throw new Error('Name is missing or ambiguous. Use an ID from localhost list.');
      await api(`/api/apps/${matches[0].id}/stop`, 'POST'); console.log(`Stopped ${matches[0].name}.`);
    }
  } else if (command === 'shutdown') { await api('/api/shutdown', 'POST'); console.log('Localhost and all apps stopped.'); }
  else { console.log(`Localhost → ${baseURL}`); if (command !== '--no-open') await openBrowser(); }
}
main().catch(error => { console.error(error.code === 'EEXIST' ? '.localhost/app.json already exists; edit it directly.' : error.message); process.exitCode = 1; });
