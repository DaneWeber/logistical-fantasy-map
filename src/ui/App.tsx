import { useCallback, useEffect, useState } from 'react';
import { LANDFORM_NAMES, SITE_KINDS, SITE_LABELS, WATER, type WorldDoc, type WorldResult } from '../engine/types';
import { SITE_BIT } from '../engine/analysis';
import { niceKm } from '../engine/doc';
import { BRUSH_TOOLS, MapView, type HoverInfo, type Selection, type Tool } from './MapView';
import { PlacesPanel, RulesPanel, TerrainPanel, ViewPanel, WorldPanel } from './Panels';
import { DEFAULT_LAYERS, Scene, drawLineLabel, drawPlaces, drawScaleBar, drawTerrain, type Layers } from './render';
import { useWorld } from './useWorld';

const TOOLS: { id: Tool; label: string; icon: string; tip: string; group: string }[] = [
  { id: 'select', label: 'Select', icon: '↖', tip: 'Select, move places, drag to pan (V)', group: 'Edit' },
  { id: 'place', label: 'Place', icon: '◉', tip: 'Drop a place at a fixed spot (P)', group: 'Edit' },
  { id: 'ridge', label: 'Ridge', icon: '⋀', tip: 'Draw a ridge / mountain range (R)', group: 'Edit' },
  { id: 'river', label: 'River', icon: '∿', tip: 'Draw a river, source to mouth (W)', group: 'Edit' },
  { id: 'measure', label: 'Measure', icon: '📏', tip: 'Drag to measure a distance (M)', group: 'Edit' },
  { id: 'land', label: 'Land', icon: '▰', tip: 'Paint land', group: 'Paint' },
  { id: 'sea', label: 'Sea', icon: '≋', tip: 'Paint sea', group: 'Paint' },
  { id: 'eraseLandSea', label: 'Erase', icon: '⌫', tip: 'Erase land/sea paint', group: 'Paint' },
  { id: 'plains', label: 'Plains', icon: '—', tip: 'Paint plains (flat)', group: 'Landform' },
  { id: 'hills', label: 'Hills', icon: '⌒', tip: 'Paint hills', group: 'Landform' },
  { id: 'mountains', label: 'Mtns', icon: '▲', tip: 'Paint mountains', group: 'Landform' },
  { id: 'eraseLandform', label: 'Erase', icon: '⌫', tip: 'Erase landform paint', group: 'Landform' },
  { id: 'lock', label: 'Lock', icon: '🔒', tip: 'Freeze the terrain under the brush', group: 'Lock' },
  { id: 'unlock', label: 'Unlock', icon: '🔓', tip: 'Release frozen terrain', group: 'Lock' },
];

const TABS = ['Places', 'Rules', 'Terrain', 'World', 'View'] as const;
type Tab = (typeof TABS)[number];

