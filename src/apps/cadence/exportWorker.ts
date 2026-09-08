/// <reference lib="webworker" />
import { encodeWav, type Samples, type BitDepth } from './wav';
self.onmessage = (event: MessageEvent<{ samples: Samples; depth: BitDepth }>) => {
  try { const bytes = encodeWav(event.data.samples, event.data.depth); self.postMessage({ bytes }, { transfer: [bytes.buffer] }); }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : 'WAV export failed.' }); }
};
