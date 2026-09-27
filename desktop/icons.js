// Icons drawn in code (no image assets to ship): the app icon and the taskbar
// thumbnail buttons. A tiny supersampled rasteriser writes BGRA bitmaps.

function rasterize(size, shapes, ss = 4) {
  const buf = Buffer.alloc(size * size * 4);
  const n = ss * ss;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss;
          const py = y + (sy + 0.5) / ss;
          // Paint shapes in order; later shapes cover earlier ones.
          let cr = 0;
          let cg = 0;
          let cb = 0;
          let ca = 0;
          for (const s of shapes) {
            if (!s.hit(px, py)) continue;
            const [sr, sg, sb, sa = 1] = typeof s.color === 'function' ? s.color(px, py) : s.color;
            cr = sr * sa + cr * (1 - sa);
            cg = sg * sa + cg * (1 - sa);
            cb = sb * sa + cb * (1 - sa);
            ca = sa + ca * (1 - sa);
          }
          r += cr;
          g += cg;
          b += cb;
          a += ca;
        }
      }
      const i = (y * size + x) * 4;
      // BGRA, premultiplied (colour sums above are already alpha-weighted).
      buf[i] = Math.round(b / n);
      buf[i + 1] = Math.round(g / n);
      buf[i + 2] = Math.round(r / n);
      buf[i + 3] = Math.round((a / n) * 255);
    }
  }
  return buf;
}

const inPoly = (pts) => (x, y) => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

const roundRect = (x0, y0, x1, y1, r) => (x, y) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

const scalePts = (pts, k) => pts.map(([x, y]) => [x * k, y * k]);

/** Pink-to-orange rounded square with a white "z" — the Zune palette, not its logo. */
export function appIconBitmap(size = 256) {
  const k = size / 256;
  const pink = [241, 14, 156];
  const orange = [234, 78, 31];
  const grad = (x, y) => {
    const t = Math.min(1, Math.max(0, ((x + y) / (2 * size) - 0.15) / 0.8));
    return [
      pink[0] + (orange[0] - pink[0]) * t,
      pink[1] + (orange[1] - pink[1]) * t,
      pink[2] + (orange[2] - pink[2]) * t,
      1,
    ];
  };
  const z = scalePts([[70, 66], [188, 66], [188, 92], [110, 164], [188, 164], [188, 190], [68, 190], [68, 164], [146, 92], [70, 92]], k);
  return rasterize(size, [
    { hit: roundRect(8 * k, 8 * k, 248 * k, 248 * k, 46 * k), color: grad },
    { hit: inPoly(z), color: [255, 255, 255, 1] },
  ], size > 64 ? 2 : 4);
}

const WHITE = [255, 255, 255, 1];
const THUMB = {
  play: [inPoly([[5, 3], [5, 13], [13, 8]])],
  pause: [inPoly([[4, 3], [7, 3], [7, 13], [4, 13]]), inPoly([[9, 3], [12, 3], [12, 13], [9, 13]])],
  prev: [inPoly([[3, 3], [5, 3], [5, 13], [3, 13]]), inPoly([[13, 3], [13, 13], [5.5, 8]])],
  next: [inPoly([[3, 3], [3, 13], [10.5, 8]]), inPoly([[11, 3], [13, 3], [13, 13], [11, 13]])],
};

export function thumbBitmap(name) {
  return rasterize(16, THUMB[name].map((hit) => ({ hit, color: WHITE })));
}

/** Minimal .ico container holding one PNG (Windows Vista+ reads PNG-in-ICO). */
export function pngToIco(png, size = 256) {
  const header = Buffer.alloc(6 + 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(size >= 256 ? 0 : size, 6);
  header.writeUInt8(size >= 256 ? 0 : size, 7);
  header.writeUInt8(0, 8);
  header.writeUInt8(0, 9);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, png]);
}
