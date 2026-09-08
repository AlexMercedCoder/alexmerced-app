/// <reference lib="webworker" />
import { prepareModel, releaseModel, type WhisperSize } from '../../apps/limelight/transcribe';
self.onmessage = async (event: MessageEvent<WhisperSize>) => {
  try { await prepareModel(event.data, progress => self.postMessage({ progress })); releaseModel(); self.postMessage({ done: true }); }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : 'The speech model could not load.' }); }
};
