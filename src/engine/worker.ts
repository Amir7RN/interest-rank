/// <reference lib="webworker" />
import { Engine } from './engine.ts';
import type { FromWorker, ToWorker } from '../types.ts';

/**
 * The engine runs off the main thread so a 500 ms scoring pass on a bad tick
 * can never stall the table or the feed socket.
 */
const engine = new Engine();
let timer: number | null = null;

function post(msg: FromWorker): void {
  (self as unknown as Worker).postMessage(msg);
}

function startClock(): void {
  if (timer !== null) return;
  timer = setInterval(() => {
    post({ type: 'snapshot', snapshot: engine.step(Date.now()) });
  }, 1000) as unknown as number;
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'config':
      engine.configure(msg.config);
      startClock();
      break;
    case 'bars':
      engine.ingest(msg.bars);
      break;
    case 'longChanges':
      engine.setLongChanges(msg.horizon, msg.changes);
      break;
    case 'reset':
      engine.reset();
      break;
  }
};

post({ type: 'ready' });
