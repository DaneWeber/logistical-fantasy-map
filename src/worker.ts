import { generate } from './engine/generate';
import type { WorldDoc } from './engine/types';

self.onmessage = (e: MessageEvent<{ id: number; doc: WorldDoc }>) => {
  const { id, doc } = e.data;
  try {
    self.postMessage({ id, result: generate(doc) });
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
