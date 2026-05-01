// Cross-platform `npm run demo` launcher. Sets DEMO=true and spawns server.js
// inheriting stdio so logs stream to the terminal. Forwards SIGINT so Ctrl+C
// in the parent shuts the server cleanly. Curated DEMO_ADDR default lives in
// server.js — no env config required.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, '..', 'server.js');

const child = spawn(process.execPath, [serverPath], {
  stdio: 'inherit',
  env: { ...process.env, DEMO: 'true' },
});

const forward = (sig) => () => { try { child.kill(sig); } catch {} };
process.on('SIGINT', forward('SIGINT'));
process.on('SIGTERM', forward('SIGTERM'));

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
