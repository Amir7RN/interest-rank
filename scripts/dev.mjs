#!/usr/bin/env node
/**
 * Start the board and the bridge it needs, together.
 *
 * The board's default feed is Robinhood, and that feed cannot work without the
 * local bridge — a browser has no way to reach Robinhood directly, and no way
 * to start a process on your machine either. Leaving the bridge as a separate
 * manual step meant the first thing a fresh checkout showed you was a dead
 * board and an instruction to go read a README. So this launcher runs both.
 *
 * It does NOT change the deployed story: a page served from GitHub Pages still
 * cannot start anything locally. There, the bridge is yours to run, and the
 * board says so on screen rather than sitting blank.
 *
 * Usage:
 *   node scripts/dev.mjs             # vite dev server + bridge
 *   node scripts/dev.mjs --preview   # vite preview (built output) + bridge
 *   node scripts/dev.mjs --no-bridge # just the web server
 */

import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const PREVIEW = args.includes('--preview');
const WITH_BRIDGE = !args.includes('--no-bridge');
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT ?? 8787);

/** Colour codes are skipped when output is piped, so logs stay greppable. */
const tty = process.stdout.isTTY;
const paint = (code, text) => (tty ? `[${code}m${text}[0m` : text);
const LABEL = {
  bridge: paint('36', '[bridge]'),
  web: paint('35', '[web]   '),
  run: paint('90', '[run]   '),
};

const children = [];
let shuttingDown = false;

main();

async function main() {
  if (WITH_BRIDGE) {
    if (await portInUse(BRIDGE_PORT)) {
      // Reusing it is almost always right: the usual cause is a bridge left
      // running in another terminal, possibly with a live RH_TOKEN this
      // process would not know to pass on.
      log('run', `port ${BRIDGE_PORT} already has a listener — reusing it, not starting a second bridge`);
    } else {
      start('bridge', [path.join(ROOT, 'bridge', 'robinhood-bridge.mjs'), '--port', String(BRIDGE_PORT)]);
    }
  }

  const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  start('web', PREVIEW ? [vite, 'preview'] : [vite]);
}

/** Spawn a Node child and prefix every line it prints. */
function start(name, argv) {
  const child = spawn(process.execPath, argv, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  children.push({ name, child });

  pipe(child.stdout, name);
  pipe(child.stderr, name);

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    log('run', `${name} exited (${signal ?? `code ${code}`}) — stopping the rest`);
    shutdown(typeof code === 'number' ? code : 1);
  });
  child.on('error', (err) => {
    log('run', `could not start ${name}: ${err.message}`);
    shutdown(1);
  });
}

function pipe(stream, name) {
  let buffered = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffered += chunk;
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) log(name, line);
  });
  stream.on('end', () => {
    if (buffered.trim()) log(name, buffered);
  });
}

function log(name, line) {
  console.log(`${LABEL[name] ?? `[${name}]`} ${line}`);
}

/** True when something is already listening, so we don't race it for the port. */
function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(500);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  // Don't let a child that ignores SIGTERM hold the terminal hostage.
  setTimeout(() => process.exit(code), 500).unref();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log('run', 'stopping');
    shutdown(0);
  });
}
