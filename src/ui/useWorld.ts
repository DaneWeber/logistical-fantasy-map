import { useCallback, useEffect, useRef, useState } from 'react';
import { conformDoc, deserialize, serialize } from '../engine/doc';
import { exampleDoc } from '../engine/example';
import type { Vec, WorldDoc, WorldResult } from '../engine/types';

const STORAGE_KEY = 'logistical-fantasy-map.doc';
const HISTORY_LIMIT = 80;

interface History {
  past: WorldDoc[];
  present: WorldDoc;
  future: WorldDoc[];
  /** Bumped whenever the doc changes in a way that needs regenerating. */
  rev: number;
}

function loadInitial(): WorldDoc {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return deserialize(saved);
  } catch {
    // Corrupt or unavailable storage: fall back to the example.
  }
  return exampleDoc();
}

export interface UpdateOpts {
  /** Add an undo step (default true). */
  record?: boolean;
  /** Regenerate the map (default true). */
  regen?: boolean;
}

export function useWorld() {
  const [hist, setHist] = useState<History>(() => ({ past: [], present: loadInitial(), future: [], rev: 0 }));
  const [result, setResult] = useState<WorldResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const reqId = useRef(0);
  const docRef = useRef(hist.present);
  docRef.current = hist.present;

  const update = useCallback((fn: (d: WorldDoc) => WorldDoc, opts: UpdateOpts = {}) => {
    const { record = true, regen = true } = opts;
    setHist((h) => {
      const next = fn(h.present);
      if (next === h.present) return h;
      return {
        past: record ? [...h.past.slice(-HISTORY_LIMIT + 1), h.present] : h.past,
        present: next,
        future: record ? [] : h.future,
        rev: regen ? h.rev + 1 : h.rev,
      };
    });
  }, []);

  /** Replace the doc but record the given earlier state as the undo point (for brush strokes). */
  const commitFrom = useCallback((before: WorldDoc, after: WorldDoc) => {
    setHist((h) => ({
      past: [...h.past.slice(-HISTORY_LIMIT + 1), before],
      present: after,
      future: [],
      rev: h.rev + 1,
    }));
  }, []);

  const undo = useCallback(() => {
    setHist((h) =>
      h.past.length
        ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future], rev: h.rev + 1 }
        : h,
    );
  }, []);
  const redo = useCallback(() => {
    setHist((h) =>
      h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1), rev: h.rev + 1 } : h,
    );
  }, []);

  const replace = useCallback((doc: WorldDoc) => {
    setHist((h) => ({ past: [...h.past, h.present], present: conformDoc(doc), future: [], rev: h.rev + 1 }));
  }, []);

  useEffect(() => {
    const w = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = w;
    w.onmessage = (e: MessageEvent<{ id: number; result?: WorldResult; error?: string }>) => {
      if (e.data.id !== reqId.current) return;
      setBusy(false);
      if (e.data.error) {
        setError(e.data.error);
        return;
      }
      setError(null);
      const r = e.data.result!;
      setResult(r);
      // Remember where floating places landed, so later edits don't shuffle them.
      const hints: Record<string, Vec> = {};
      for (const p of r.places) if (p.mode === 'free' || p.mode === 'near') hints[p.id] = p.pos;
      update((d) => ({ ...d, hints: { ...d.hints, ...hints } }), { record: false, regen: false });
    };
    return () => w.terminate();
  }, [update]);

  // Regenerate (debounced) whenever the doc's content changes.
  useEffect(() => {
    const t = setTimeout(() => {
      const w = workerRef.current;
      if (!w) return;
      reqId.current++;
      setBusy(true);
      w.postMessage({ id: reqId.current, doc: docRef.current });
    }, 150);
    return () => clearTimeout(t);
  }, [hist.rev]);

  // Autosave.
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, serialize(hist.present));
      } catch {
        // Storage full or blocked; saving to a file still works.
      }
    }, 800);
    return () => clearTimeout(t);
  }, [hist.present]);

  return {
    doc: hist.present,
    result,
    busy,
    error,
    canUndo: hist.past.length > 0,
    canRedo: hist.future.length > 0,
    update,
    commitFrom,
    undo,
    redo,
    replace,
  };
}

export type World = ReturnType<typeof useWorld>;
