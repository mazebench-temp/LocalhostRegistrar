import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const imageTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const colors = ['#507b68', '#5477b3', '#ad704e', '#8b68a6', '#b15d77', '#658f96', '#b18b3e'];
export class Registry {
  constructor(root, serverPort, { includeSelf = true } = {}) {
    this.root = root;
    this.serverPort = serverPort;
    this.apps = new Map();
    this.issues = [];
    this.selfProjectDir = includeSelf ? fileURLToPath(new URL('../', import.meta.url)) : null;
  }

  async scan() {
    let entries;
    let rootIssue;
    try { entries = await fs.readdir(this.root, { withFileTypes: true }); }
    catch (error) {
      rootIssue = { project: this.root, message: `Cannot scan projects: ${error.message}` };
      this.issues = [rootIssue];
      // Keep already discovered projects during a temporary filesystem failure.
      if (this.apps.size) return;
      entries = [];
    }
    const apps = new Map();
    const issues = rootIssue ? [rootIssue] : [];
    const selfDir = this.selfProjectDir ? await fs.realpath(this.selfProjectDir) : null;
    const projects = new Set(entries.filter(e => !e.name.startsWith('.') && (e.isDirectory() || e.isSymbolicLink())).map(entry => path.join(this.root, entry.name)));
    if (selfDir) projects.add(selfDir);
    await Promise.all([...projects].map(async projectDir => {
      const entry = { name: path.basename(projectDir) };
      const manifest = path.join(projectDir, '.localhost/app.json');
      let raw;
      try { raw = await fs.readFile(manifest, 'utf8'); }
      catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') issues.push({ project: entry.name, message: error.message });
        return;
      }
      try {
        const canonicalProject = await fs.realpath(projectDir);
        const isSelf = selfDir !== null && canonicalProject === selfDir;
        if (Buffer.byteLength(raw) > 64 * 1024) throw new Error('app.json must be smaller than 64 KB.');
        const input = JSON.parse(raw);
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('app.json must be a JSON object.');
        for (const key of Object.keys(input)) if (!['name', 'command', 'port', 'cwd', 'icon', 'color', 'path', 'env'].includes(key)) throw new Error(`Unknown field "${key}". Check the registration guide.`);
        if (typeof input.command !== 'string' || !input.command.trim() || input.command.length > 8192 || input.command.includes('\0')) throw new Error('command must be a nonempty string without null bytes (for example, "npm run dev").');
        if (input.port !== undefined && input.port !== 'auto' && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)) throw new Error('port, if provided, must be "auto" or an integer from 1–65535.');
        if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80)) throw new Error('name must be 1–80 characters.');
        if (input.cwd !== undefined && (typeof input.cwd !== 'string' || !input.cwd.trim())) throw new Error('cwd must be a folder path.');
        const cwd = await fs.realpath(path.resolve(projectDir, input.cwd || '.'));
        if (!(await fs.stat(cwd)).isDirectory()) throw new Error('cwd must point to a directory.');
        if (input.path !== undefined && (typeof input.path !== 'string' || !input.path.startsWith('/') || input.path.startsWith('//') || /[\\\r\n]/.test(input.path))) throw new Error('path must be a local URL path, like /dashboard.');
        if (input.color !== undefined && (typeof input.color !== 'string' || !/^#[a-f0-9]{6}$/i.test(input.color))) throw new Error('color must be a six-digit hex color.');
        if (input.env !== undefined && (!input.env || typeof input.env !== 'object' || Array.isArray(input.env) || Object.entries(input.env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0')))) throw new Error('env must be an object of string values without null bytes.');
        const id = createHash('sha256').update(isSelf ? canonicalProject : projectDir).digest('hex').slice(0, 16);
        let iconFile = null;
        let emoji = null;
        if (input.icon !== undefined && (typeof input.icon !== 'string' || !input.icon.trim() || input.icon.length > 255)) throw new Error('icon must be an emoji or an image filename inside .localhost/.');
        const icon = input.icon || 'icon.png';
        const ext = path.extname(icon).toLowerCase();
        if (imageTypes[ext]) {
          try {
            const iconRoot = await fs.realpath(path.join(projectDir, '.localhost'));
            const file = await fs.realpath(path.resolve(iconRoot, icon));
            if (!file.startsWith(iconRoot + path.sep)) throw new Error('Icon must be inside .localhost/.');
            if ((await fs.stat(file)).size > 2 * 1024 * 1024) throw new Error('Icon must be smaller than 2 MB.');
            iconFile = file;
          } catch (error) { if (input.icon || error.code !== 'ENOENT') throw error; }
        } else if (input.icon) {
          if (input.icon.length > 16 || /[/.\\]/.test(input.icon)) throw new Error('Use an emoji or a PNG, JPG, WEBP, SVG, or ICO filename for icon.');
          emoji = input.icon;
        }
        const appPort = isSelf ? this.serverPort : Number.isInteger(input.port) ? input.port : null;
        apps.set(id, { id, isSelf, name: input.name?.trim() || entry.name, project: entry.name, projectDir, manifest, cwd, command: input.command, port: appPort, path: isSelf ? '/' : input.path || '/', url: appPort ? `http://localhost:${appPort}${isSelf ? '/' : input.path || '/'}` : null, color: input.color || colors[parseInt(id.slice(0, 4), 16) % colors.length], emoji, iconFile, iconType: iconFile ? imageTypes[ext] : null, env: input.env || {}, revision: createHash('sha256').update(raw).digest('hex').slice(0, 8) });
      } catch (error) { issues.push({ project: entry.name, message: error.message }); }
    }));
    this.apps = new Map([...apps].sort((a, b) => a[1].name.localeCompare(b[1].name)));
    this.issues = issues.sort((a, b) => a.project.localeCompare(b.project));
  }
}
