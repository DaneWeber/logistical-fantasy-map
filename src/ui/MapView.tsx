import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { defaultRidge, uid } from '../engine/doc';
import { cellAt, dist } from '../engine/grid';
import { LANDFORM_PAINT, LANDSEA, type Vec, type WorldDoc } from '../engine/types';
import {
  Scene,
  drawLabel,
  drawLineLabel,
  drawPlaces,
  drawScaleBar,
  drawTerrain,
  paintOverlay,
  screenToWorld,
  strokePolyline,
  worldToScreen,
  type Layers,
  type View,
} from './render';
import type { World } from './useWorld';

export type Tool =
  | 'select'
  | 'place'
  | 'ridge'
  | 'river'
  | 'land'
  | 'sea'
  | 'eraseLandSea'
  | 'plains'
  | 'hills'
  | 'mountains'
  | 'eraseLandform'
  | 'lock'
  | 'unlock'
  | 'measure';

export const BRUSH_TOOLS: Tool[] = ['land', 'sea', 'eraseLandSea', 'plains', 'hills', 'mountains', 'eraseLandform', 'lock', 'unlock'];

export type Selection = { kind: 'place' | 'auto' | 'ridge' | 'river'; id: string } | null;

export interface HoverInfo {
  pos: Vec;
  cell: number;
}

interface Props {
  world: World;
  tool: Tool;
  setTool: (t: Tool) => void;
  brushKm: number;
  layers: Layers;
  selection: Selection;
  setSelection: (s: Selection) => void;
  onHover: (h: HoverInfo | null) => void;
  fitSignal: number;
}

type Drag =
  | { mode: 'pan'; start: Vec; view: View; moved: boolean }
  | { mode: 'place'; id: string; pos: Vec; moved: boolean }
  | { mode: 'vertex'; kind: 'ridge' | 'river'; id: string; index: number; before: WorldDoc }
  | { mode: 'brush'; before: WorldDoc; working: WorldDoc }
  | { mode: 'measure'; a: Vec; b: Vec };

function segDist(p: Vec, a: Vec, b: Vec): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy || 1e-9;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

