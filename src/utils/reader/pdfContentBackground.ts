import { ConfigService } from "../../assets/lib/kookit-extra-browser.min";

export const pdfContentBackgroundKey = (bookKey: string) => `pdfHideContentBackground:${bookKey}`;
export const hidesPdfContentBackground = (bookKey: string) =>
  ConfigService.getReaderConfig(pdfContentBackgroundKey(bookKey)) === "yes";

type Point = [number, number];

// Only leading, opaque white paper rectangles are candidates. Never recolor
// pixels: embedded images, small cell fills and all later artwork stay native.
export function filterPdfPaperFills(context: CanvasRenderingContext2D) {
  const originals = new Map<string, any>();
  let leading = true, points: Point[] = [], closed = false, invalid = false;
  const wrap = (name: string, handler: (base: (...args: any[]) => any, ...args: any[]) => any) => {
    const base = context[name];
    if (typeof base !== "function") return;
    const own = Object.getOwnPropertyDescriptor(context, name);
    const replacement = (...args: any[]) => handler(base.bind(context), ...args);
    originals.set(name, {own, replacement}); context[name] = replacement;
  };
  const point = (x: number, y: number): Point => {
    const m = context.getTransform();
    return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
  };
  const paper = (path: Point[]) => {
    if (path.length === 5 && path[0][0] === path[4][0] && path[0][1] === path[4][1]) path = path.slice(0, 4);
    if (path.length !== 4) return false;
    const xs = path.map(p => p[0]), ys = path.map(p => p[1]);
    const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
    const w = context.canvas.width, h = context.canvas.height;
    const axisAligned = path.every((p, i) => Math.abs(p[0] - path[(i + 1) % 4][0]) < .01 || Math.abs(p[1] - path[(i + 1) % 4][1]) < .01);
    const corners = new Set(path.map(p => `${Math.round(p[0] * 100)},${Math.round(p[1] * 100)}`));
    return w > 0 && h > 0 && axisAligned && corners.size === 4
      && (right - left) * (bottom - top) >= w * h * .7
      && left <= w * .15 && right >= w * .85 && top <= h * .15 && bottom >= h * .85;
  };
  const white = () => context.globalAlpha === 1 && context.globalCompositeOperation === "source-over"
    && /^(#fff|#ffffff|rgb\(255,\s*255,\s*255\)|rgba\(255,\s*255,\s*255,\s*1\))$/i.test(String(context.fillStyle))
    && context.filter === "none" && context.shadowBlur === 0 && context.shadowOffsetX === 0 && context.shadowOffsetY === 0;
  const transparent = () => context.globalAlpha === 0 || /^(transparent|rgba\([^)]*,\s*0\))$/i.test(String(context.fillStyle));
  wrap("beginPath", (base, ...args) => { points = []; closed = false; invalid = false; return base(...args); });
  const addPoint = (x: number, y: number) => {
    if (!leading || invalid) return;
    if (points.length >= 5) invalid = true;
    else points.push(point(x, y));
  };
  wrap("moveTo", (base, x, y) => { if (points.length) invalid = true; addPoint(x, y); return base(x, y); });
  wrap("lineTo", (base, x, y) => { addPoint(x, y); return base(x, y); });
  wrap("closePath", (base) => { closed = true; return base(); });
  wrap("rect", (base, x, y, w, h) => {
    if (points.length) invalid = true;
    points.push(point(x, y), point(x + w, y), point(x + w, y + h), point(x, y + h));
    closed = true; return base(x, y, w, h);
  });
  for (const name of ["arc", "arcTo", "ellipse", "bezierCurveTo", "quadraticCurveTo", "roundRect"]) {
    wrap(name, (base, ...args) => { invalid = true; return base(...args); });
  }
  wrap("clip", (base, ...args) => {
    if (args.some(arg => typeof arg !== "string") || invalid || !closed || !paper(points)) leading = false;
    return base(...args);
  });
  wrap("fill", (base, ...args) => {
    const knownPath = args.every(arg => typeof arg === "string");
    if (leading && knownPath && !invalid && closed && white() && paper(points)) return;
    if (!transparent()) leading = false;
    return base(...args);
  });
  wrap("fillRect", (base, x, y, w, h) => {
    if (leading && white() && paper([point(x, y), point(x + w, y), point(x + w, y + h), point(x, y + h)])) return;
    if (!transparent()) leading = false;
    return base(x, y, w, h);
  });
  for (const name of ["drawImage", "putImageData", "fillText", "strokeText", "stroke", "strokeRect"]) {
    wrap(name, (base, ...args) => { leading = false; return base(...args); });
  }
  return () => originals.forEach(({own, replacement}, name) => {
    if (context[name] !== replacement) return;
    if (own) Object.defineProperty(context, name, own);
    else delete context[name];
  });
}

// The same PDFPageProxy and RenderTask render the source canvas. Text, links,
// annotations, page dimensions, crop transforms and note coordinates are untouched.
export function attachPdfContentBackground(rendition: any, bookKey: string) {
  if (!hidesPdfContentBackground(bookKey)) return;
  const render = rendition.handleRenderPDFChapter, remove = rendition.removeContent;
  if (typeof render !== "function" || typeof remove !== "function") return;
  const pages = new Map<any, {original: any; replacement: any}>();
  let disposed = false;
  const decorate = async (index, ...args) => {
    if (disposed) return;
    const page = await rendition.chapterDocList?.[index]?.text?.getPage?.();
    if (disposed) return;
    if (page && !pages.has(page)) {
      const original = page.render;
      const replacement = function(this: any, options) {
        const restore = options.canvasContext ? filterPdfPaperFills(options.canvasContext) : () => {};
        try {
          const task = original.call(this, {...options, background:"rgba(0,0,0,0)"});
          task.promise.then(restore, restore);
          return task;
        } catch (error) { restore(); throw error; }
      };
      pages.set(page, {original, replacement}); page.render = replacement;
    }
    return render.call(rendition, index, ...args);
  };
  const cleanup = (...args) => {
    disposed = true;
    pages.forEach(({original, replacement}, page) => { if (page.render === replacement) page.render = original; });
    if (rendition.handleRenderPDFChapter === decorate) rendition.handleRenderPDFChapter = render;
    if (rendition.removeContent === cleanup) rendition.removeContent = remove;
    return remove.apply(rendition, args);
  };
  rendition.handleRenderPDFChapter = decorate; rendition.removeContent = cleanup;
}
