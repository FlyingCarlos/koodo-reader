export function originalPdfFigure(original: HTMLCanvasElement | null, bbox: number[], sourceWidth: number,
  width: number, label: string): HTMLCanvasElement | null {
  if (!original?.width || !original.height || !sourceWidth) return null;

  const [left, top, right, bottom] = bbox.map(value => value * original.width / sourceWidth);
  const x = Math.max(0, Math.floor(left)), y = Math.max(0, Math.floor(top));
  const bounds = {
    left: x, top: y,
    width: Math.min(original.width, Math.ceil(right)) - x,
    height: Math.min(original.height, Math.ceil(bottom)) - y,
  };
  if (!Object.values(bounds).every(Number.isFinite) || bounds.width < 1 || bounds.height < 1) return null;

  const figure = original.ownerDocument.createElement("canvas");
  figure.width = bounds.width;
  figure.height = bounds.height;
  const context = figure.getContext("2d");
  if (!context) return null;
  context.drawImage(original, bounds.left, bounds.top, bounds.width, bounds.height,
    0, 0, bounds.width, bounds.height);
  figure.setAttribute("role", "img");
  figure.setAttribute("aria-label", label);
  figure.style.cssText = `display:block;width:${width}px;max-width:100%;height:auto`;
  return figure;
}
