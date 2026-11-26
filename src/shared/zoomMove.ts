import { ClipTransform, ZoomMode, ZoomMove } from './types';

export function starterZoomMove(mode: ZoomMode, length: number): ZoomMove {
  const m = Math.min(Math.max(length * 0.25, 0.5), 2, length / 2);
  switch (mode) {
    case 'in':
      return { mode, p1: 0, p2: m, p3: length, p4: length, smooth: true };
    case 'out':
      return { mode, p1: 0, p2: 0, p3: length - m, p4: length, smooth: true };
    case 'inOut':
      return { mode, p1: 0, p2: m, p3: length - m, p4: length, smooth: true };
  }
}

function rampValue(u: number, a: number, b: number, smooth: boolean): number {
  if (b - a <= 1e-6) return u >= a ? 1 : 0;
  const k = Math.min(1, Math.max(0, (u - a) / (b - a)));
  return smooth ? k * k * (3 - 2 * k) : k;
}

export function zoomAmountAt(zoom: ZoomMove, u: number): number {
  const smooth = zoom.smooth ?? true;
  switch (zoom.mode) {
    case 'in':
      return rampValue(u, zoom.p1, zoom.p2, smooth);
    case 'out':
      return 1 - rampValue(u, zoom.p3, zoom.p4, smooth);
    case 'inOut':
      return u < zoom.p3 ? rampValue(u, zoom.p1, zoom.p2, smooth) : 1 - rampValue(u, zoom.p3, zoom.p4, smooth);
  }
}

export function fitZoomMove(zoom: ZoomMove, length: number): ZoomMove {
  const c = (v: number) => Math.min(Math.max(v, 0), length);
  const p1 = c(zoom.p1);
  const p2 = Math.max(p1, c(zoom.p2));
  const p3 = Math.max(p2, c(zoom.p3));
  const p4 = Math.max(p3, c(zoom.p4));
  return { ...zoom, p1, p2, p3, p4 };
}

export function shiftZoomMove(zoom: ZoomMove, d: number, length: number): ZoomMove {
  return fitZoomMove(
    {
      ...zoom,
      p1: zoom.p1 - d,
      p2: zoom.p2 - d,
      p3: zoom.p3 - d,
      p4: zoom.p4 - d,
    },
    length
  );
}

export function zoomedOffset(t: ClipTransform): { x: number; y: number } {
  if (t.scale <= 1.001) return { x: t.x, y: t.y };
  const m = (t.scale - 1) / 2;
  return {
    x: Math.min(Math.max(t.x, -m), m),
    y: Math.min(Math.max(t.y, -m), m),
  };
}

export function transformAt(t: ClipTransform | undefined, u: number): { scale: number; x: number; y: number } {
  if (!t) return { scale: 1, x: 0, y: 0 };
  const o = zoomedOffset(t);
  if (!t.zoom) return { scale: t.scale, x: o.x, y: o.y };
  const k = zoomAmountAt(t.zoom, u);
  return {
    scale: 1 + (t.scale - 1) * k,
    x: o.x * k,
    y: o.y * k,
  };
}
