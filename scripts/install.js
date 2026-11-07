import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('../bin/localhost.js', import.meta.url));
const target = path.join(os.homedir(), '.local/bin/localhost');
await fs.mkdir(path.dirname(target), { recursive: true });
await fs.chmod(source, 0o755);
try {
  const existing = await fs.readlink(target);
  if (existing !== source) throw new Error(`${target} already points to ${existing}. Not overwriting it.`);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  await fs.symlink(source, target);
}
console.log(`Installed ${target}\nRun localhost to open your launcher.`);
if (!process.env.PATH.split(path.delimiter).includes(path.dirname(target))) console.log('Add ~/.local/bin to your PATH: export PATH="$HOME/.local/bin:$PATH"');
