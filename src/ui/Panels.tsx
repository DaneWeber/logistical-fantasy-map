import { useState, type ReactNode } from 'react';
import { DEFAULT_SETTINGS, deserialize, emptyLayer, newDoc, serialize, uid } from '../engine/doc';
import { exampleDoc } from '../engine/example';
import { makeGrid } from '../engine/grid';
import {
  LANDFORM,
  LANDFORM_NAMES,
  SITE_KINDS,
  SITE_LABELS,
  type Constraint,
  type ConstraintType,
  type Place,
  type PlaceKind,
  type PlaceMode,
  type WorldDoc,
  type WorldSettings,
} from '../engine/types';
import type { Selection } from './MapView';
import { LANDFORM_COLORS, type Layers } from './render';
import type { World } from './useWorld';

// ---------------------------------------------------------------- helpers

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {hint && <span className="hint"> — {hint}</span>}
      </span>
      {children}
    </label>
  );
}

function Slider(props: { label: string; value: number; min: number; max: number; step: number; unit?: string; onChange: (v: number) => void; hint?: string }) {
  const [local, setLocal] = useState<number | null>(null);
  const v = local ?? props.value;
  return (
    <Field label={`${props.label}: ${Number.isInteger(props.step) ? v : v.toFixed(2)}${props.unit ?? ''}`} hint={props.hint}>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={v}
        onChange={(e) => setLocal(+e.target.value)}
        onPointerUp={() => {
          if (local != null) props.onChange(local);
          setLocal(null);
        }}
        onKeyUp={() => {
          if (local != null) props.onChange(local);
          setLocal(null);
        }}
      />
    </Field>
  );
}

function NumberInput({ value, onChange, placeholder }: { value?: number; onChange: (v?: number) => void; placeholder?: string }) {
  return (
    <input
      type="number"
      className="num"
      value={value ?? ''}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value === '' ? undefined : Math.max(0, +e.target.value))}
    />
  );
}

const KIND_ICON: Record<PlaceKind, string> = { city: '◉', town: '●', village: '○', fort: '■', landmark: '▲' };
const MODE_TEXT: Record<PlaceMode, string> = { fixed: 'fixed', near: 'near', free: 'free' };

// ---------------------------------------------------------------- places

