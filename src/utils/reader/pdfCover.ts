import { ParallelBlock } from "../../components/bilingualReader/api";

// Reuse the native PDF canvas at its original backing resolution. No thumbnail,
// image crop endpoint, recompression, or separate book-cover asset is involved.
export function renderOriginalPdfCover(article: HTMLElement, blocks: ParallelBlock[], page: number,
  dimension: {width: number; height: number}, stacked: boolean): boolean {
  if (page !== 1 || blocks.length !== 1 || blocks[0].kind !== "image") return false;
  const box = blocks[0].anchors[0]?.bbox;
  if (!box || box[0] > 2 || box[1] > 2 || box[2] < dimension.width * .95 || box[3] < dimension.height * .95) return false;
  const layer = article.ownerDocument.getElementById("koodoPDFLayer");
  const original = layer?.querySelector<HTMLCanvasElement>("canvas");
  if (!layer || !original?.width || !original.height) return false;
  const canvas = article.ownerDocument.createElement("canvas");
  canvas.width = original.width; canvas.height = original.height;
  const context = canvas.getContext("2d");
  if (!context) return false;
  context.drawImage(original, 0, 0);
  canvas.setAttribute("role", "img"); canvas.setAttribute("aria-label", "原书封面，保持原样");
  const pageRect = layer.getBoundingClientRect();
  canvas.style.cssText = `display:block;width:${pageRect.width}px;max-width:100%;height:auto`;
  article.replaceChildren(canvas);
  article.dataset.originalCover = "true";
  if (stacked) article.style.padding = "0";
  if (!stacked) {
    canvas.style.position = "absolute";
    canvas.style.top = `${pageRect.top}px`;
    canvas.style.left = `${Math.max(0, pageRect.left)}px`;
    article.style.height = `${pageRect.bottom}px`;
  }
  return true;
}
