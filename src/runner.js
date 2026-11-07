// This process shares a process group with the app and watches the daemon's IPC
// lifeline. If the daemon disappears, the entire app group is cleaned up.
import { spawn } from 'node:child_process';

let stopping = false;
function terminate() {
  if (stopping) return;
  stopping = true;
  try { process.kill(-process.pid, 'SIGTERM'); } catch { /* Already gone. */ }
  setTimeout(() => {
    try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(0); }
  }, 1500);
}
process.on('disconnect', terminate);
process.on('SIGTERM', terminate);
process.on('SIGINT', terminate);
const child = spawn(process.argv[2], { shell: process.env.SHELL || '/bin/sh', stdio: ['ignore', 'inherit', 'inherit'] });
child.on('error', error => {
  process.stderr.write(`${error.message}\n`);
  if (process.connected) process.send({ type: 'exit', code: 1, error: error.message });
  terminate();
});
child.on('exit', (code, signal) => {
  if (process.connected) process.send({ type: 'exit', code, signal });
  terminate();
});
