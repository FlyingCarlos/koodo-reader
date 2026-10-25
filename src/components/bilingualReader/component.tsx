import React, { useCallback, useEffect, useState } from "react";
import Book from "../../models/Book";
import BookUtil from "../../utils/file/bookUtil";
import { isReadingRawPDF } from "../../utils/common";
import { isPdfBilingual, PDF_TRANSLATION_UPDATE, setPdfBilingual, visiblePdfPage } from "../../utils/reader/pdfTranslation";
import { ChapterContent, TranslationApiError, TranslationBook, translationApi } from "./api";
import "./reader.css";

const TASK_LABELS: Record<string, string> = {
  queued: "等待翻译", running: "正在翻译与审校", completed: "本章翻译完成",
  paused: "已暂停", failed: "翻译中断，已完成部分已保存",
  paused_usage_limit: "订阅额度已达上限，译文已保存", needs_review: "有译文需要复核",
};

// Only task/display controls live here. Content, navigation, selection menus and
// notes stay in the existing Viewer and native PDF rendition.
export default function TranslationPanel({ book, rendition }: {
  book: Book; rendition: any;
}) {
  const [metadata, setMetadata] = useState<TranslationBook | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [enabled, setEnabled] = useState(isPdfBilingual(book.key));
  const [page, setPage] = useState(1);
  const [stacked, setStacked] = useState(false);
  const [models, setModels] = useState<{slug: string; display_name: string}[]>([]);
  const [model, setModel] = useState("");
  const [content, setContent] = useState<ChapterContent | null>(null);
  const chapter = metadata?.chapters.find((item) => item.start_page <= page && item.end_page >= page);
  const notify = () => window.dispatchEvent(new CustomEvent(PDF_TRANSLATION_UPDATE, { detail: { key: book.key } }));
  const loadBook = useCallback(async () => {
    setError("");
    try {
      setMetadata(await translationApi<TranslationBook>(`/books?key=${encodeURIComponent(book.key)}`));
      setMissing(false);
    } catch (failure) {
      if (failure instanceof TranslationApiError && failure.status === 404) setMissing(true);
      else setError(failure instanceof Error ? failure.message : "读取翻译信息失败，请重试。");
    }
  }, [book.key]);
  useEffect(() => {
    void loadBook();
    let cancelled = false;
    translationApi<{slug: string; display_name: string}[]>("/models").then((result) => {
      if (!cancelled) { setModels(result); setModel(result[0]?.slug || ""); }
    }).catch(() => { if (!cancelled) setError("订阅连接不可用，请在本机重新登录翻译后台。"); });
    return () => { cancelled = true; };
  }, [loadBook]);
  useEffect(() => {
    const update = () => {
      const position = rendition?.getPosition();
      const index = Number(position?.chapterDocIndex || 0);
      const offset = rendition?.isStartFromEven === "yes" && rendition?.readerMode === "double" ? 1 : 0;
      setPage(visiblePdfPage(rendition) || Math.max(1, index + 1 - offset));
      setStacked(rendition?.element?.dataset.pdfTranslationLayout === "stacked");
    };
    update();
    const timer = window.setInterval(update, 600);
    return () => window.clearInterval(timer);
  }, [rendition]);
  useEffect(() => {
    if (!metadata || !chapter) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    setContent(null);
    const update = async () => {
      try {
        const result = await translationApi<ChapterContent>(`/books/${metadata.id}/chapters/${chapter.id}`);
        if (!cancelled) { setContent(result); timer = setTimeout(update, 2200); }
      } catch (failure) {
        if (!cancelled) { setError(failure instanceof Error ? failure.message : "读取任务失败。"); timer = setTimeout(update, 5000); }
      }
    };
    void update();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [metadata, chapter?.id]);
  const upload = async (file?: File) => {
    setBusy("正在提取本书…"); setError("");
    try {
      const buffer = file || await BookUtil.fetchBook(book.key, "pdf", true, book.path);
      if (!buffer || typeof buffer === "boolean") throw new Error("无法读取书库中的 PDF，请选择原始文件。");
      setMetadata(await translationApi<TranslationBook>(`/books?key=${encodeURIComponent(book.key)}&title=${encodeURIComponent(book.name)}`, {
        method: "POST", headers: { "Content-Type": "application/pdf" }, body: buffer,
      }));
      setMissing(false); notify();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "提取失败，请重试。"); }
    finally { setBusy(""); }
  };
  const taskAction = async (action: "translate" | "pause" | "resume") => {
    if (!metadata || !chapter) return;
    setBusy("正在更新任务…"); setError("");
    try {
      const task = await translationApi<NonNullable<ChapterContent["task"]>>(
        action === "translate" ? `/books/${metadata.id}/chapters/${chapter.id}/translate` : `/tasks/${content!.task!.id}/${action}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: action === "translate" ? JSON.stringify({ model }) : undefined }
      );
      setContent((value) => value ? { ...value, task } : value); notify();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "操作失败，请重试。"); }
    finally { setBusy(""); }
  };
  const task = content?.task;
  const running = task && ["queued", "running"].includes(task.status);
  const pageFormat = content?.page_formats?.[String(page)];
  const pageReady = content?.blocks.filter(block => block.page === page)
    .every(block => block.kind === "image" || block.kind === "code" || !!block.translation);
  const restoreFormat = async () => {
    if (!metadata || !chapter) return;
    setBusy("正在恢复本页格式…"); setError("");
    try {
      await translationApi(`/books/${metadata.id}/chapters/${chapter.id}/pages/${page}/format`, { method: "POST" });
      setContent(await translationApi<ChapterContent>(`/books/${metadata.id}/chapters/${chapter.id}`)); notify();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "恢复格式失败，已有译文仍保留。"); }
    finally { setBusy(""); }
  };
  return <section className="pdf-translation-panel" aria-label="翻译与双语设置">
    <label className="pdf-translation-toggle"><input type="checkbox" checked={enabled}
      disabled={!isReadingRawPDF(book) || !metadata || !rendition || !!busy}
      onChange={(event) => { setEnabled(event.target.checked); setPdfBilingual(book.key, event.target.checked); }} />显示英中对照</label>
    <p className="pdf-translation-hint">{stacked ? "窄屏按原页上下对照，原 PDF 在上、中文在下。" : "左侧保留原 PDF，右侧显示当前页译文。"}选中菜单、目录、跳转与笔记继续使用原阅读器。</p>
    {!isReadingRawPDF(book) && <p className="pdf-translation-hint">请切回 PDF 原版式后开启双语显示。</p>}
    {error && <p className="pdf-translation-error" role="alert">{error}<button onClick={loadBook}>重试</button></p>}
    {missing ? <div className="pdf-translation-import">
      <button disabled={!!busy} onClick={() => upload()}>{busy || "提取本书"}</button>
      <label>选择原始 PDF<input type="file" accept="application/pdf,.pdf" disabled={!!busy}
        onChange={(event) => event.target.files?.[0] && upload(event.target.files[0])} /></label>
    </div> : metadata && chapter ? <div className="pdf-translation-task">
      <h3>{chapter.title}</h3><p>PDF {chapter.start_page}–{chapter.end_page} 页 · 当前第 {page} 页</p>
      {!task && <><label htmlFor="pdf-translation-model">翻译模型</label>
        <select id="pdf-translation-model" value={model} onChange={(event) => setModel(event.target.value)}>
          {!models.length && <option value="">订阅未连接</option>}
          {models.map((item) => <option key={item.slug} value={item.slug}>{item.display_name}</option>)}
        </select><button disabled={!!busy || !model || !content} onClick={() => taskAction("translate")}>翻译当前章节</button></>}
      {task && <><div role="status"><span>{TASK_LABELS[task.status] || task.status}</span><span>{task.completed} / {task.total} 段已审校</span></div>
        <progress aria-label="章节翻译进度" value={task.completed} max={task.total || 1} />
        {task.batch_count !== undefined && <p className="pdf-translation-hint">多段合批：共 {task.batch_count} 批，已完成 {task.completed_batches || 0} 批。</p>}
        {running && <button disabled={!!busy} onClick={() => taskAction("pause")}>暂停翻译</button>}
        {["paused", "failed", "paused_usage_limit"].includes(task.status) && <button disabled={!!busy} onClick={() => taskAction("resume")}>继续翻译</button>}
      </>}
      {task && !running && pageFormat && <div className="pdf-translation-format">
        {pageFormat.status === "ready" ? <p role="status">本页格式已恢复</p> : <>
          <p className="pdf-translation-hint">复用已有译文，恢复本页加粗、特殊字体与表格。不会重新翻译正文。</p>
          <button disabled={!!busy || !pageReady} onClick={restoreFormat}>{busy || "恢复本页格式"}</button>
        </>}
      </div>}
    </div> : !error && <p role="status">正在读取章节…</p>}
  </section>;
}
