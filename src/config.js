import os from 'node:os';
import path from 'node:path';

export const port = Number(process.env.LOCALHOST_PORT || 7777);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('LOCALHOST_PORT must be between 1 and 65535.');
export const projectsDir = path.resolve(process.env.LOCALHOST_PROJECTS_DIR || path.join(os.homedir(), 'code/GitHub'));
export const dataDir = path.resolve(process.env.LOCALHOST_DATA_DIR || path.join(os.homedir(), '.localhost-registrar'));
export const baseURL = `http://localhost:${port}`;
