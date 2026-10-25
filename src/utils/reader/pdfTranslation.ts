import Book from "../../models/Book";
import { ConfigService } from "../../assets/lib/kookit-extra-browser.min";
import { ChapterContent, ParallelBlock, TranslationBook, translationApi } from "../../components/bilingualReader/api";

import { sourceBlockMetrics, sourceTextRuns } from "./pdfComparisonLayout";

export const PDF_TRANSLATION_CHANGE = "koodo-pdf-translation-change";
export const PDF_TRANSLATION_UPDATE = "koodo-pdf-translation-update";
const RANGE_KIND = "koodo-pdf-translation-v1";

export const isPdfBilingual = (key: string): boolean =>
  ConfigService.getReaderConfig(`pdfBilingual:${key}`) === "yes";

export function setPdfBilingual(key: string, enabled: boolean) {
  ConfigService.setReaderConfig(`pdfBilingual:${key}`, enabled ? "yes" : "no");
  window.dispatchEvent(new CustomEvent(PDF_TRANSLATION_CHANGE, { detail: { key } }));
}

export function preservePdfViewport(scroller: HTMLElement, pages: HTMLElement[], resize: () => void) {
  const beforeScroll = scroller.scrollTop;
  const anchor = pages.find((page) => page.offsetTop + page.offsetHeight > beforeScroll + 1);
  const beforeTop = anchor?.offsetTop || 0;
  resize();
  if (anchor) scroller.scrollTop = beforeScroll + anchor.offsetTop - beforeTop;
}

export type TranslationRange = {
  kind: typeof RANGE_KIND;
  bookId: string;
  page: number;
  parts: { blockId: string; start: number; end: number; quote: string }[];
};

function translationRange(note: any): TranslationRange | null {
  try {
    const range = JSON.parse(note.range);
    return range.kind === RANGE_KIND ? range : null;
  } catch { return null; }
}

// Text offsets belong to the translation block, never to PDF canvas coordinates.
// Existing English PDF notes continue through the unmodified native implementation.
export function captureTranslationRange(doc: Document, page: number, bookId: string): TranslationRange | null {
  const selection = doc.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const selected = selection.getRangeAt(0);
  const article = doc.querySelector(".koodo-local-translation");
  if (!article?.contains(selected.startContainer) || !article.contains(selected.endContainer)) return null;
  const parts: TranslationRange["parts"] = [];
  article.querySelectorAll<HTMLElement>("[data-translation-block]").forEach((block) => {
    if (!selected.intersectsNode(block)) return;
    const range = doc.createRange();
    range.selectNodeContents(block);
    if (block.contains(selected.startContainer)) range.setStart(selected.startContainer, selected.startOffset);
    if (block.contains(selected.endContainer)) range.setEnd(selected.endContainer, selected.endOffset);
    const before = doc.createRange();
    before.selectNodeContents(block);
    before.setEnd(range.startContainer, range.startOffset);
    const start = before.toString().length;
    const quote = range.toString();
    if (quote) parts.push({ blockId: block.dataset.translationBlock!, start, end: start + quote.length, quote });
  });
  return parts.length ? { kind: RANGE_KIND, bookId, page, parts } : null;
}

function textPosition(root: HTMLElement, offset: number): [Node, number] | null {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const length = node.textContent?.length || 0;
    if (offset <= length) return [node, offset];
    offset -= length;
  }
  return null;
}

export function clearTranslationMarks(root: ParentNode, key?: string) {
  root.querySelectorAll<HTMLElement>(".koodo-translation-note").forEach((mark) => {
    if (key && mark.dataset.key !== key) return;
    const parent = mark.parentNode;
    mark.replaceWith(...Array.from(mark.childNodes));
    parent?.normalize();
  });
}