export function MapView({ world, tool, setTool, brushKm, layers, selection, setSelection, onHover, fitSignal }: Props) {
  const { doc, result, update, commitFrom } = world;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ W: 0, H: 0 });
  const [view, setView] = useState<View>({ cx: doc.settings.widthKm / 2, cy: doc.settings.heightKm / 2, k: 1 });
  const [drawing, setDrawing] = useState<Vec[]>([]);
  const [cursor, setCursor] = useState<Vec | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [dragTick, setDragTick] = useState(0);

  const scene = useMemo(() => (result ? new Scene(result) : null), [result]);
  // Detail tiles arrive from workers; redraw as each one lands.
  const [tileTick, setTileTick] = useState(0);
  useEffect(() => {
    if (!scene) return;
    let queued = false;
    scene.tiles.setListener(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        setTileTick((t) => t + 1);
      });
    });
    return () => scene.dispose();
  }, [scene]);
  const working = dragRef.current?.mode === 'brush' ? dragRef.current.working : doc;
  const overlay = useMemo(() => paintOverlay(working), [working.paint, dragTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fit the whole map in view.
  const fit = useCallback(() => {
    const { W, H } = size;
    const k = Math.min(W / doc.settings.widthKm, H / doc.settings.heightKm) * 0.94;
    setView({ cx: doc.settings.widthKm / 2, cy: doc.settings.heightKm / 2, k });
  }, [size, doc.settings.widthKm, doc.settings.heightKm]);
  const fitted = useRef(false);
  useEffect(() => {
    if (!fitted.current && size.W > 0 && size.H > 0 && wrapRef.current) {
      fitted.current = true;
      fit();
    }
  }, [size, fit]);
  useEffect(() => {
    if (fitSignal) fit();
  }, [fitSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => setSize({ W: el.clientWidth, H: el.clientHeight }));
    ro.observe(el);
    setSize({ W: el.clientWidth, H: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const placePositions = useMemo(() => {
    const m = new Map<string, Vec>();
    for (const p of result?.places ?? []) m.set(p.id, p.pos);
    for (const p of doc.places) if (p.mode === 'fixed' && p.pos) m.set(p.id, p.pos);
    const d = dragRef.current;
    if (d?.mode === 'place') m.set(d.id, d.pos);
    return m;
  }, [result, doc.places, dragTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- drawing
  useEffect(() => {
    const canvas = canvasRef.current!;
    const dpr = window.devicePixelRatio || 1;
    const { W, H } = size;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const ctx = canvas.getContext('2d')!;
    if (scene) drawTerrain(ctx, scene, view, W, H, dpr, layers);
    else {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#d9d2c0';
      ctx.fillRect(0, 0, W, H);
    }

    // World-space edit overlays.
    ctx.setTransform(view.k * dpr, 0, 0, view.k * dpr, (W / 2 - view.cx * view.k) * dpr, (H / 2 - view.cy * view.k) * dpr);
    const paintVisible = layers.features || BRUSH_TOOLS.includes(tool);
    if (paintVisible) {
      ctx.imageSmoothingEnabled = false;
      const pw = working.settings.widthKm;
      const ph = (working.paint.landSea.h / working.paint.landSea.w) * pw;
      ctx.drawImage(overlay, 0, 0, pw, ph);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Map frame.
    const [fx0, fy0] = worldToScreen(view, W, H, [0, 0]);
    const [fx1, fy1] = worldToScreen(view, W, H, [doc.settings.widthKm, result ? result.grid.heightKm : doc.settings.heightKm]);
    ctx.strokeStyle = '#3e3125';
    ctx.lineWidth = 2;
    ctx.strokeRect(fx0, fy0, fx1 - fx0, fy1 - fy0);

    if (layers.features) {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (result) {
        ctx.setLineDash([2, 4]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(90, 80, 70, 0.7)';
        for (const r of result.implicit.ridges) strokePolyline(ctx, r.points, view, W, H);
        ctx.strokeStyle = 'rgba(50, 90, 140, 0.7)';
        for (const r of result.implicit.rivers) strokePolyline(ctx, r.points, view, W, H);
      }
      ctx.setLineDash([8, 5]);
      for (const r of doc.ridges) {
        const sel = selection?.kind === 'ridge' && selection.id === r.id;
        ctx.strokeStyle = sel ? '#c0562b' : 'rgba(150, 60, 30, 0.75)';
        ctx.lineWidth = sel ? 3.5 : 2.5;
        strokePolyline(ctx, r.points, view, W, H);
      }
      for (const r of doc.rivers) {
        const sel = selection?.kind === 'river' && selection.id === r.id;
        ctx.strokeStyle = sel ? '#c0562b' : 'rgba(30, 80, 160, 0.75)';
        ctx.lineWidth = sel ? 3.5 : 2.5;
        strokePolyline(ctx, r.points, view, W, H);
      }
      ctx.setLineDash([]);
    }
    const selFeature =
      selection?.kind === 'ridge' ? doc.ridges.find((r) => r.id === selection.id) : selection?.kind === 'river' ? doc.rivers.find((r) => r.id === selection.id) : undefined;
    if (selFeature) {
      for (const p of selFeature.points) {
        const [x, y] = worldToScreen(view, W, H, p);
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#c0562b';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }

    if (layers.labels) {
      for (const r of doc.rivers) drawLineLabel(ctx, r.points, r.name, view, W, H, 'italic 13px Georgia, serif', '#2f5a80');
      for (const r of doc.ridges) drawLineLabel(ctx, r.points, r.name.toUpperCase(), view, W, H, '600 11px Georgia, serif', '#5a3c25');
    }

    // Rules between places.
    if (layers.rules && result) {
      const status = new Map(result.report.map((s) => [s.id, s]));
      for (const c of doc.constraints) {
        const a = placePositions.get(c.a);
        const b = placePositions.get(c.b);
        if (!a || !b) continue;
        const focus = selection?.kind === 'place' && (selection.id === c.a || selection.id === c.b);
        const ok = status.get(c.id)?.ok;
        ctx.strokeStyle = ok ? `rgba(40, 120, 60, ${focus ? 0.95 : 0.45})` : `rgba(200, 40, 40, ${focus ? 0.95 : 0.6})`;
        ctx.lineWidth = focus ? 2 : 1.2;
        ctx.setLineDash(c.type === 'distance' ? [6, 4] : c.type === 'sameRiver' ? [2, 3] : [10, 3, 2, 3]);
        strokePolyline(ctx, [a, b], view, W, H);
        ctx.setLineDash([]);
        if (focus || !ok) {
          const [mx, my] = worldToScreen(view, W, H, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
          const label = c.type === 'distance' ? `${Math.round(dist(a, b))} km` : c.type === 'sameRiver' ? 'same river' : 'mountains between';
          drawLabel(ctx, label, mx, my, '11px system-ui, sans-serif', ok ? '#1f5f30' : '#b71c1c', 'center');
        }
      }
    }

    if (result) {
      const failing = new Set(result.places.filter((p) => p.unmetSites.length).map((p) => p.id));
      const shown = result.places.map((p) => ({ ...p, pos: placePositions.get(p.id) ?? p.pos }));
      // Newly added places that haven't been generated yet.
      for (const p of doc.places) if (!result.places.some((q) => q.id === p.id) && p.pos) shown.push({ ...p, pos: p.pos, unmetSites: [] });
      drawPlaces(ctx, shown, view, W, H, {
        labels: layers.labels,
        autoTowns: layers.autoTowns,
        selected: selection?.kind === 'place' || selection?.kind === 'auto' ? selection.id : undefined,
        failing,
      });
    }

    if (drawing.length) {
      ctx.strokeStyle = tool === 'river' ? '#1e50a0' : '#963c1e';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([6, 4]);
      strokePolyline(ctx, cursor ? [...drawing, cursor] : drawing, view, W, H);
      ctx.setLineDash([]);
      for (const p of drawing) {
        const [x, y] = worldToScreen(view, W, H, p);
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }

    const d = dragRef.current;
    if (d?.mode === 'measure') {
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      strokePolyline(ctx, [d.a, d.b], view, W, H);
      ctx.setLineDash([]);
      const [x, y] = worldToScreen(view, W, H, d.b);
      drawLabel(ctx, `${Math.round(dist(d.a, d.b))} km`, x + 10, y - 10, '600 13px system-ui, sans-serif', '#222');
    }

    if (cursor && BRUSH_TOOLS.includes(tool)) {
      const [x, y] = worldToScreen(view, W, H, cursor);
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, brushKm * view.k, 0, Math.PI * 2);
      ctx.stroke();
    }

    drawScaleBar(ctx, view, H);
  }, [scene, view, size, layers, doc, result, selection, drawing, cursor, tool, brushKm, overlay, placePositions, working, dragTick, tileTick]);

  // ---------------------------------------------------------------- input
  const toWorld = (e: { clientX: number; clientY: number }): Vec => {
    const r = canvasRef.current!.getBoundingClientRect();
    return screenToWorld(view, size.W, size.H, [e.clientX - r.left, e.clientY - r.top]);
  };

  const hitPlace = (p: Vec): { id: string; auto: boolean } | null => {
    let best: { id: string; auto: boolean } | null = null;
    let bestD = 12 / view.k;
    for (const [id, q] of placePositions) {
      const auto = id.startsWith('auto-');
      if (auto && !layers.autoTowns) continue;
      const d = dist(p, q);
      if (d < bestD) {
        bestD = d;
        best = { id, auto };
      }
    }
    return best;
  };

  const hitFeature = (p: Vec): Selection => {
    const tol = 7 / view.k;
    for (const kind of ['river', 'ridge'] as const) {
      const list = kind === 'ridge' ? doc.ridges : doc.rivers;
      for (const f of list) {
        for (let i = 1; i < f.points.length; i++) if (segDist(p, f.points[i - 1], f.points[i]) < tol) return { kind, id: f.id };
      }
    }
    return null;
  };

  const applyBrush = (d: Extract<Drag, { mode: 'brush' }>, p: Vec) => {
    const doc2 = d.working;
    const layer =
      tool === 'land' || tool === 'sea' || tool === 'eraseLandSea' ? doc2.paint.landSea : tool === 'lock' || tool === 'unlock' ? doc2.paint.lock : doc2.paint.landform;
    const value = {
      land: LANDSEA.land,
      sea: LANDSEA.sea,
      eraseLandSea: 0,
      plains: LANDFORM_PAINT.plains,
      hills: LANDFORM_PAINT.hills,
      mountains: LANDFORM_PAINT.mountains,
      eraseLandform: 0,
      lock: 1,
      unlock: 0,
    }[tool as string]!;
    const cellKm = doc2.settings.widthKm / layer.w;
    const R = brushKm / cellKm;
    const cx = p[0] / cellKm - 0.5;
    const cy = p[1] / cellKm - 0.5;
    const canSnapshot = tool === 'lock' && result && result.grid.w === layer.w && result.grid.h === layer.h;
    for (let y = Math.max(0, Math.floor(cy - R)); y <= Math.min(layer.h - 1, Math.ceil(cy + R)); y++) {
      for (let x = Math.max(0, Math.floor(cx - R)); x <= Math.min(layer.w - 1, Math.ceil(cx + R)); x++) {
        if (Math.hypot(x - cx, y - cy) > R) continue;
        const i = y * layer.w + x;
        if (tool === 'lock' && layer.data[i] === 0) {
          // Freeze the terrain as it is right now.
          if (!canSnapshot) continue;
          if (!doc2.lockHeights || doc2.lockHeights.w !== layer.w) doc2.lockHeights = { w: layer.w, h: layer.h, data: new Float32Array(layer.w * layer.h) };
          doc2.lockHeights.data[i] = result!.baseHeight[i];
        }
        layer.data[i] = value;
      }
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    const p = toWorld(e);
    if (e.button === 1 || e.button === 2 || (e.button === 0 && e.altKey)) {
      if (e.button === 2 && drawing.length) return;
      dragRef.current = { mode: 'pan', start: [e.clientX, e.clientY], view, moved: false };
      return;
    }
    if (tool === 'select') {
      const hp = hitPlace(p);
      if (hp) {
        setSelection({ kind: hp.auto ? 'auto' : 'place', id: hp.id });
        if (!hp.auto) dragRef.current = { mode: 'place', id: hp.id, pos: placePositions.get(hp.id)!, moved: false };
        return;
      }
      const sf =
        selection?.kind === 'ridge' ? doc.ridges.find((r) => r.id === selection.id) : selection?.kind === 'river' ? doc.rivers.find((r) => r.id === selection.id) : undefined;
      if (sf && (selection?.kind === 'ridge' || selection?.kind === 'river')) {
        const index = sf.points.findIndex((q) => dist(q, p) < 8 / view.k);
        if (index >= 0) {
          dragRef.current = { mode: 'vertex', kind: selection.kind, id: sf.id, index, before: doc };
          return;
        }
      }
      const hf = layers.features ? hitFeature(p) : null;
      if (hf) {
        setSelection(hf);
        return;
      }
      dragRef.current = { mode: 'pan', start: [e.clientX, e.clientY], view, moved: false };
    } else if (tool === 'place') {
      const id = uid('place');
      const n = doc.places.length + 1;
      update((d) => ({ ...d, places: [...d.places, { id, name: `Place ${n}`, kind: 'town', mode: 'fixed', pos: p, sites: [] }] }));
      setSelection({ kind: 'place', id });
      setTool('select');
    } else if (tool === 'ridge' || tool === 'river') {
      setDrawing((pts) => [...pts, p]);
    } else if (tool === 'measure') {
      dragRef.current = { mode: 'measure', a: p, b: p };
    } else if (BRUSH_TOOLS.includes(tool)) {
      const clone: WorldDoc = {
        ...doc,
        paint: {
          landSea: { ...doc.paint.landSea, data: doc.paint.landSea.data.slice() },
          landform: { ...doc.paint.landform, data: doc.paint.landform.data.slice() },
          lock: { ...doc.paint.lock, data: doc.paint.lock.data.slice() },
        },
        lockHeights: doc.lockHeights ? { ...doc.lockHeights, data: doc.lockHeights.data.slice() } : undefined,
      };
      const d: Drag = { mode: 'brush', before: doc, working: clone };
      dragRef.current = d;
      applyBrush(d, p);
      setDragTick((t) => t + 1);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = toWorld(e);
    setCursor(p);
    if (result) {
      const inside = p[0] >= 0 && p[1] >= 0 && p[0] < result.grid.widthKm && p[1] < result.grid.heightKm;
      onHover(inside ? { pos: p, cell: cellAt(result.grid, p) } : null);
    }
    const d = dragRef.current;
    if (!d) return;
    if (d.mode === 'pan') {
      const dx = e.clientX - d.start[0];
      const dy = e.clientY - d.start[1];
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      setView({ ...d.view, cx: d.view.cx - dx / d.view.k, cy: d.view.cy - dy / d.view.k });
    } else if (d.mode === 'place') {
      d.pos = p;
      d.moved = true;
      setDragTick((t) => t + 1);
    } else if (d.mode === 'vertex') {
      const list = d.kind === 'ridge' ? 'ridges' : 'rivers';
      update(
        (doc0) => ({
          ...doc0,
          [list]: (doc0[list] as { id: string; points: Vec[] }[]).map((f) =>
            f.id === d.id ? { ...f, points: f.points.map((q, i) => (i === d.index ? p : q)) } : f,
          ),
        }),
        { record: false, regen: false },
      );
    } else if (d.mode === 'brush') {
      applyBrush(d, p);
      setDragTick((t) => t + 1);
    } else if (d.mode === 'measure') {
      d.b = p;
      setDragTick((t) => t + 1);
    }
  };

  const onPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (d.mode === 'pan' && !d.moved && tool === 'select') setSelection(null);
    if (d.mode === 'place' && d.moved) {
      update((doc0) => ({
        ...doc0,
        places: doc0.places.map((pl) => (pl.id === d.id ? { ...pl, pos: d.pos, mode: pl.mode === 'free' ? 'fixed' : pl.mode } : pl)),
      }));
    }
    if (d.mode === 'vertex') {
      const after = doc;
      commitFrom(d.before, after);
    }
    if (d.mode === 'brush') commitFrom(d.before, d.working);
    setDragTick((t) => t + 1);
  };

  const finishDrawing = useCallback(() => {
    const clean = drawing.filter((p, i) => i === 0 || dist(p, drawing[i - 1]) > 2 / view.k);
    setDrawing([]);
    if (clean.length < 2) return;
    if (tool === 'ridge') {
      const id = uid('ridge');
      update((d) => ({
        ...d,
        ridges: [...d.ridges, { id, name: `Ridge ${d.ridges.length + 1}`, points: clean, ...defaultRidge(d.settings) }],
      }));
      setSelection({ kind: 'ridge', id });
    } else if (tool === 'river') {
      const id = uid('river');
      update((d) => ({
        ...d,
        rivers: [...d.rivers, { id, name: `River ${d.rivers.length + 1}`, points: clean, valleyWidthKm: 4 }],
      }));
      setSelection({ kind: 'river', id });
    }
  }, [drawing, tool, update, setSelection, view.k]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!drawing.length) return;
      if (e.key === 'Enter') finishDrawing();
      else if (e.key === 'Escape') setDrawing([]);
      else if (e.key === 'Backspace') {
        e.preventDefault();
        setDrawing((p) => p.slice(0, -1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawing.length, finishDrawing]);

  useEffect(() => setDrawing([]), [tool]);

  const onWheel = (e: React.WheelEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    const s: Vec = [e.clientX - r.left, e.clientY - r.top];
    const before = screenToWorld(view, size.W, size.H, s);
    // From a whole continent down to a few hundred metres across.
    const k = Math.min(2000, Math.max(0.05, view.k * Math.exp(-e.deltaY * 0.0015)));
    const nv = { ...view, k };
    const after = screenToWorld(nv, size.W, size.H, s);
    setView({ k, cx: view.cx + before[0] - after[0], cy: view.cy + before[1] - after[1] });
  };

  const cursorStyle =
    tool === 'select' ? (dragRef.current?.mode === 'pan' ? 'grabbing' : 'default') : BRUSH_TOOLS.includes(tool) ? 'none' : 'crosshair';

  return (
    <div className="map-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        style={{ width: size.W, height: size.H, cursor: cursorStyle }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          setCursor(null);
          onHover(null);
        }}
        onDoubleClick={() => (tool === 'ridge' || tool === 'river') && finishDrawing()}
        onContextMenu={(e) => {
          e.preventDefault();
          if (drawing.length) finishDrawing();
        }}
        onWheel={onWheel}
      />
      {drawing.length > 0 && (
        <div className="map-hint">
          Click to add points · double-click, right-click or Enter to finish · Backspace removes last · Esc cancels
        </div>
      )}
    </div>
  );
}