function exportPng(result: WorldResult, doc: WorldDoc, layers: Layers) {
  const W = 2400;
  const H = Math.round((W * result.grid.heightKm) / result.grid.widthKm);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  const view = { cx: result.grid.widthKm / 2, cy: result.grid.heightKm / 2, k: W / result.grid.widthKm };
  const scene = new Scene(result);
  drawTerrain(ctx, scene, view, W, H, 1, layers, true);
  scene.dispose();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (layers.labels) {
    for (const r of doc.rivers) drawLineLabel(ctx, r.points, r.name, view, W, H, 'italic 13px Georgia, serif', '#2f5a80');
    for (const r of doc.ridges) drawLineLabel(ctx, r.points, r.name.toUpperCase(), view, W, H, '600 11px Georgia, serif', '#5a3c25');
  }
  drawPlaces(ctx, result.places, view, W, H, { labels: layers.labels, autoTowns: layers.autoTowns, failing: new Set() });
  drawScaleBar(ctx, view, H);
  c.toBlob((b) => {
    if (!b) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = `${doc.name.replace(/[^\w-]+/g, '_') || 'map'}.png`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

function HoverReadout({ hover, result }: { hover: HoverInfo | null; result: WorldResult | null }) {
  if (!hover || !result) return <span className="muted">Hover the map for terrain details</span>;
  const i = hover.cell;
  const water = result.water[i];
  const parts = [`${Math.round(hover.pos[0])}, ${Math.round(hover.pos[1])} km`];
  if (water === WATER.ocean) parts.push('sea');
  else {
    parts.push(`${Math.round(result.height[i])} m`, LANDFORM_NAMES[result.landform[i]]);
    if (result.river[i] && water === WATER.land) parts.push(`river (drains ${Math.round(result.catchment[i]).toLocaleString()} km²)`);
    if (result.ridge[i]) parts.push('on a ridge line');
    parts.push(`${Math.round(result.coastDist[i])} km from the sea`);
    const sites = SITE_KINDS.filter((s) => result.siteMask[i] & SITE_BIT[s] && !['mountains', 'hills', 'valley', 'plain'].includes(s));
    if (sites.length) parts.push(sites.map((s) => SITE_LABELS[s]).join(', '));
  }
  return <span>{parts.join(' · ')}</span>;
}

export function App() {
  const world = useWorld();
  const { doc, result, busy, error, undo, redo, canUndo, canRedo, update } = world;
  const [tool, setTool] = useState<Tool>('select');
  const [tab, setTab] = useState<Tab>('Places');
  const [layers, setLayers] = useState<Layers>(DEFAULT_LAYERS);
  const [selection, setSelectionRaw] = useState<Selection>(null);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  // Brush sizes follow the map's width: 25 km on an 800 km map.
  const mapKm = doc.settings.widthKm;
  const brushMin = niceKm(mapKm / 300);
  const brushMax = niceKm(mapKm / 5);
  const [brushKm, setBrushKm] = useState(() => niceKm(mapKm / 32));
  useEffect(() => setBrushKm(niceKm(mapKm / 32)), [mapKm]);
  const [fitSignal, setFitSignal] = useState(0);

  const setSelection = useCallback((s: Selection) => {
    setSelectionRaw(s);
    if (s?.kind === 'place' || s?.kind === 'auto') setTab((t) => (t === 'Rules' ? t : 'Places'));
    if (s?.kind === 'ridge' || s?.kind === 'river') setTab('Terrain');
  }, []);

  const deleteSelection = useCallback(() => {
    if (!selection) return;
    if (selection.kind === 'place')
      update((d) => ({
        ...d,
        places: d.places.filter((p) => p.id !== selection.id),
        constraints: d.constraints.filter((c) => c.a !== selection.id && c.b !== selection.id),
      }));
    else if (selection.kind === 'ridge') update((d) => ({ ...d, ridges: d.ridges.filter((r) => r.id !== selection.id) }));
    else if (selection.kind === 'river') update((d) => ({ ...d, rivers: d.rivers.filter((r) => r.id !== selection.id) }));
    setSelectionRaw(null);
  }, [selection, update]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if (!mod && (e.key === 'Delete' || (e.key === 'Backspace' && tool === 'select'))) {
        deleteSelection();
      } else if (!mod && e.key === 'Escape' && tool === 'select') {
        setSelectionRaw(null);
      } else if (!mod) {
        const map: Record<string, Tool> = { v: 'select', p: 'place', r: 'ridge', w: 'river', m: 'measure' };
        const nt = map[e.key.toLowerCase()];
        if (nt) setTool(nt);
        if (e.key === '[') setBrushKm((b) => Math.max(brushMin, +(b / 1.15).toPrecision(2)));
        if (e.key === ']') setBrushKm((b) => Math.min(brushMax, +(b * 1.15).toPrecision(2)));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, deleteSelection, tool, brushMin, brushMax]);

  const failingRules = result?.report.filter((s) => !s.ok).length ?? 0;
  const failingPlaces = result?.places.filter((p) => p.unmetSites.length).length ?? 0;

  return (
    <div className="app">
      <header>
        <h1>{doc.name}</h1>
        <div className="row">
          <button onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)">
            ↶ Undo
          </button>
          <button onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)">
            ↷ Redo
          </button>
          <button onClick={() => setFitSignal((s) => s + 1)} title="Fit map to window">
            ⤢ Fit
          </button>
        </div>
        <div className="status">
          {error ? (
            <span className="bad">Error: {error}</span>
          ) : busy ? (
            <span className="busy">Generating…</span>
          ) : result ? (
            <span className={failingRules + failingPlaces ? 'bad' : 'ok'}>
              {failingRules + failingPlaces === 0
                ? `✓ All facts satisfied · ${result.ms} ms`
                : `${failingPlaces ? `${failingPlaces} place(s) off-site` : ''}${failingPlaces && failingRules ? ' · ' : ''}${failingRules ? `${failingRules} rule(s) broken` : ''}`}
            </span>
          ) : null}
        </div>
      </header>
      <nav className="tools">
        {['Edit', 'Paint', 'Landform', 'Lock'].map((grp) => (
          <div key={grp} className="tool-group">
            <div className="tool-group-label">{grp}</div>
            {TOOLS.filter((t) => t.group === grp).map((t) => (
              <button key={t.id} className={tool === t.id ? 'on' : ''} title={t.tip} onClick={() => setTool(t.id)}>
                <span className="ti">{t.icon}</span>
                <span className="tl">{t.label}</span>
              </button>
            ))}
          </div>
        ))}
        {BRUSH_TOOLS.includes(tool) && (
          <div className="tool-group">
            <div className="tool-group-label">Brush {brushKm} km</div>
            <input type="range" min={brushMin} max={brushMax} step={brushMin} value={brushKm} onChange={(e) => setBrushKm(+e.target.value)} />
          </div>
        )}
      </nav>
      <main>
        <MapView
          world={world}
          tool={tool}
          setTool={setTool}
          brushKm={brushKm}
          layers={layers}
          selection={selection}
          setSelection={setSelection}
          onHover={setHover}
          fitSignal={fitSignal}
        />
      </main>
      <aside>
        <div className="tabs">
          {TABS.map((t) => (
            <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {t}
              {t === 'Rules' && failingRules > 0 && <span className="count">{failingRules}</span>}
              {t === 'Places' && failingPlaces > 0 && <span className="count">{failingPlaces}</span>}
            </button>
          ))}
        </div>
        <div className="tab-body">
          {tab === 'Places' && <PlacesPanel world={world} selection={selection} setSelection={setSelection} />}
          {tab === 'Rules' && <RulesPanel world={world} selection={selection} />}
          {tab === 'Terrain' && <TerrainPanel world={world} selection={selection} setSelection={setSelection} />}
          {tab === 'World' && <WorldPanel world={world} onExport={() => result && exportPng(result, doc, layers)} onFit={() => setFitSignal((s) => s + 1)} />}
          {tab === 'View' && <ViewPanel layers={layers} setLayers={setLayers} />}
        </div>
      </aside>
      <footer>
        <HoverReadout hover={hover} result={result} />
      </footer>
    </div>
  );
}