export function paintTranslationNote(doc: Document, note: any, bookId: string, onClick: (event: Event) => void) {
  const saved = translationRange(note);
  if (!saved || saved.bookId !== bookId) return;
  clearTranslationMarks(doc, note.key);
  for (const part of saved.parts) {
    const block = Array.from(doc.querySelectorAll<HTMLElement>("[data-translation-block]"))
      .find((item) => item.dataset.translationBlock === part.blockId);
    if (!block || block.textContent?.slice(part.start, part.end) !== part.quote) continue;
    const start = textPosition(block, part.start), end = textPosition(block, part.end);
    if (!start || !end) continue;
    const range = doc.createRange();
    range.setStart(...start); range.setEnd(...end);
    const mark = doc.createElement("span");
    mark.className = "koodo-translation-note";
    mark.dataset.key = note.key;
    mark.title = note.notes || "";
    const [type, color] = String(note.color).split("-");
    const safeColor = /^#[\da-f]{3,8}$/i.test(color || "") ? color : "#FEF3CD";
    if (type === "underline" || type === "wavy" || type === "strikethrough") {
      mark.style.textDecoration = `${type === "strikethrough" ? "line-through" : "underline"} ${type === "wavy" ? "wavy" : "solid"} ${safeColor}`;
    } else mark.style.backgroundColor = safeColor;
    mark.style.color = "inherit";
    mark.style.cursor = "pointer";
    mark.appendChild(range.extractContents());
    range.insertNode(mark);
    mark.addEventListener("click", onClick);
  }
}

