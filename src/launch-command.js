import fs from 'node:fs/promises';
import path from 'node:path';

async function packageAt(cwd) {
  try { return JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8')); }
  catch { return {}; }
}

async function workspaceDir(cwd, pkg, target) {
  const patterns = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages || [];
  for (const pattern of patterns) {
    let dirs = [path.resolve(cwd, pattern)];
    if (pattern.endsWith('/*')) {
      const parent = path.resolve(cwd, pattern.slice(0, -2));
      const entries = await fs.readdir(parent, { withFileTypes: true }).catch(() => []);
      dirs = entries.filter(entry => entry.isDirectory()).map(entry => path.join(parent, entry.name));
    }
    for (const dir of dirs) if (target === path.relative(cwd, dir) || target === (await packageAt(dir)).name) return dir;
  }
  return cwd;
}

async function framework(command, cwd, depth = 0) {
  if (depth > 5) return null;
  const script = command.match(/^\s*(?:npm|pnpm|yarn)\s+(?:run\s+)?([\w:-]+)(?:\s|$)/);
  if (script) {
    let pkg = await packageAt(cwd);
    const workspace = command.match(/(?:--workspace(?:=|\s+)|-w\s+)([\w@./-]+)/)?.[1];
    if (workspace) { cwd = await workspaceDir(cwd, pkg, workspace); pkg = await packageAt(cwd); }
    const body = pkg.scripts?.[script[1]];
    if (body) return framework(body, cwd, depth + 1);
  }
  // Only recognized development servers receive CLI flags. Other commands keep
  // their original arguments and their actual listening socket is discovered.
  if (/(?:^|[\s/])vite(?:\s|$)/.test(command) && !/\bvite\s+build\b/.test(command)) return 'vite';
  if (/(?:^|[\s/])next\s+(?:dev|start)\b/.test(command)) return 'next';
  if (/(?:^|[\s/])astro\s+(?:dev|preview)\b/.test(command)) return 'astro';
  return null;
}

export async function launchCommand(app, port) {
  if (/\bpython(?:3(?:\.\d+)?)?\s+(?:-u\s+)?-m\s+http\.server\b/.test(app.command)) {
    return app.command.replace(/(\bpython(?:3(?:\.\d+)?)?\s+(?:-u\s+)?-m\s+http\.server)(?:\s+(?:\d+|"\$PORT"|\$PORT))?/, `$1 ${port}`);
  }
  const kind = await framework(app.command, app.cwd);
  if (!kind) return app.command;
  const flags = `--port ${port}${kind === 'vite' ? ' --strictPort' : ''}`;
  const separator = /^\s*npm\s/.test(app.command) && !/\s--(?:\s|$)/.test(app.command) ? ' -- ' : ' ';
  return app.command + separator + flags;
}
