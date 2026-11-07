import http from 'node:http';
import { spawn } from 'node:child_process';
if (process.env.FIXTURE_CHILD === '1') {
  spawn(process.execPath, [new URL(import.meta.url).pathname], { env: { ...process.env, FIXTURE_CHILD: '0' }, stdio: 'inherit' });
  setInterval(() => {}, 1000);
} else if (process.env.FIXTURE_HANG === '1') {
  setInterval(() => {}, 1000);
} else {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ pid: process.pid, message: 'Fixture app is ready' }));
  });
  server.listen(Number(process.env.PORT), '127.0.0.1', () => console.log('Fixture ready on', process.env.PORT));
}
