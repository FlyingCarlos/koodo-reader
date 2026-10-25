import { jest, expect, beforeEach, afterEach, test } from "@jest/globals";
import { attachPdfTranslation, captureTranslationRange, clearTranslationMarks, paintTranslationNote, preservePdfViewport } from "./pdfTranslation";
import { ConfigService } from "../../assets/lib/kookit-extra-browser.min";

jest.mock("../../assets/lib/kookit-extra-browser.min", () => ({ ConfigService: { getReaderConfig: require("@jest/globals").jest.fn(() => "no") } }));
jest.mock("../../components/bilingualReader/api", () => ({ translationApi: require("@jest/globals").jest.fn() }));

function select(root: HTMLElement, start: number, end: number) {
  const range = document.createRange();
  range.setStart(root.firstChild!, start); range.setEnd(root.firstChild!, end);
  const selection = document.getSelection()!;
  selection.removeAllRanges(); selection.addRange(range);
}

beforeEach(() => {
  (ConfigService.getReaderConfig as any).mockReturnValue("no");
  document.body.innerHTML = '<div id="source">English PDF text</div><article class="koodo-local-translation"><p data-translation-block="p0019-b001-0">推理是模型生命周期的第二个阶段。</p></article>';
});

test.each([[165, "stacked", 2], [816, "columns", 1]])(
  "native reading width %i selects %s without overriding native viewport or controls",
  async (width, layout, expectedScale) => {
    (ConfigService.getReaderConfig as any).mockImplementation((key: string) => key.startsWith("pdfBilingual:") ? "yes" : "18");
    const element = document.createElement("div");
    Object.defineProperty(element, "clientWidth", { value: width });
    element.style.width = `${width}px`; document.body.appendChild(element);
    const native: any = {
      readerMode: "scroll", element, handleRenderPDFChapter: jest.fn(),
      renderTo: jest.fn(), getPdfScale: async () => 2, getDocument: () => document,
      removeContent: jest.fn(), getHighlightCoords: jest.fn(), renderHighlighters: jest.fn(),
      createOneNote: jest.fn(), removeOneNote: jest.fn(), getPositionByChapter: jest.fn(), goToPosition: jest.fn(),
    };
    attachPdfTranslation(native, { key: "test" } as any);
    await native.renderTo(element);
    expect(element.dataset.pdfTranslationLayout).toBe(layout);
    expect(await native.getPdfScale()).toBe(expectedScale);
    expect(element.style.width).toBe(`${width}px`);
    native.removeContent();
    expect(element.dataset.pdfTranslationLayout).toBeUndefined();
  }
);
afterEach(() => { document.getSelection()?.removeAllRanges(); jest.clearAllMocks(); });

test("asynchronous translation height above the viewport preserves the visible native page and offset", () => {
  const scroller = document.createElement("div");
  const first = document.createElement("div"), second = document.createElement("div");
  let height = 400;
  Object.defineProperty(first, "offsetTop", { get: () => 0 });
  Object.defineProperty(first, "offsetHeight", { get: () => height });
  Object.defineProperty(second, "offsetTop", { get: () => height });
  Object.defineProperty(second, "offsetHeight", { get: () => 600 });
  scroller.scrollTop = 450;
  preservePdfViewport(scroller, [first, second], () => { height = 800; });
  expect(scroller.scrollTop).toBe(850);
  preservePdfViewport(scroller, [first, second], () => {});
  expect(scroller.scrollTop).toBe(850);
});

test("English selections stay native; Chinese ranges use stable block offsets and quoted text", () => {
  select(document.querySelector("#source")!, 0, 7);
  expect(captureTranslationRange(document, 18, "book")).toBeNull();
  select(document.querySelector("p")!, 0, 2);
  const range = captureTranslationRange(document, 18, "book")!;
  expect(range.parts).toEqual([{ blockId: "p0019-b001-0", start: 0, end: 2, quote: "推理" }]);
  const note = { key: "note", range: JSON.stringify(range), color: "underline-#123456", notes: "test" };
  const clicked = jest.fn();
  document.getSelection()?.removeAllRanges();
  paintTranslationNote(document, note, "book", clicked);
  const mark = document.querySelector<HTMLElement>(".koodo-translation-note")!;
  expect(mark.textContent).toBe("推理");
  mark.click(); expect(clicked).toHaveBeenCalledTimes(1);
  clearTranslationMarks(document);
  expect(document.querySelector("p")!.textContent).toBe("推理是模型生命周期的第二个阶段。");
  // Reload/resizing can replace the DOM; saved text anchors restore independently of pixel geometry.
  paintTranslationNote(document, note, "book", clicked);
  expect(document.querySelectorAll(".koodo-translation-note")).toHaveLength(1);
  clearTranslationMarks(document);
  document.querySelector("p")!.textContent = "译文已经改变，原先选区不再匹配";
  paintTranslationNote(document, note, "book", clicked);
  expect(document.querySelectorAll(".koodo-translation-note")).toHaveLength(0);
});

