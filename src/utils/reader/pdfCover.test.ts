import { jest, test, expect } from "@jest/globals";
import { renderOriginalPdfCover } from "./pdfCover";
import { ParallelBlock } from "../../components/bilingualReader/api";

test("cover reuses original native canvas pixels at full column width without rewriting the original", () => {
  document.body.innerHTML = '<div id="koodoPDFLayer"><canvas width="864" height="1296"></canvas></div><article><header>translation label</header></article>';
  const original = document.querySelector("canvas")!;
  jest.spyOn(document.getElementById("koodoPDFLayer")!, "getBoundingClientRect").mockReturnValue({width:432,top:20,left:16,bottom:668} as DOMRect);
  const article = document.querySelector("article")!;
  const draw = jest.fn();
  const context = jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({drawImage: draw} as any);
  const image = {page: 1, kind: "image", anchors: [{bbox:[0,0,432,648]}]} as ParallelBlock;
  expect(renderOriginalPdfCover(article, [image], 1, {width:432,height:648}, false)).toBe(true);
  const copy = article.querySelector("canvas")!;
  expect([copy.width,copy.height]).toEqual([864,1296]);
  expect(copy.style.width).toBe("432px");
  expect(copy.style.left).toBe("16px");
  expect(draw).toHaveBeenCalledWith(original,0,0);
  expect(article.querySelector("header")).toBeNull();
  expect(document.querySelector("#koodoPDFLayer canvas")).toBe(original);
  expect(original.width).toBe(864);
  context.mockRestore();
});

test("ordinary figures and text first pages retain the existing translation and annotation paths", () => {
  const article = document.createElement("article");
  const block = {kind:"image",anchors:[{bbox:[40,100,200,300]}]} as ParallelBlock;
  expect(renderOriginalPdfCover(article,[block],1,{width:432,height:648},false)).toBe(false);
  expect(renderOriginalPdfCover(article,[block],2,{width:432,height:648},false)).toBe(false);
});
