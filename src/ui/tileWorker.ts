import { DetailField, renderTile, TILE, type DetailData, type TileRequest } from './detail';

let field: DetailField | null = null;
let fieldId = -1;

self.onmessage = async (e: MessageEvent<{ init?: { id: number; data: DetailData }; job?: { id: number; key: string; req: TileRequest } }>) => {
  const { init, job } = e.data;
  if (init) {
    field = new DetailField(init.data);
    fieldId = init.id;
    return;
  }
  if (!job || !field || job.id !== fieldId) {
    self.postMessage({ key: job?.key, id: job?.id, stale: true });
    return;
  }
  const out = renderTile(field, job.req);
  const bitmap = await createImageBitmap(new ImageData(out.rgba, TILE, TILE));
  const { rgba: _rgba, ...vectors } = out;
  const transfer: Transferable[] = [bitmap, vectors.coast.buffer, vectors.lake.buffer, vectors.minor.buffer, vectors.major.buffer, ...vectors.ripples.map((r) => r.buffer)];
  self.postMessage({ key: job.key, id: job.id, bitmap, ...vectors }, { transfer });
};
