import { ParallelBlock } from "../../components/bilingualReader/api";

export type ComparisonViewport = { pageOffset: string; pageWidth: string };

// A bilingual page needs two reading measures, rather than two halves of the
// ordinary reader's 60%-wide page. Zoom below 100% narrows the native viewport;
// zoom above it uses the native horizontal scroller instead of clipping content.
export function comparisonViewport(width: number, zoom: number, leftLocked: boolean, rightLocked: boolean): ComparisonViewport {
  const left = leftLocked ? 300 : 0, right = rightLocked ? 300 : 0;
  const gutter = width < 570 ? 12 : 24;
  const available = Math.max(120, width - left - right - gutter * 2);
  const normalized = Number.isFinite(zoom) ? Math.min(3, Math.max(.5, Math.abs(zoom))) : 1;
  const viewport = Math.max(120, Math.floor(available * Math.min(1, normalized) / 12) * 12);
  return { pageOffset: `${left + gutter + (available - viewport) / 2}px`, pageWidth: `${viewport}px` };
}

export type SourceRun = {
  text: string; top: number; bottom: number; left: number; right: number; fontSize: number;
};
export type SourceBlockMetrics = {
  top: number; bottom: number; left: number; right: number; fontSize: number; lineHeight: number; matched: boolean;
};
const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] || 0;
};
function dominantFont(runs: SourceRun[], fallback: number) {
  const weighted = runs.map((run) => ({ value: run.fontSize, weight: normalize(run.text).length }));
  const total = weighted.reduce((sum, item) => sum + item.weight, 0);
  let current = 0;
  for (const item of weighted.sort((a, b) => a.value - b.value)) {
    current += item.weight;
    if (current >= total / 2 && item.value > 0) return item.value;
  }
  return fallback;
}

// PDF.js renders at device-pixel resolution and then transforms the whole layer.
// Read the effective CSS font, not its untransformed (often 2x) declared size.
export function sourceTextRuns(doc: Document, layer: HTMLElement): SourceRun[] {
  const factor = layer.getBoundingClientRect().width / (layer.offsetWidth || layer.getBoundingClientRect().width || 1);
  return Array.from(doc.querySelectorAll<HTMLElement>("#textLayer span")).flatMap((span) => {
    const rect = span.getBoundingClientRect();
    const text = span.textContent || "";
    if (!normalize(text) || !rect.width || !rect.height) return [];
    const declared = parseFloat(doc.defaultView!.getComputedStyle(span).fontSize);
    return [{ text, top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right,
      fontSize: Number.isFinite(declared) ? declared * factor : rect.height }];
  });
}

export function sourceBlockMetrics(block: ParallelBlock, runs: SourceRun[], scale: number,
  origin: { top: number; left: number }, fallbackFont: number): SourceBlockMetrics {
  const bbox = block.anchors[0].bbox;
  const expected = { top: origin.top + bbox[1] * scale, bottom: origin.top + bbox[3] * scale,
    left: origin.left + bbox[0] * scale, right: origin.left + bbox[2] * scale };
  if (block.kind === "image") return { ...expected, fontSize: fallbackFont, lineHeight: 1.5, matched: true };
  const needle = normalize(block.text);
  const indexed: { run: SourceRun; start: number; end: number }[] = [];
  let joined = "";
  runs.forEach((run) => {
    const start = joined.length; joined += normalize(run.text);
    indexed.push({ run, start, end: joined.length });
  });
  let matches: SourceRun[][] = [];
  for (const query of [needle, needle.slice(0, 48)]) {
    if (!query) continue;
    let at = joined.indexOf(query);
    while (at >= 0) {
      const end = at + query.length;
      matches.push(indexed.filter((item) => item.end > at && item.start < end).map((item) => item.run));
      at = joined.indexOf(query, at + 1);
    }
    if (matches.length) break;
  }
  let selected = matches.sort((a, b) => Math.abs(a[0].top - expected.top) - Math.abs(b[0].top - expected.top))[0];
  const matched = !!selected;
  if (!selected) selected = runs.filter((run) => run.top < expected.bottom && run.bottom > expected.top
    && run.left < expected.right && run.right > expected.left);
  const fontSize = dominantFont(selected, fallbackFont);
  const tops: number[] = [];
  selected.filter((run) => run.fontSize >= fontSize * .85).sort((a, b) => a.top - b.top).forEach((run) => {
    if (!tops.length || run.top - tops[tops.length - 1] > fontSize * .45) tops.push(run.top);
  });
  const pitch = median(tops.slice(1).map((top, i) => top - tops[i]));
  return { ...(selected.length ? {
    top: Math.min(...selected.map((run) => run.top)), bottom: Math.max(...selected.map((run) => run.bottom)),
    left: Math.min(...selected.map((run) => run.left)), right: Math.max(...selected.map((run) => run.right)),
  } : expected), fontSize, lineHeight: pitch ? Math.max(1.45, Math.min(1.65, pitch / fontSize)) : 1.5, matched };
}
