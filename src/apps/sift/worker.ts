/**
 * Runs patterns off the main thread.
 *
 * A pattern like (a+)+$ against the wrong input backtracks for longer than the
 * heat death of the sun. There is no way to interrupt a running regular
 * expression, so the only real defence is to run it somewhere that can be
 * terminated, which is what this worker is for.
 */
import { applyReplacement, runPattern } from './model';

export type WorkerRequest = {
  id: number;
  pattern: string;
  flags: string;
  subject: string;
  replacement: string;
};

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const { id, pattern, flags, subject, replacement } = event.data;
  const outcome = runPattern(pattern, flags, subject);
  const replaced = applyReplacement(pattern, flags, subject, replacement);
  self.postMessage({ id, outcome, replaced });
});
