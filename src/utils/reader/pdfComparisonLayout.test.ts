import { test, expect } from "@jest/globals";
import { comparisonViewport, sourceBlockMetrics, sourceTextRuns, SourceRun } from "./pdfComparisonLayout";
import { ParallelBlock } from "../../components/bilingualReader/api";

const block = (text: string, bbox: number[]) => ({ text, anchors: [{ page: 19, bbox }] } as ParallelBlock);
const run = (text: string, top: number, fontSize = 18): SourceRun =>
  ({ text, top, bottom: top + fontSize, left: 50, right: 350, fontSize });

test("comparison uses available reading space, reserves locked native panels and keeps width control monotonic", () => {
  expect(comparisonViewport(1874, 1, false, false)).toEqual({ pageOffset: "25px", pageWidth: "1824px" });
  const locked = comparisonViewport(1874, 1, true, true);
  expect(parseFloat(locked.pageOffset)).toBeGreaterThanOrEqual(324);
  expect(parseFloat(locked.pageOffset) + parseFloat(locked.pageWidth)).toBeLessThanOrEqual(1550);
  expect(parseFloat(comparisonViewport(1874, .75, false, false).pageWidth)).toBeLessThan(1824);
  expect(parseFloat(comparisonViewport(390, 1, false, false).pageWidth)).toBe(360);
});

test("matching chooses the nearby heading instead of the same word in the running header", () => {
  const metrics = sourceBlockMetrics(block("Inference", [50, 62, 150, 80]),
    [run("Inference", 40, 14), run("17", 40, 14), run("Inference", 130, 27)], 2, { top: 0, left: 0 }, 18);
  expect(metrics.matched).toBe(true); expect(metrics.top).toBe(130); expect(metrics.fontSize).toBe(27);
});

test("paragraph typography uses dominant text and native line pitch, ignoring a small inline superscript", () => {
  const metrics = sourceBlockMetrics(block("Batch size controls throughput and latency.", [50, 90, 350, 130]),
    [run("Batch size controls", 190), run("throughput", 217), run("2", 215, 10), run("and latency.", 244)],
    2, { top: 0, left: 0 }, 18);
  expect(metrics.fontSize).toBe(18); expect(metrics.lineHeight).toBe(1.5); expect(metrics.top).toBe(190);
});

test("PDF device-pixel transforms are removed when measuring effective type", () => {
  document.body.innerHTML = '<div id="koodoPDFLayer"><div id="textLayer"><span style="font-size:36px">Readable</span></div></div>';
  const layer = document.querySelector<HTMLElement>("#koodoPDFLayer")!;
  Object.defineProperty(layer, "offsetWidth", { value: 1800 });
  layer.getBoundingClientRect = () => ({ width: 900 } as DOMRect);
  document.querySelector<HTMLElement>("span")!.getBoundingClientRect = () => ({ top: 100, bottom: 118, left: 30, right: 130, width: 100, height: 18 } as DOMRect);
  expect(sourceTextRuns(document, layer)[0].fontSize).toBe(18);
});

test("prefix fallback does not consume unrelated runs when the rest of a source block differs", () => {
  const prefix="a".repeat(48);
  const metrics=sourceBlockMetrics(block(prefix+"x".repeat(100),[50,100,350,120]),
    [run(prefix,100,18),run("z".repeat(100),150,36)],1,{top:0,left:0},18);
  expect(metrics.fontSize).toBe(18);expect(metrics.bottom).toBe(118);
});