// Augment a native PdfRender instance. Do not replace its page renderer, navigation,
// canvas/text layer, search, popup, drawing, bookmarks or original note storage.
export function attachPdfTranslation(rendition: any, book: Book) {
  if (typeof rendition.handleRenderPDFChapter !== "function") return;
  const enabled = isPdfBilingual(book.key);
  const originals: Record<string, any> = {};
  const wrap = (name: string, implementation: (base: any, ...args: any[]) => any) => {
    originals[name] = rendition[name];
    rendition[name] = (...args: any[]) => implementation(originals[name].bind(rendition), ...args);
  };
  let disposed = false;
  let stacked = false;
  let metadata: TranslationBook | null = null;
  let metadataPromise: Promise<TranslationBook | null> | null = null;
  const content = new Map<string, ChapterContent>();
  const pending = new Map<string, Promise<ChapterContent>>();
  const notes = new Map<string, any>();
  let noteClick: (event: Event) => void = () => {};
  const mounted = new Set<number>();
  const observers = new Map<Document, ResizeObserver>();
  const listeners: { element: HTMLElement; type: string; callback: EventListener; options: any }[] = [];
  let restoreListenerRegistration = () => {};
  let restoreScrollAnchor = () => {};
  const fontSize = Math.max(15, Math.min(28, Number(ConfigService.getReaderConfig("fontSize")) || 18));
  const dark = ConfigService.getReaderConfig("backgroundColor") === "rgba(44,47,49,1)";

  const getBook = () => metadataPromise || (metadataPromise = translationApi<TranslationBook>(`/books?key=${encodeURIComponent(book.key)}`)
    .then((result) => (metadata = result)).catch(() => { metadataPromise = null; return null; }));
  const loadChapter = (chapterId: string) => {
    if (pending.has(chapterId)) return pending.get(chapterId)!;
    const request = translationApi<ChapterContent>(`/books/${metadata!.id}/chapters/${chapterId}`)
      .then((result) => { content.set(chapterId, result); return result; })
      .finally(() => pending.delete(chapterId));
    pending.set(chapterId, request);
    return request;
  };
  const physicalPage = (index: number) => index + 1 - (rendition.isStartFromEven === "yes" && rendition.readerMode === "double" ? 1 : 0);

  const resizePage = (index: number, doc: Document) => {
    if (disposed || !enabled || !doc.body.querySelector("#koodoPDFLayer")) return;
    const outer: Document | null = rendition.getDocument();
    const container = outer?.getElementById(`pdf-container-${index}`);
    const iframe = outer?.getElementById(`pdf-iframe-${index}`);
    const layer = doc.getElementById("koodoPDFLayer");
    const translation = doc.querySelector<HTMLElement>(".koodo-local-translation");
    if (!container || !iframe || !layer || !translation) return;
    if (rendition.readerMode === "scroll") {
      if (stacked) translation.style.top = `${Math.ceil(layer.getBoundingClientRect().bottom) + 16}px`;
      const height = Math.ceil(Math.max(layer.getBoundingClientRect().bottom,
        translation.offsetTop + translation.scrollHeight, translation.offsetTop + translation.offsetHeight) + 16);
      if (container.style.height !== `${height}px`) preservePdfViewport(rendition.element,
        Array.from(outer!.querySelectorAll<HTMLElement>(".pdf-container")), () => {
          container.style.paddingTop = "0px";
          container.style.height = `${height}px`;
          iframe.style.height = `${height}px`;
          rendition.getIframe().style.height = `${outer!.body.scrollHeight + 300}px`;
        });
    } else {
      translation.style.maxHeight = `${Math.max(100, rendition.element.clientHeight - 20)}px`;
      translation.style.overflowY = "auto";
    }
  };

  const renderBlocks = (article: HTMLElement, blocks: ParallelBlock[], sourceWidth: number) => {
    const doc = article.ownerDocument;
    const layer = doc.getElementById("koodoPDFLayer")!;
    const pageRect = layer.getBoundingClientRect();
    const sourceScale = pageRect.width / sourceWidth;
    const runs = sourceTextRuns(doc, layer);
    const metrics = blocks.map((block) => sourceBlockMetrics(block, runs, sourceScale, pageRect, fontSize));
    const gutter = stacked ? 16 : 24;
    const width = article.clientWidth - gutter * 2;
    let previousBottom = 28;
    blocks.forEach((block, index) => {
      const metric = metrics[index];
      const section = doc.createElement("section");
      section.dataset.sourceBlock = block.id;
      section.dataset.sourceTop = String(metric.top);
      section.dataset.sourceFontSize = String(metric.fontSize);
      section.dataset.sourceMatched = String(metric.matched);
      if (stacked) {
        section.style.position = "relative";
        section.style.marginTop = "18px";
      }
      else {
        section.style.position = "absolute";
        section.style.left = `${gutter}px`;
        const measure = block.kind === "image" ? width : Math.min(width,
          Math.max(360, (metric.right - metric.left) * 1.2), Math.max(360, metric.fontSize * 36));
        section.style.width = `${measure}px`;
      }
      let paragraph: HTMLElement | null = null;
      if (block.kind === "image") {
        const bbox = block.anchors[0].bbox;
        const image = doc.createElement("img");
        image.src = `/api/translation/books/${metadata!.id}/blocks/${block.id}/image`;
        image.alt = `第 ${block.page} 页原图，图中文字保留原样`;
        image.width = Math.max(1, Math.min(width, (bbox[2] - bbox[0]) * sourceScale));
        image.height = image.width * (bbox[3] - bbox[1]) / (bbox[2] - bbox[0]);
        image.style.display = "block";
        image.style.maxWidth = "100%";
        image.style.height = "auto";
        section.appendChild(image);
      } else {
        paragraph = doc.createElement(block.kind === "heading" ? "h2" : block.kind === "code" ? "pre" : "p");
        if (block.translation || block.kind === "code") {
          paragraph.dataset.translationBlock = block.id;
          paragraph.textContent = block.kind === "code" ? block.text : block.translation!.text;
        } else {
          paragraph.textContent = "本段尚未翻译";
          paragraph.className = "translation-pending";
        }
        if (block.translation && block.translation.status !== "accepted") {
          const status = doc.createElement("small");
          status.textContent = block.translation.status === "needs_review" ? "待复核译文" : "初稿 · 等待审校";
          status.style.cssText = "position:absolute;right:0;bottom:100%;font-size:11px";
          section.appendChild(status);
        }
        section.appendChild(paragraph);
      }
      article.appendChild(section);
      if (stacked) {
        if (paragraph) {
          paragraph.style.fontSize = `${Math.max(block.kind === "caption" ? 12 : 14, metric.fontSize * .94)}px`;
          paragraph.style.lineHeight = String(metric.lineHeight);
        }
        return;
      }
      // CJK glyphs fill more of the em than the PDF's Latin face. A small optical
      // correction keeps the perceived sizes close, rather than matching px alone.
      let size = Math.max(block.kind === "caption" ? 12 : 14, metric.fontSize * .94);
      const leading = metric.lineHeight;
      const floor = Math.max(block.kind === "caption" ? 12 : 14, size * .88);
      const nextIndex = metrics.findIndex((item, at) => at > index && item.top > metric.top + 2);
      const next = metrics[nextIndex];
      const nextLeading = next && blocks[nextIndex].kind !== "image"
        ? (next.lineHeight - 1) * Math.max(blocks[nextIndex].kind === "caption" ? 12 : 14, next.fontSize * .94) / 2 : 0;
      const sourceTop = () => block.kind === "image" ? metric.top : metric.top - (leading - 1) * size / 2;
      const applySize = () => {
        if (paragraph) { paragraph.style.fontSize = `${size}px`; paragraph.style.lineHeight = String(leading); }
        section.style.top = `${sourceTop()}px`;
      };
      applySize();
      // Fit within the source paragraph's vertical band, without clipping or
      // changing the original PDF. Bound adjustments so long translations remain
      // readable; exceptional overflow expands the pair and is explicitly marked.
      while (paragraph && next && section.offsetHeight > next.top - nextLeading - sourceTop() - 4 && size > floor + .01) {
        size = Math.max(floor, size - .25); applySize();
      }
      const top = Math.max(sourceTop(), previousBottom + (index ? 4 : 0));
      section.style.top = `${top}px`;
      section.dataset.alignment = top - sourceTop() < 1 ? "aligned" : "expanded";
      section.dataset.sourceTextTop = String(sourceTop());
      previousBottom = top + section.offsetHeight;
    });
    if (!stacked) article.style.height = `${Math.ceil(Math.max(pageRect.bottom, previousBottom + 20))}px`;
  };

  const decorate = async (index: number, force = false) => {
    if (!enabled || disposed) return;
    const doc: Document | null = rendition.getSubDocument(index);
    if (!doc?.getElementById("koodoPDFLayer")) return;
    mounted.add(index);
    let article = doc.querySelector<HTMLElement>(".koodo-local-translation");
    if (!article) {
      const style = doc.createElement("style");
      style.textContent = `
        .koodo-local-translation {position:absolute;left:${stacked ? "0" : "50%"};top:0;width:${stacked ? "100%" : "50%"};box-sizing:border-box;padding:${stacked ? "14px 16px 24px" : "0"};border-${stacked ? "top" : "left"}:1px solid ${dark ? "#596052" : "#d8d8d0"};color:${dark ? "#e7e9e3" : "#292e29"};font:${fontSize}px/1.85 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;overflow-wrap:anywhere;}
        .koodo-local-translation p,.koodo-local-translation pre{margin:0;font:inherit;white-space:pre-wrap;}
        .koodo-local-translation pre{font-family:"SFMono-Regular",Consolas,monospace;}
        .koodo-local-translation h2{font-size:1.25em;line-height:1.5;margin:0;}
        .koodo-local-translation small,.koodo-local-translation .translation-pending{font-size:12px;opacity:.75;}
        .koodo-local-translation header{font-size:12px;line-height:1.6;user-select:none;${stacked ? "" : "position:absolute;top:8px;left:24px;"}}
        .koodo-local-translation ::selection{background:#c9ddbe;color:#172514;}
      `;
      doc.head.appendChild(style);
      article = doc.createElement("article");
      article.className = "koodo-local-translation";
      article.lang = "zh-CN";
      article.setAttribute("aria-label", `第 ${physicalPage(index)} 页中文译文`);
      if (stacked) {
        article.style.left = `${rendition.element.scrollLeft}px`;
        article.style.width = `${rendition.element.clientWidth}px`;
      }
      doc.body.appendChild(article);
      const layer = doc.getElementById("koodoPDFLayer")!;
      layer.style.marginLeft = "0px";
      if (typeof ResizeObserver !== "undefined") {
        const observer = new ResizeObserver(() => resizePage(index, doc));
        observer.observe(article);
        observers.get(doc)?.disconnect();
        observers.set(doc, observer);
      }
    }
    try {
      const meta = await getBook();
      if (disposed || !article.isConnected) return;
      const chapter = meta?.chapters.find((item) => item.start_page <= physicalPage(index) && item.end_page >= physicalPage(index));
      const chapterContent = chapter ? (content.get(chapter.id) || await loadChapter(chapter.id)) : null;
      if (disposed || !article.isConnected) return;
      const blocks = chapterContent?.blocks.filter((block) => block.page === physicalPage(index)) || [];
      const signature = JSON.stringify(blocks.map((block) => [block.id, block.translation]));
      if (!force && article.dataset.signature === signature) return;
      // Background updates must not destroy the user's active translated selection.
      const selection = doc.getSelection();
      if (selection && !selection.isCollapsed && article.contains(selection.anchorNode)) return;
      article.dataset.signature = signature;
      article.replaceChildren();
      const header = doc.createElement("header");
      header.textContent = `中文译文 · PDF ${physicalPage(index)}${blocks.some((block) => block.kind === "image") ? " · 图中文字保留原样" : ""}`;
      article.appendChild(header);
      const dimension = await rendition.chapterDocList[index].text.getDimension();
      if (blocks.length) renderBlocks(article, blocks, dimension.width);
      else {
        const message = doc.createElement("p");
        message.className = "translation-pending";
        message.textContent = meta ? "本页没有可提取的正文。" : "打开“翻译”面板，提取本书后开始翻译。";
        article.appendChild(message);
      }
      notes.forEach((note) => { if (note.chapterIndex === index) paintTranslationNote(doc, note, meta!.id, noteClick); });
      resizePage(index, doc);
    } catch {
      if (article.isConnected && !article.querySelector("[data-translation-block]")) article.textContent = "译文暂时无法读取，请打开翻译面板重试。原文仍可阅读。";
    }
  };

  for (const name of ["handlePDFScrollEvent", "record", "recordByChapter", "handleRecord"]) {
    if (typeof rendition[name] === "function") wrap(name, (base, ...args) => disposed ? undefined : base(...args));
  }
  wrap("renderTo", async (base, element) => {
      stacked = enabled && rendition.readerMode === "scroll" && element.clientWidth < 560;
      if (enabled) element.dataset.pdfTranslationLayout = stacked ? "stacked" : "columns";
      const previousAnchor = element.style.overflowAnchor;
      if (enabled) element.style.overflowAnchor = "none";
      restoreScrollAnchor = () => { element.style.overflowAnchor = previousAnchor; };
      // PdfRender installs listeners on the persistent #page-area. Remove the
      // previous rendition's listeners when toggling or resizing, otherwise a
      // detached PDF document can keep overwriting the new page's position.
      const add = element.addEventListener;
      element.addEventListener = (type, listener, options) => {
        const guarded = (event: Event) => {
          if (!disposed) typeof listener === "function" ? listener.call(element, event) : listener?.handleEvent(event);
        };
        listeners.push({ element, type, callback: guarded, options });
        add.call(element, type, guarded, options);
      };
      restoreListenerRegistration = () => { element.addEventListener = add; };
      const result = await base(element);
      if (enabled && rendition.readerMode === "scroll") {
        const requested = Math.min(3, Math.max(.5, Math.abs(Number(rendition.scale)) || 1));
        // On a phone, keep the fixed PDF legible and let its native scroller pan.
        // The existing page-width control can still zoom in and out.
        const zoom = stacked ? Math.max(1, 720 * requested / element.clientWidth) : Math.max(1, requested);
        const frame = rendition.getIframe();
        if (frame) { frame.style.width = `${zoom * 100}%`; rendition.pdfScale = 0; }
        element.scrollLeft = Math.max(0, (element.scrollWidth - element.clientWidth) / 2);
        if (stacked) {
          const keepTranslationVisible = () => {
            mounted.forEach((index) => {
              const article = rendition.getSubDocument(index)?.querySelector(".koodo-local-translation");
              if (article) article.style.left = `${element.scrollLeft}px`;
            });
          };
          element.addEventListener("scroll", keepTranslationVisible);
        }
      }
      const doc: Document | null = rendition.getDocument();
      if (enabled && !stacked && rendition.readerMode === "scroll") doc?.querySelectorAll<HTMLElement>(".pdf-container").forEach((container) => {
        container.style.paddingTop = `${parseFloat(container.style.paddingTop) / 2}%`;
      });
      return result;
  });
  wrap("handleRenderPDFChapter", async (base, index, reload) => {
      if (disposed) return;
      const result = await base(index, reload);
      if (enabled) void decorate(index);
      return result;
  });
  if (enabled) wrap("getPdfScale", async (base) => {
    const original = await base();
    if (stacked) return original;
    const index = rendition.templateChapterDocIndex || 0;
    const dimension = await rendition.chapterDocList[index].text.getDimension();
    const frame = rendition.getSubIframe(index);
    return Math.min(original, (frame.clientWidth / 2 - 8) / dimension.width);
  });
  if (enabled && typeof rendition.getPageSize === "function") wrap("getPageSize", (base, index) => {
    const size = base(index);
    return size && rendition.readerMode === "scroll" ? { ...size, scrollLeft: rendition.element.scrollLeft } : size;
  });
  wrap("getHighlightCoords", async (base, index) => {
    const page = index ?? Number(rendition.getPosition().chapterDocIndex || 0);
    const doc = rendition.getSubDocument(page);
    return (metadata && doc && captureTranslationRange(doc, page, metadata.id)) || base(index);
  });
  wrap("getPositionByChapter", (base, index) => {
    const position = base(index);
    const doc = rendition.getSubDocument(index);
    const selected = metadata && doc && captureTranslationRange(doc, index, metadata.id);
    return selected ? { ...position, localTranslation: selected } : position;
  });
  wrap("goToPosition", async (base, serialized) => {
    const result = await base(serialized);
    const location = JSON.parse(serialized);
    const anchor: TranslationRange | undefined = location.localTranslation;
    if (!anchor || anchor.kind !== RANGE_KIND) return result;
    if (!enabled) {
      // A translated note opens its source page, then the same native Viewer adds
      // the translated side again. The original PDF location remains authoritative.
      ConfigService.setObjectConfig(book.key, { ...rendition.getPosition(), localTranslation: anchor }, "recordLocation");
      setPdfBilingual(book.key, true);
    } else {
      await decorate(anchor.page);
      const doc: Document | null = rendition.getSubDocument(anchor.page);
      const target = Array.from(doc?.querySelectorAll<HTMLElement>("[data-translation-block]") || [])
        .find((node) => node.dataset.translationBlock === anchor.parts[0]?.blockId);
      if (target && rendition.readerMode === "scroll") {
        const container = rendition.getDocument()?.getElementById(`pdf-container-${anchor.page}`);
        if (container) rendition.element.scrollTo(0, Math.max(0, container.offsetTop + target.getBoundingClientRect().top - 100));
      } else if (target) {
        const article = target.closest<HTMLElement>(".koodo-local-translation");
        if (article) article.scrollTop = target.offsetTop;
      }
    }
    return result;
  });
  wrap("renderHighlighters", async (base, items, callback) => {
    noteClick = callback;
    const translated = items.filter((note) => translationRange(note));
    translated.forEach((note) => notes.set(note.key, note));
    const result = await base(items.filter((note) => !translationRange(note)), callback);
    if (metadata) translated.forEach((note) => {
      const doc = rendition.getSubDocument(note.chapterIndex);
      if (doc) paintTranslationNote(doc, note, metadata!.id, callback);
    });
    return result;
  });
  wrap("createOneNote", async (base, note, callback) => {
    if (!translationRange(note)) return base(note, callback);
    noteClick = callback;
    notes.set(note.key, note);
    const doc = rendition.getSubDocument(note.chapterIndex);
    if (metadata && doc) paintTranslationNote(doc, note, metadata.id, callback);
    rendition.clearSelection();
  });
  wrap("removeOneNote", (base, key, index) => {
    notes.delete(key);
    const doc = rendition.getSubDocument(index ?? Number(rendition.getPosition().chapterDocIndex || 0));
    if (doc) clearTranslationMarks(doc, key);
    return base(key, index);
  });
  const refresh = async () => {
    if (!enabled || disposed) return;
    // Only poll chapters that contain mounted pages, and only while tasks are active.
    for (const [id, chapter] of Array.from(content.entries())) {
      if (["queued", "running"].includes(chapter.task?.status || "")) {
        try { await loadChapter(id); } catch { /* Preserve last readable copy. */ }
      }
    }
    for (const index of Array.from(mounted)) void decorate(index);
  };
  const updated = (event: Event) => {
    if ((event as CustomEvent).detail?.key !== book.key) return;
    content.clear(); metadataPromise = null;
    void refresh();
  };
  window.addEventListener(PDF_TRANSLATION_UPDATE, updated);
  const timer = enabled ? window.setInterval(refresh, 2500) : null;
  wrap("removeContent", (base, ...args) => {
    disposed = true;
    if (timer) window.clearInterval(timer);
    if (rendition.scrollPDFInterval) window.clearInterval(rendition.scrollPDFInterval);
    window.removeEventListener(PDF_TRANSLATION_UPDATE, updated);
    observers.forEach((observer) => observer.disconnect());
    rendition.off?.("rendered page-changed annotation-changed");
    listeners.forEach(({ element, type, callback, options }) => element.removeEventListener(type, callback, options));
    restoreListenerRegistration();
    restoreScrollAnchor();
    if (rendition.element?.dataset) delete rendition.element.dataset.pdfTranslationLayout;
    const guards = new Set(["handlePDFScrollEvent", "record", "recordByChapter", "handleRecord", "handleRenderPDFChapter"]);
    for (const [name, original] of Object.entries(originals)) if (!guards.has(name)) rendition[name] = original;
    return base(...args);
  });
}