test("Chinese annotation capture spans paragraphs without including page labels", () => {
  const article = document.querySelector("article")!;
  article.insertAdjacentHTML("beforeend", '<p data-translation-block="next">第二段译文。</p>');
  const paragraphs = article.querySelectorAll("p");
  const range = document.createRange();
  range.setStart(paragraphs[0].firstChild!, 2); range.setEnd(paragraphs[1].firstChild!, 3);
  document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
  const saved = captureTranslationRange(document, 18, "book")!;
  expect(saved.parts.map((part) => part.quote)).toEqual(["是模型生命周期的第二个阶段。", "第二段"]);
  const note = { key: "multi", range: JSON.stringify(saved), color: "background-#FEF3CD" };
  paintTranslationNote(document, note, "different-book", jest.fn());
  expect(document.querySelectorAll(".koodo-translation-note")).toHaveLength(0);
});

test("adapter delegates original notes and navigation, isolates translated notes even while disabled, and cleans up", async () => {
  const sourceCoords = { page: 18, coords: [[10,20,30,40]] };
  const native = {
    handleRenderPDFChapter: jest.fn(), getHighlightCoords: jest.fn(async () => sourceCoords),
    renderHighlighters: jest.fn(async () => {}), createOneNote: jest.fn(async () => {}),
    removeOneNote: jest.fn(), removeContent: jest.fn(),
    goToPage: jest.fn(), search: jest.fn(), getSubDocument: () => document,
    getPositionByChapter: jest.fn(() => ({ chapterDocIndex: 18 })), goToPosition: jest.fn(),
    getPosition: () => ({ chapterDocIndex: 18 }), clearSelection: jest.fn(),
  };
  const nativeRemoval = native.removeContent;
  const nativeRestore = native.renderHighlighters, nativeCreate = native.createOneNote;
  const jump = native.goToPage, search = native.search;
  attachPdfTranslation(native, { key: "test" } as any);
  expect(native.goToPage).toBe(jump); expect(native.search).toBe(search);
  select(document.querySelector("#source")!, 0, 7);
  expect(await native.getHighlightCoords()).toBe(sourceCoords);
  const original = { key: "native", range: JSON.stringify(sourceCoords) };
  const translated = { key: "translated", range: JSON.stringify({ kind: "koodo-pdf-translation-v1", bookId: "book", page: 18, parts: [] }) };
  const callback = jest.fn();
  await (native.renderHighlighters as any)([original, translated], callback);
  expect(nativeRestore).toHaveBeenCalledWith([original], callback);
  await (native.createOneNote as any)(original, callback);
  await (native.createOneNote as any)(translated, callback);
  expect(nativeCreate).toHaveBeenCalledTimes(1);
  expect(nativeCreate).toHaveBeenCalledWith(original, callback);
  expect(native.clearSelection).toHaveBeenCalledTimes(1);
  native.removeContent();
  expect(native.removeContent).toBe(nativeRemoval);
  expect(nativeRemoval).toHaveBeenCalledTimes(1);
  expect(ConfigService.getReaderConfig).toHaveBeenCalled();
});

test("disposing a native rendition removes persistent scroll listeners and ignores delayed old-page records", async () => {
  const element = document.createElement("div"); document.body.appendChild(element);
  const record = jest.fn();
  const native: any = {
    handleRenderPDFChapter: jest.fn(), handleRecord: record, record,
    renderTo: async (target) => { target.addEventListener("scroll", () => native.handleRecord()); },
    getHighlightCoords: jest.fn(), renderHighlighters: jest.fn(), createOneNote: jest.fn(),
    removeOneNote: jest.fn(), removeContent: jest.fn(), getDocument: () => document,
    getPositionByChapter: jest.fn(), goToPosition: jest.fn(),
  };
  const registration = element.addEventListener;
  attachPdfTranslation(native, { key: "test" } as any);
  await native.renderTo(element);
  element.dispatchEvent(new Event("scroll")); expect(record).toHaveBeenCalledTimes(1);
  native.removeContent();
  element.dispatchEvent(new Event("scroll")); native.record(); native.handleRecord();
  expect(record).toHaveBeenCalledTimes(1);
  expect(element.addEventListener).toBe(registration);
});
