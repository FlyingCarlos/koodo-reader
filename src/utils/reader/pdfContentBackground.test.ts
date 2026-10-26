import { jest, test, expect } from "@jest/globals";
import { attachPdfContentBackground, filterPdfPaperFills } from "./pdfContentBackground";
import { ConfigService } from "../../assets/lib/kookit-extra-browser.min";

jest.mock("../../assets/lib/kookit-extra-browser.min", () => ({ConfigService:{getReaderConfig:require("@jest/globals").jest.fn()}}));

function canvas() {
  const ctx: any = {canvas:{width:600,height:840},fillStyle:"#ffffff",globalAlpha:1,
    globalCompositeOperation:"source-over",filter:"none",shadowBlur:0,shadowOffsetX:0,shadowOffsetY:0,
    getTransform: () => ({a:1,b:0,c:0,d:1,e:0,f:0})};
  for (const name of ["beginPath","moveTo","lineTo","closePath","rect","clip","fill","fillRect",
    "bezierCurveTo","drawImage","fillText","strokeText","stroke","putImageData","strokeRect"]) ctx[name] = jest.fn();
  return ctx;
}
function paper(ctx, x=36, y=36, w=528, h=768) {
  ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(x+w,y); ctx.lineTo(x+w,y+h); ctx.lineTo(x,y+h); ctx.closePath();
  ctx.fill();
}

test("skips only leading paper rectangles while preserving image pixels, table cells and text", () => {
  const ctx=canvas(), fill=ctx.fill, image=ctx.drawImage, text=ctx.fillText, stroke=ctx.stroke;
  const restore=filterPdfPaperFills(ctx);
  paper(ctx); paper(ctx); expect(fill).not.toHaveBeenCalled();
  const picture={pixels:"original white and colored image"}; ctx.drawImage(picture,10,10);
  expect(image).toHaveBeenCalledWith(picture,10,10);
  paper(ctx,40,300,200,40); ctx.stroke(); ctx.fillText("P50",50,325);
  paper(ctx); // Even a large white region after content is original artwork.
  expect(fill).toHaveBeenCalledTimes(2); expect(stroke).toHaveBeenCalledTimes(1);
  expect(text).toHaveBeenCalledWith("P50",50,325);
  restore(); expect(ctx.fill).toBe(fill); expect(ctx.drawImage).toBe(image);
});

test.each(["small","translucent","colored","curve","multiple paths","clipped artwork","pattern","blend"])(
  "keeps %s content and all later white regions", kind => {
    const ctx=canvas(), fill=ctx.fill; filterPdfPaperFills(ctx);
    if (kind === "translucent") ctx.globalAlpha=.5;
    if (kind === "colored") ctx.fillStyle="#f6f7f6";
    if (kind === "pattern") ctx.fillStyle={};
    if (kind === "blend") ctx.globalCompositeOperation="multiply";
    ctx.beginPath(); ctx.rect(36,36,528,768);
    if (kind === "curve") ctx.bezierCurveTo(0,0,10,10,20,20);
    if (kind === "multiple paths") ctx.rect(40,40,40,40);
    if (kind === "clipped artwork") { ctx.beginPath(); ctx.rect(40,40,40,40); ctx.clip(); ctx.beginPath(); ctx.rect(36,36,528,768); }
    if (kind === "small") { ctx.beginPath(); ctx.rect(40,40,40,40); }
    ctx.fill(); expect(fill).toHaveBeenCalledTimes(1);
    ctx.globalAlpha=1; ctx.fillStyle="#ffffff"; ctx.globalCompositeOperation="source-over";
    paper(ctx); expect(fill).toHaveBeenCalledTimes(2);
  }
);

test("handles zoom and rotation without altering transforms or making a table-sized box eligible", () => {
  const ctx=canvas(), fill=ctx.fill;
  ctx.canvas={width:1680,height:1200};
  ctx.getTransform=()=>({a:0,b:2,c:-2,d:0,e:1680,f:0});
  const transform=ctx.getTransform(); filterPdfPaperFills(ctx);
  paper(ctx); expect(fill).not.toHaveBeenCalled(); expect(ctx.getTransform()).toEqual(transform);
  paper(ctx,50,200,400,80); expect(fill).toHaveBeenCalledTimes(1);
});

test("a small leading white table is preserved and ends background detection", () => {
  const ctx=canvas(), fill=ctx.fill; filterPdfPaperFills(ctx);
  paper(ctx,50,200,400,80); paper(ctx); expect(fill).toHaveBeenCalledTimes(2);
});

test("book option defaults off and a native RenderTask retains cancellation and cleans up its context", async () => {
  const ctx=canvas(), fill=ctx.fill;
  let finish: (value?:unknown)=>void;
  const task={promise:new Promise(resolve=>{finish=resolve;}),cancel:jest.fn()};
  const render=jest.fn((options:any)=>{paper(options.canvasContext); return task;});
  const page={render};
  const native:any={chapterDocList:[{text:{getPage:async()=>page}}],
    handleRenderPDFChapter:jest.fn(async()=>page.render({canvasContext:ctx,viewport:{width:600}})),removeContent:jest.fn(),
    getHighlightCoords:jest.fn(),createOneNote:jest.fn(),renderHighlighters:jest.fn(),goToPage:jest.fn()};
  const original=native.handleRenderPDFChapter, notes=native.createOneNote, coords=native.getHighlightCoords;
  (ConfigService.getReaderConfig as any).mockReturnValue("no");
  attachPdfContentBackground(native,"other"); expect(native.handleRenderPDFChapter).toBe(original);
  (ConfigService.getReaderConfig as any).mockImplementation(key=>key==="pdfHideContentBackground:cp-sat"?"yes":"no");
  attachPdfContentBackground(native,"cp-sat");
  expect(await native.handleRenderPDFChapter(0)).toBe(task); expect(fill).not.toHaveBeenCalled();
  expect(render).toHaveBeenCalledWith(expect.objectContaining({background:"rgba(0,0,0,0)",viewport:{width:600}}));
  expect(native.createOneNote).toBe(notes); expect(native.getHighlightCoords).toBe(coords);
  task.cancel(); expect(task.cancel).toHaveBeenCalledTimes(1);
  finish!(); await task.promise; expect(ctx.fill).toBe(fill);
  native.removeContent(); expect(page.render).toBe(render); expect(native.handleRenderPDFChapter).toBe(original);
});

test("render errors restore context methods and cleanup prevents late page setup", async () => {
  const ctx=canvas(), fill=ctx.fill;
  let resolvePage: (value:any)=>void;
  const page:any={render:()=>{throw new Error("render failed");}};
  const native:any={chapterDocList:[{text:{getPage:async()=>page}}],
    handleRenderPDFChapter:()=>page.render({canvasContext:ctx}),removeContent:jest.fn()};
  (ConfigService.getReaderConfig as any).mockReturnValue("yes");
  attachPdfContentBackground(native,"cp-sat");
  await expect(native.handleRenderPDFChapter(0)).rejects.toThrow("render failed");
  expect(ctx.fill).toBe(fill); native.removeContent();
  native.chapterDocList[0].text.getPage=()=>new Promise(resolve=>{resolvePage=resolve;});
  attachPdfContentBackground(native,"cp-sat"); const pending=native.handleRenderPDFChapter(0);
  native.removeContent(); const original=page.render; resolvePage!(page); await pending;
  expect(page.render).toBe(original);
});
