import { spawn } from 'node:child_process';

const useShell = process.platform === 'win32';

function run(command, args, label) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    shell: useShell,
    env: process.env
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      console.log(`[${label}] exited with signal ${signal}`);
      return;
    }
    if (code !== null && code !== 0) {
      console.log(`[${label}] exited with code ${code}`);
    }
  });

  return child;
}

const server = run('node', ['scripts/start-server.mjs'], 'server');
const ui = run('npm', ['run', 'dev', '--prefix', 'ui'], 'ui');

function shutdown(signal) {
  if (server) server.kill(signal);
  if (ui) ui.kill(signal);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
