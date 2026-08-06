#!/usr/bin/env node

import { startSidecarServer } from './server.js';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const rawPort = Number(argument('port') ?? '43170');
if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65_535) {
  console.error('Invalid --port value.');
  process.exit(2);
}

const host = argument('host') ?? '127.0.0.1';
const token = argument('token');
const server = startSidecarServer({ port: rawPort, host, token });

server.once('listening', () => {
  process.stdout.write(`${JSON.stringify({ type: 'ready', host, port: rawPort })}\n`);
});

const stop = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_000).unref();
};

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