export function PlacesPanel({ world, selection, setSelection }: { world: World; selection: Selection; setSelection: (s: Selection) => void }) {
  const { doc, result, update } = world;
  const status = new Map(result?.places.map((p) => [p.id, p]) ?? []);
  const selected = selection?.kind === 'place' ? doc.places.find((p) => p.id === selection.id) : undefined;
  const auto = result?.places.filter((p) => p.mode === 'auto') ?? [];
  const selectedAuto = selection?.kind === 'auto' ? auto.find((p) => p.id === selection.id) : undefined;

  const setPlace = (id: string, patch: Partial<Place>) =>
    update((d) => ({ ...d, places: d.places.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));

  const addFree = () => {
    const id = uid('place');
    update((d) => ({ ...d, places: [...d.places, { id, name: `Place ${d.places.length + 1}`, kind: 'town', mode: 'free', sites: [] }] }));
    setSelection({ kind: 'place', id });
  };

  const keepAuto = (id: string) => {
    const a = auto.find((p) => p.id === id);
    if (!a) return;
    const nid = uid('place');
    update((d) => ({ ...d, places: [...d.places, { id: nid, name: a.name, kind: a.kind, mode: 'fixed', pos: a.pos, sites: [] }] }));
    setSelection({ kind: 'place', id: nid });
  };

  return (
    <div className="panel">
      <p className="help">
        Use the <b>Place</b> tool to drop a town at a fixed spot, or add a floating one and let the map find a spot that fits its
        rules.
      </p>
      <button onClick={addFree}>+ Add floating place</button>
      <ul className="list">
        {doc.places.map((p) => {
          const st = status.get(p.id);
          const bad = (st?.unmetSites.length ?? 0) > 0;
          return (
            <li key={p.id} className={selection?.id === p.id ? 'sel' : ''} onClick={() => setSelection({ kind: 'place', id: p.id })}>
              <span className="icon">{KIND_ICON[p.kind]}</span>
              <span className="grow">{p.name}</span>
              <span className={`badge ${p.mode}`}>{MODE_TEXT[p.mode]}</span>
              <span className={`dot ${bad ? 'bad' : 'ok'}`} title={bad ? `Not ${st!.unmetSites.map((s) => SITE_LABELS[s]).join(', ')}` : 'All site facts met'} />
            </li>
          );
        })}
      </ul>

      {selected && <PlaceEditor key={selected.id} place={selected} world={world} setPlace={setPlace} setSelection={setSelection} />}

      {selectedAuto && (
        <div className="editor">
          <h3>{selectedAuto.name}</h3>
          <p className="help">Suggested settlement ({selectedAuto.sites.map((s) => SITE_LABELS[s]).join(', ') || 'open country'}).</p>
          <button className="primary" onClick={() => keepAuto(selectedAuto.id)}>
            Keep it
          </button>
        </div>
      )}

      {auto.length > 0 && (
        <>
          <h3>Suggested settlements</h3>
          <p className="help">Filled in where you haven't decided anything. Keep one to make it part of the world. Set how many in World.</p>
          <ul className="list">
            {auto.map((p) => (
              <li key={p.id} className={selection?.id === p.id ? 'sel' : ''} onClick={() => setSelection({ kind: 'auto', id: p.id })}>
                <span className="icon muted">{KIND_ICON[p.kind]}</span>
                <span className="grow muted">{p.name}</span>
                <button
                  className="small"
                  onClick={(e) => {
                    e.stopPropagation();
                    keepAuto(p.id);
                  }}
                >
                  Keep
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function PlaceEditor({
  place,
  world,
  setPlace,
  setSelection,
}: {
  place: Place;
  world: World;
  setPlace: (id: string, patch: Partial<Place>) => void;
  setSelection: (s: Selection) => void;
}) {
  const { result, update } = world;
  const resolved = result?.places.find((p) => p.id === place.id);
  const [name, setName] = useState(place.name);
  const pos = resolved?.pos ?? place.pos;
  return (
    <div className="editor">
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== place.name && setPlace(place.id, { name })} />
      </Field>
      <Field label="Kind">
        <select value={place.kind} onChange={(e) => setPlace(place.id, { kind: e.target.value as PlaceKind })}>
          {(['city', 'town', 'village', 'fort', 'landmark'] as PlaceKind[]).map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
      </Field>
      <Field label="Location">
        <div className="seg">
          {(['fixed', 'near', 'free'] as PlaceMode[]).map((m) => (
            <button
              key={m}
              className={place.mode === m ? 'on' : ''}
              onClick={() => setPlace(place.id, { mode: m, pos: m === 'free' ? place.pos : (place.pos ?? pos), radiusKm: place.radiusKm ?? 50 })}
            >
              {m === 'fixed' ? 'Exactly here' : m === 'near' ? 'Near here' : 'Anywhere'}
            </button>
          ))}
        </div>
      </Field>
      {place.mode === 'near' && (
        <Slider label="Within" unit=" km" value={place.radiusKm ?? 50} min={5} max={300} step={5} onChange={(v) => setPlace(place.id, { radiusKm: v })} />
      )}
      <p className="help">
        {place.mode === 'fixed'
          ? 'Stays put. The terrain is reshaped around it to make its facts true.'
          : place.mode === 'near'
            ? 'The map picks a spot within the radius that satisfies its facts.'
            : 'The map picks any spot that satisfies its facts and rules.'}
        {pos && ` Currently at ${Math.round(pos[0])}, ${Math.round(pos[1])} km.`}
      </p>
      <Field label="Must be…">
        <div className="chips">
          {SITE_KINDS.map((s) => {
            const on = place.sites.includes(s);
            const unmet = resolved?.unmetSites.includes(s);
            return (
              <button
                key={s}
                className={`chip ${on ? 'on' : ''} ${unmet ? 'unmet' : ''}`}
                onClick={() => setPlace(place.id, { sites: on ? place.sites.filter((x) => x !== s) : [...place.sites, s] })}
                title={unmet ? 'Not satisfied on the current map' : ''}
              >
                {SITE_LABELS[s]}
              </button>
            );
          })}
        </div>
      </Field>
      <div className="row">
        {place.mode !== 'fixed' && pos && (
          <button onClick={() => setPlace(place.id, { mode: 'fixed', pos })} title="Lock it where the generator put it">
            📌 Pin here
          </button>
        )}
        <button
          className="danger"
          onClick={() => {
            update((d) => ({
              ...d,
              places: d.places.filter((p) => p.id !== place.id),
              constraints: d.constraints.filter((c) => c.a !== place.id && c.b !== place.id),
            }));
            setSelection(null);
          }}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- rules

const RULE_TEXT: Record<ConstraintType, string> = {
  distance: 'Distance between',
  mountainsBetween: 'Mountains between',
  sameRiver: 'On the same river',
};

export function RulesPanel({ world, selection }: { world: World; selection: Selection }) {
  const { doc, result, update } = world;
  const status = new Map(result?.report.map((s) => [s.id, s]) ?? []);
  const preA = selection?.kind === 'place' ? selection.id : (doc.places[0]?.id ?? '');
  const [type, setType] = useState<ConstraintType>('distance');
  const [a, setA] = useState(preA);
  const [b, setB] = useState('');
  const [minKm, setMin] = useState<number | undefined>();
  const [maxKm, setMax] = useState<number | undefined>();
  const name = (id: string) => doc.places.find((p) => p.id === id)?.name ?? '?';

  const add = () => {
    if (!a || !b || a === b) return;
    const id = uid('rule');
    const c: Constraint = type === 'distance' ? { id, type, a, b, minKm, maxKm } : { id, type, a, b };
    update((d) => ({ ...d, constraints: [...d.constraints, c] }));
  };

  const places = doc.places;
  return (
    <div className="panel">
      <p className="help">Rules relate two places. Red ones aren't satisfied on the current map — the message says why.</p>
      <ul className="list rules">
        {doc.constraints.map((c) => {
          const st = status.get(c.id);
          return (
            <li key={c.id} className={selection?.kind === 'place' && (c.a === selection.id || c.b === selection.id) ? 'sel' : ''}>
              <span className={`dot ${st?.ok ? 'ok' : st ? 'bad' : ''}`} />
              <span className="grow">
                <b>{RULE_TEXT[c.type]}</b> {name(c.a)} &amp; {name(c.b)}
                {c.type === 'distance' && (
                  <span className="muted">
                    {' '}
                    ({c.minKm ?? 0}–{c.maxKm ?? '∞'} km)
                  </span>
                )}
                {st && <div className={`msg ${st.ok ? '' : 'bad'}`}>{st.message}</div>}
              </span>
              <button className="small danger" onClick={() => update((d) => ({ ...d, constraints: d.constraints.filter((x) => x.id !== c.id) }))}>
                ✕
              </button>
            </li>
          );
        })}
      </ul>
      <h3>New rule</h3>
      {places.length < 2 ? (
        <p className="help">Add at least two places first.</p>
      ) : (
        <div className="editor">
          <Field label="Type">
            <select value={type} onChange={(e) => setType(e.target.value as ConstraintType)}>
              {(Object.keys(RULE_TEXT) as ConstraintType[]).map((t) => (
                <option key={t} value={t}>
                  {RULE_TEXT[t]}
                </option>
              ))}
            </select>
          </Field>
          <div className="row">
            <select value={a} onChange={(e) => setA(e.target.value)}>
              <option value="">— place —</option>
              {places.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <span>&amp;</span>
            <select value={b} onChange={(e) => setB(e.target.value)}>
              <option value="">— place —</option>
              {places
                .filter((p) => p.id !== a)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </div>
          {type === 'distance' && (
            <div className="row">
              <span>at least</span>
              <NumberInput value={minKm} onChange={setMin} placeholder="0" />
              <span>at most</span>
              <NumberInput value={maxKm} onChange={setMax} placeholder="∞" />
              <span>km</span>
            </div>
          )}
          <button className="primary" disabled={!a || !b || a === b} onClick={add}>
            Add rule
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- terrain features

export function TerrainPanel({ world, selection, setSelection }: { world: World; selection: Selection; setSelection: (s: Selection) => void }) {
  const { doc, result, update } = world;
  const g = makeGrid(doc.settings.widthKm, doc.settings.heightKm, doc.settings.resolution);
  const clearLayer = (k: keyof WorldDoc['paint']) =>
    update((d) => ({ ...d, paint: { ...d.paint, [k]: emptyLayer(g.w, g.h) }, lockHeights: k === 'lock' ? undefined : d.lockHeights }));
  return (
    <div className="panel">
      <p className="help">
        Draw <b>ridges</b> and <b>rivers</b> with the tools on the left; they are always kept. Paint land, sea and landforms to steer
        the rest. <b>Lock</b> freezes terrain you like so rerolling the seed leaves it alone.
      </p>
      <h3>Ridges &amp; ranges</h3>
      {doc.ridges.length === 0 && <p className="help muted">None drawn.</p>}
      <ul className="list">
        {doc.ridges.map((r) => (
          <li key={r.id} className={selection?.id === r.id ? 'sel' : ''} onClick={() => setSelection({ kind: 'ridge', id: r.id })}>
            <span className="icon">⋀</span>
            <span className="grow">{r.name}</span>
          </li>
        ))}
      </ul>
      {selection?.kind === 'ridge' &&
        doc.ridges
          .filter((r) => r.id === selection.id)
          .map((r) => (
            <div className="editor" key={r.id}>
              <Field label="Name">
                <input
                  defaultValue={r.name}
                  onBlur={(e) => update((d) => ({ ...d, ridges: d.ridges.map((x) => (x.id === r.id ? { ...x, name: e.target.value } : x)) }))}
                />
              </Field>
              <Slider
                label="Crest height"
                unit=" m"
                value={r.heightM}
                min={300}
                max={5000}
                step={100}
                onChange={(v) => update((d) => ({ ...d, ridges: d.ridges.map((x) => (x.id === r.id ? { ...x, heightM: v } : x)) }))}
              />
              <Slider
                label="Width"
                unit=" km"
                value={r.widthKm}
                min={8}
                max={150}
                step={2}
                onChange={(v) => update((d) => ({ ...d, ridges: d.ridges.map((x) => (x.id === r.id ? { ...x, widthKm: v } : x)) }))}
              />
              <p className="help">Drag the white handles on the map to reshape it.</p>
              <button
                className="danger"
                onClick={() => {
                  update((d) => ({ ...d, ridges: d.ridges.filter((x) => x.id !== r.id) }));
                  setSelection(null);
                }}
              >
                Delete ridge
              </button>
            </div>
          ))}

      <h3>Rivers</h3>
      {doc.rivers.length === 0 && <p className="help muted">None drawn. A river runs from the first point you click (its source) to the last (its mouth); the land under it is kept dry.</p>}
      <ul className="list">
        {doc.rivers.map((r) => (
          <li key={r.id} className={selection?.id === r.id ? 'sel' : ''} onClick={() => setSelection({ kind: 'river', id: r.id })}>
            <span className="icon">∿</span>
            <span className="grow">{r.name}</span>
          </li>
        ))}
      </ul>
      {selection?.kind === 'river' &&
        doc.rivers
          .filter((r) => r.id === selection.id)
          .map((r) => (
            <div className="editor" key={r.id}>
              <Field label="Name">
                <input
                  defaultValue={r.name}
                  onBlur={(e) => update((d) => ({ ...d, rivers: d.rivers.map((x) => (x.id === r.id ? { ...x, name: e.target.value } : x)) }))}
                />
              </Field>
              <Slider
                label="Valley width"
                unit=" km"
                value={r.valleyWidthKm}
                min={0}
                max={40}
                step={1}
                hint="0 = just a channel"
                onChange={(v) => update((d) => ({ ...d, rivers: d.rivers.map((x) => (x.id === r.id ? { ...x, valleyWidthKm: v } : x)) }))}
              />
              <button
                onClick={() =>
                  update((d) => ({ ...d, rivers: d.rivers.map((x) => (x.id === r.id ? { ...x, points: [...x.points].reverse() } : x)) }))
                }
              >
                ⇄ Reverse drawing order
              </button>
              <button
                className="danger"
                onClick={() => {
                  update((d) => ({ ...d, rivers: d.rivers.filter((x) => x.id !== r.id) }));
                  setSelection(null);
                }}
              >
                Delete river
              </button>
            </div>
          ))}

      <h3>Paint</h3>
      <div className="row wrap">
        <button onClick={() => clearLayer('landSea')}>Clear land/sea</button>
        <button onClick={() => clearLayer('landform')}>Clear landforms</button>
        <button onClick={() => clearLayer('lock')}>Unlock all</button>
      </div>

      {result && (result.warnings.length > 0 || result.implicit.ridges.length + result.implicit.rivers.length > 0) && (
        <>
          <h3>What the generator did</h3>
          {result.implicit.ridges.length + result.implicit.rivers.length + result.implicit.seaStrokes.length > 0 && (
            <p className="help">
              To make your facts true it added {result.implicit.ridges.length} ridge(s), {result.implicit.rivers.length} river course(s)
              {result.implicit.seaStrokes.length ? `, ${result.implicit.seaStrokes.length} inlet(s)` : ''}. They show as dotted lines.
            </p>
          )}
          <ul className="warnings">
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- world settings & files

export function WorldPanel({ world, onExport, onFit }: { world: World; onExport: () => void; onFit: () => void }) {
  const { doc, update, replace } = world;
  const S = doc.settings;
  const set = (patch: Partial<WorldSettings>) => update((d) => ({ ...d, settings: { ...d.settings, ...patch } }));
  const [name, setName] = useState(doc.name);

  const save = () => {
    const blob = new Blob([serialize(doc)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${doc.name.replace(/[^\w-]+/g, '_') || 'world'}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const load = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      try {
        replace(deserialize(await f.text()));
        onFit();
      } catch (e) {
        alert(`Couldn't open that file: ${e instanceof Error ? e.message : e}`);
      }
    };
    input.click();
  };

  const resize = (patch: Partial<WorldSettings>) => {
    update((d) => {
      const settings = { ...d.settings, ...patch };
      const g = makeGrid(settings.widthKm, settings.heightKm, settings.resolution);
      // Paint is stored per cell, so stretch it to the new grid.
      const resample = (l: WorldDoc['paint']['landSea']) => {
        const out = emptyLayer(g.w, g.h);
        for (let y = 0; y < g.h; y++)
          for (let x = 0; x < g.w; x++)
            out.data[y * g.w + x] = l.data[Math.min(l.h - 1, Math.floor(((y + 0.5) / g.h) * l.h)) * l.w + Math.min(l.w - 1, Math.floor(((x + 0.5) / g.w) * l.w))];
        return out;
      };
      return {
        ...d,
        settings,
        paint: { landSea: resample(d.paint.landSea), landform: resample(d.paint.landform), lock: emptyLayer(g.w, g.h) },
        lockHeights: undefined,
      };
    });
    onFit();
  };

  return (
    <div className="panel">
      <Field label="World name">
        <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== doc.name && update((d) => ({ ...d, name }))} />
      </Field>
      <Field label="Seed" hint="changes everything you haven't decided">
        <div className="row">
          <input type="number" className="num wide" value={doc.seed} onChange={(e) => update((d) => ({ ...d, seed: Math.abs(+e.target.value | 0) }))} />
          <button onClick={() => update((d) => ({ ...d, seed: Math.floor(Math.random() * 1e9), hints: {} }))} title="New random seed">
            🎲 Reroll
          </button>
        </div>
      </Field>
      <button onClick={() => update((d) => ({ ...d, hints: {} }))} title="Let floating places find new spots on the same terrain">
        Reshuffle floating places
      </button>

      <h3>Shape</h3>
      <Slider label="Land" value={S.landFraction} min={0.15} max={0.9} step={0.05} onChange={(v) => set({ landFraction: v })} />
      <Field label="Sea along edges">
        <div className="row">
          {(['n', 'e', 's', 'w'] as const).map((k) => (
            <label key={k} className="check">
              <input type="checkbox" checked={S.seaEdges[k]} onChange={(e) => set({ seaEdges: { ...S.seaEdges, [k]: e.target.checked } })} />
              {k.toUpperCase()}
            </label>
          ))}
        </div>
      </Field>
      <Slider label="Mountainousness" value={S.mountainousness} min={0} max={1} step={0.05} onChange={(v) => set({ mountainousness: v })} />
      <Slider label="Roughness" value={S.roughness} min={0} max={1} step={0.05} onChange={(v) => set({ roughness: v })} />
      <Slider label="Highest peaks" unit=" m" value={S.maxElevationM} min={800} max={6000} step={100} onChange={(v) => set({ maxElevationM: v })} />
      <Slider label="Erosion" value={S.erosion} min={0} max={1} step={0.05} onChange={(v) => set({ erosion: v })} hint="deeper river valleys" />
      <Slider label="River density" value={S.riverDensity} min={0} max={1} step={0.05} onChange={(v) => set({ riverDensity: v })} />
      <label className="check">
        <input type="checkbox" checked={S.lakes} onChange={(e) => set({ lakes: e.target.checked })} /> Lakes in closed basins
      </label>

      <h3>Settlements</h3>
      <Slider label="Suggested settlements" value={S.autoTowns} min={0} max={40} step={1} onChange={(v) => set({ autoTowns: v })} />
      <Slider
        label="Min spacing"
        unit=" km"
        value={S.minTownSpacingKm}
        min={0}
        max={100}
        step={5}
        onChange={(v) => set({ minTownSpacingKm: v })}
        hint="between any two places"
      />

      <h3>Map size</h3>
      <div className="row">
        <NumberInput value={S.widthKm} onChange={(v) => v && v >= 50 && resize({ widthKm: v })} />
        <span>×</span>
        <NumberInput value={S.heightKm} onChange={(v) => v && v >= 50 && resize({ heightKm: v })} />
        <span>km</span>
      </div>
      <Field label="Detail" hint="cells across; higher is slower">
        <select value={S.resolution} onChange={(e) => resize({ resolution: +e.target.value })}>
          {[160, 240, 320, 400, 512].map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </Field>

      <h3>File</h3>
      <div className="row wrap">
        <button onClick={save}>Save…</button>
        <button onClick={load}>Open…</button>
        <button onClick={onExport}>Export PNG</button>
      </div>
      <div className="row wrap">
        <button
          onClick={() => {
            if (confirm('Start a blank world? (Undo can bring this one back.)')) {
              replace(newDoc(Math.floor(Math.random() * 1e9), { ...DEFAULT_SETTINGS }));
              onFit();
            }
          }}
        >
          New blank world
        </button>
        <button
          onClick={() => {
            replace(exampleDoc());
            onFit();
          }}
        >
          Load example
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- view

const LAYER_TEXT: Record<keyof Layers, string> = {
  relief: 'Relief shading',
  tint: 'Elevation tint',
  contours: 'Contours (200 m)',
  landforms: 'Landform colours',
  glyphs: 'Mountain & hill symbols',
  ridges: 'Ridge lines',
  rivers: 'Rivers',
  labels: 'Labels',
  rules: 'Rule lines',
  features: 'Edit overlays (drawn features, paint)',
  autoTowns: 'Suggested settlements',
};

export function ViewPanel({ layers, setLayers }: { layers: Layers; setLayers: (l: Layers) => void }) {
  return (
    <div className="panel">
      {(Object.keys(LAYER_TEXT) as (keyof Layers)[]).map((k) => (
        <label key={k} className="check block">
          <input type="checkbox" checked={layers[k]} onChange={(e) => setLayers({ ...layers, [k]: e.target.checked })} /> {LAYER_TEXT[k]}
        </label>
      ))}
      <h3>Landforms</h3>
      <ul className="legend">
        {[LANDFORM.plain, LANDFORM.valley, LANDFORM.hills, LANDFORM.mountains, LANDFORM.plateau].map((k) => (
          <li key={k}>
            <span className="swatch" style={{ background: LANDFORM_COLORS[k] }} /> {LANDFORM_NAMES[k]}
          </li>
        ))}
      </ul>
      <p className="help">
        <b>Plain</b>: little relief. <b>Valley</b>: ground rises on both sides. <b>Hills</b>: moderate relief.{' '}
        <b>Mountains</b>: high or steep. <b>Plateau</b>: high but flat. Hover the map for details.
      </p>
    </div>
  );
}
