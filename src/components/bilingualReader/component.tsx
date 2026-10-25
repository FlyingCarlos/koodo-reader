import React, { useCallback, useEffect, useRef, useState } from "react";
import Book from "../../models/Book";
import BookUtil from "../../utils/file/bookUtil";
import { ConfigService } from "../../assets/lib/kookit-extra-browser.min";
import {
  ChapterContent,
  ParallelBlock,
  TranslationApiError,
  TranslationBook,
  translationApi,
} from "./api";
import "./reader.css";

const TASK_LABELS: Record<string, string> = {
  queued: "等待翻译",
  running: "正在翻译与审校",
  completed: "本章翻译完成",
  paused: "已暂停，译文已保存",
  failed: "翻译中断，已完成部分已保存",
  paused_usage_limit: "订阅额度已达上限，译文已保存",
  needs_review: "本章有译文需要复核",
};

type Location = { chapterId?: string; blockId?: string };

export default function BilingualReader({ book, onClose }: { book: Book; onClose: () => void }) {
  const saved: Location = ConfigService.getObjectConfig(book.key, "translationLocation", {});
  const [document, setDocument] = useState<TranslationBook | null>(null);
  const [chapterId, setChapterId] = useState(saved.chapterId || "");
  const [content, setContent] = useState<ChapterContent | null>(null);
  const [models, setModels] = useState<{ slug: string; display_name: string }[]>([]);
  const [model, setModel] = useState("");
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [missing, setMissing] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [fontSize, setFontSize] = useState(
    Math.min(24, Math.max(15, Number(ConfigService.getReaderConfig("translationFontSize")) || 18))
  );
  const [page, setPage] = useState(1);
  const [jumpValue, setJumpValue] = useState("");
  const scroll = useRef<HTMLDivElement>(null);
  const lastPersist = useRef(0);
  const targetBlock = useRef<string | null>(saved.blockId || null);
  const requestRef = useRef(0);
  const chapterRef = useRef(chapterId);
  chapterRef.current = chapterId;

  useEffect(() => {
    const previous = window.document.title;
    window.document.title = `${book.name} · 英中对照 - Koodo Reader`;
    return () => { window.document.title = previous; };
  }, [book.name]);

  const loadBook = useCallback(async () => {
    setError("");
    try {
      const result = await translationApi<TranslationBook>(`/books?key=${encodeURIComponent(book.key)}`);
      setDocument(result);
      setMissing(false);
      setChapterId((current) => result.chapters.some((chapter) => chapter.id === current)
        ? current
        : (result.chapters.find((chapter) => /^Chapter\s+\d/i.test(chapter.title)) || result.chapters[0]).id
      );
    } catch (failure) {
      if (failure instanceof TranslationApiError && failure.status === 404) setMissing(true);
      else setError(failure instanceof Error ? failure.message : "读取章节失败，请重试。");
    }
  }, [book.key]);

  useEffect(() => {
    loadBook();
    let cancelled = false;
    translationApi<{ connected: boolean; plan_usage_enabled: boolean }>("/status").then((status) => {
      if (!cancelled) setConnected(status.connected && status.plan_usage_enabled);
    }).catch(() => {});
    translationApi<{ slug: string; display_name: string }[]>("/models").then((result) => {
      if (!cancelled) {
        setModels(result);
        setModel(result[0]?.slug || "");
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [loadBook]);

  const restoreTarget = useCallback((blocks: ParallelBlock[]) => {
    if (!scroll.current) return;
    let target = targetBlock.current;
    if (target?.startsWith("page:")) {
      const value = Number(target.slice(5));
      target = blocks.find((block) => block.end_page >= value)?.id || null;
    }
    if (target) {
      const element = Array.from(scroll.current.querySelectorAll<HTMLElement>("[data-block-id]"))
        .find((row) => row.dataset.blockId === target);
      element?.scrollIntoView({ block: "start" });
      if (element) setPage(Number(element.dataset.page));
      targetBlock.current = null;
    }
    else if (blocks.length) setPage(blocks[0].page);
  }, []);

  useEffect(() => {
    if (!document || !chapterId) return;
    const currentRequest = ++requestRef.current;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let first = true;
    setContent(null);
    setError("");
    const fetchChapter = async () => {
      try {
        const result = await translationApi<ChapterContent>(
          `/books/${document.id}/chapters/${chapterId}`
        );
        if (cancelled || requestRef.current !== currentRequest) return;
        setContent(result);
        if (first) {
          first = false;
          if (scroll.current) scroll.current.scrollTop = 0;
          requestAnimationFrame(() => restoreTarget(result.blocks));
        }
        // Keep watching the selected chapter so a resumed background job appears immediately.
        timer = setTimeout(fetchChapter, result.task?.status === "running" ? 1600 : 3500);
      } catch (failure) {
        if (!cancelled) {
          setError(failure instanceof Error ? failure.message : "读取译文失败，请重试。");
          timer = setTimeout(fetchChapter, 5000);
        }
      }
    };
    fetchChapter();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [document, chapterId, restoreTarget]);

  const upload = async (file?: File) => {
    setBusy("正在提取章节与段落…");
    setError("");
    try {
      const buffer = file || await BookUtil.fetchBook(book.key, "pdf", true, book.path);
      if (!buffer || typeof buffer === "boolean") {
        throw new Error("无法读取书库中的 PDF，请选择这本书的原始文件。");
      }
      const result = await translationApi<TranslationBook>(
        `/books?key=${encodeURIComponent(book.key)}&title=${encodeURIComponent(book.name)}`,
        { method: "POST", headers: { "Content-Type": "application/pdf" }, body: buffer }
      );
      setDocument(result);
      setMissing(false);
      setChapterId((result.chapters.find((chapter) => /^Chapter\s+\d/i.test(chapter.title))
        || result.chapters[0]).id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "提取失败，请选择原始 PDF 重试。");
    } finally { setBusy(""); }
  };

  const startTranslation = async () => {
    if (!document || !content) return;
    setBusy("正在提交章节任务…");
    setError("");
    try {
      const task = await translationApi<NonNullable<ChapterContent["task"]>>(
        `/books/${document.id}/chapters/${chapterId}/translate`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }) }
      );
      setContent((value) => value ? { ...value, task } : value);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "提交失败，请重试。"); }
    finally { setBusy(""); }
  };

  const control = async (action: "pause" | "resume") => {
    if (!content?.task) return;
    setBusy("正在更新任务…");
    setError("");
    try {
      const task = await translationApi<NonNullable<ChapterContent["task"]>>(
        `/tasks/${content.task.id}/${action}`, { method: "POST" }
      );
      setContent((value) => value ? { ...value, task } : value);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "操作失败，请重试。"); }
    finally { setBusy(""); }
  };

  const navigate = (id: string, blockId?: string | null) => {
    targetBlock.current = blockId || null;
    setSidebarOpen(false);
    if (id === chapterId && blockId) {
      requestAnimationFrame(() => restoreTarget(content?.blocks || []));
    } else setChapterId(id);
    ConfigService.setObjectConfig(book.key, { chapterId: id, blockId: blockId || null }, "translationLocation");
  };

  const jumpPage = (event: React.FormEvent) => {
    event.preventDefault();
    if (!document) return;
    const value = Math.min(document.page_count, Math.max(1, Number(jumpValue)));
    const chapter = document.chapters.find((item) => item.start_page <= value && item.end_page >= value);
    if (!chapter) return;
    if (chapter.id === chapterId) {
      const block = content?.blocks.find((item) => item.end_page >= value);
      if (block) navigate(chapter.id, block.id);
    } else {
      // Loading a different chapter will resolve its physical page to a source block below.
      targetBlock.current = `page:${value}`;
      setChapterId(chapter.id);
      setSidebarOpen(false);
      ConfigService.setObjectConfig(book.key, {
        chapterId: chapter.id, blockId: `page:${value}`,
      }, "translationLocation");
    }
    setJumpValue("");
  };

  const persistScroll = () => {
    if (!scroll.current || Date.now() - lastPersist.current < 350) return;
    lastPersist.current = Date.now();
    const top = scroll.current.getBoundingClientRect().top + 65;
    const visible = Array.from(scroll.current.querySelectorAll<HTMLElement>("[data-block-id]"))
      .find((element) => element.getBoundingClientRect().bottom > top);
    if (visible) {
      setPage(Number(visible.dataset.page));
      ConfigService.setObjectConfig(book.key, {
        chapterId: chapterRef.current, blockId: visible.dataset.blockId,
      }, "translationLocation");
    }
  };

  const changeFont = (amount: number) => {
    const next = Math.min(24, Math.max(15, fontSize + amount));
    setFontSize(next);
    ConfigService.setReaderConfig("translationFontSize", String(next));
  };

  const task = content?.task;
  const running = task?.status === "running" || task?.status === "queued";
  const resumable = task && ["paused", "failed", "paused_usage_limit"].includes(task.status);
  const dark = window.document.documentElement.dataset.theme === "dark";
  const chapterIndex = document?.chapters.findIndex((item) => item.id === chapterId) ?? -1;

  return (
    <section className={`bi-reader${dark ? " bi-dark" : ""}`} aria-label="英中双语阅读">
      <header className="bi-toolbar">
        <button className="bi-back" onClick={onClose}>返回阅读器</button>
        <button className="bi-outline-toggle" aria-expanded={sidebarOpen}
          onClick={() => setSidebarOpen(!sidebarOpen)}>目录</button>
        <div className="bi-book-name"><strong>{book.name}</strong><span>英中对照</span></div>
        <div className="bi-font-controls" aria-label="阅读字号">
          <button aria-label="减小字号" disabled={fontSize <= 15} onClick={() => changeFont(-1)}>A−</button>
          <button aria-label="增大字号" disabled={fontSize >= 24} onClick={() => changeFont(1)}>A+</button>
        </div>
        {document && <a className="bi-original" target="_blank" rel="noreferrer"
          href={`/api/translation/books/${document.id}/source.pdf#page=${page}`}>原 PDF</a>}
      </header>
      <div className="bi-workspace">
        {document && <aside className={`bi-sidebar${sidebarOpen ? " is-open" : ""}`} aria-label="章节目录">
          <div className="bi-sidebar-heading"><h2>目录</h2><span>{document.page_count} 页</span></div>
          <nav aria-label="翻译章节">
            {document.chapters.map((chapter) => <div key={chapter.id}>
              <button className={`bi-chapter${chapter.id === chapterId ? " is-current" : ""}`}
                aria-current={chapter.id === chapterId ? "page" : undefined}
                onClick={() => navigate(chapter.id)}>
                <span>{chapter.title}</span><small>{chapter.start_page}–{chapter.end_page}</small>
              </button>
              {chapter.id === chapterId && document.outline.filter((item) => item.chapter_id === chapter.id
                && item.level > Math.min(...document.outline.filter((entry) => entry.chapter_id === chapter.id)
                  .map((entry) => entry.level)))
                .map((entry, index) => <button key={`${entry.page}-${index}`} className="bi-subchapter"
                  onClick={() => navigate(chapterId, entry.block_id)}>{entry.title}</button>)}
            </div>)}
          </nav>
          <form className="bi-page-jump" onSubmit={jumpPage}>
            <label htmlFor="bi-page">跳至 PDF 页</label>
            <div><input id="bi-page" type="number" min="1" max={document.page_count}
              placeholder={String(page)} value={jumpValue} onChange={(event) => setJumpValue(event.target.value)} required />
              <button type="submit">跳转</button></div>
          </form>
          <p className="bi-sidebar-note">原文与译文按段落对齐，共同滚动。图中嵌入的文字保留原样。</p>
        </aside>}
        <main className="bi-main">
          {error && <div className="bi-notice bi-error" role="alert">{error}
            {!document && <button onClick={loadBook}>重试</button>}</div>}
          {!document ? <div className="bi-prepare">
            <h1>把这本书读成两种语言</h1>
            <p>先在本机提取 PDF 的章节和段落，再按章节翻译为中文。英文与中文将在左右两栏一一对应。</p>
            {missing && <><button className="bi-primary" disabled={!!busy} onClick={() => upload()}>
              {busy || "提取本书"}</button>
              <label className="bi-file-label">选择原始 PDF<input type="file" accept="application/pdf,.pdf"
                disabled={!!busy} onChange={(event) => event.target.files?.[0] && upload(event.target.files[0])} /></label></>}
            {!missing && !error && <p role="status">正在读取章节…</p>}
          </div> : <>
            <div className="bi-chapter-toolbar">
              <div><h1>{content?.chapter.title || document.chapters.find((item) => item.id === chapterId)?.title}</h1>
                <p>{content ? `PDF 第 ${content.chapter.start_page}–${content.chapter.end_page} 页` : "正在读取章节…"}
                  <span className="bi-sync-label">段落对齐 · 同步滚动</span></p></div>
              <div className="bi-translation-controls">
                {!task && <select aria-label="翻译模型" value={model} onChange={(event) => setModel(event.target.value)}>
                  {!models.length && <option value="">订阅未连接</option>}
                  {models.map((item) => <option key={item.slug} value={item.slug}>{item.display_name}</option>)}
                </select>}
                {!task && <button className="bi-primary" disabled={!!busy || !content || !model || !connected}
                  onClick={startTranslation}>{busy || "翻译本章"}</button>}
                {running && <button disabled={!!busy} onClick={() => control("pause")}>暂停翻译</button>}
                {resumable && <button className="bi-primary" disabled={!!busy} onClick={() => control("resume")}>继续翻译</button>}
                {task?.status === "completed" && <span className="bi-complete">已翻译并审校</span>}
              </div>
            </div>
            {task && <div className="bi-progress" aria-live="polite">
              <div><span>{TASK_LABELS[task.status] || task.status}</span>
                <span>{task.completed} / {task.total} 段已审校</span></div>
              <progress max={task.total || 1} value={task.completed} aria-label="章节翻译进度" />
              {task.status === "failed" && <small>已保存的段落不会重复翻译。点击“继续翻译”重试。</small>}
              {task.status === "paused_usage_limit" && <a target="_blank" rel="noreferrer"
                href="https://chatgpt.com/settings/usage">管理 ChatGPT 用量</a>}
            </div>}
            <div className="bi-scroll" ref={scroll} onScroll={persistScroll} tabIndex={0}
              aria-label="双栏正文，共用滚动区域" style={{ "--bi-font-size": `${fontSize}px` } as React.CSSProperties}>
              <div className="bi-column-labels"><span>English <small>英文原文</small></span><span>中文 <small>简体译文</small></span></div>
              {!content && <p className="bi-loading" role="status">正在载入正文…</p>}
              <article className="bi-parallel-text" aria-label="逐段英中对照">
                {content?.blocks.map((block) => <div className={`bi-row bi-${block.kind}`} key={block.id}
                  data-block-id={block.id} data-page={block.page}>
                  <div className="bi-cell bi-english" lang="en">
                    <a className="bi-source-page" target="_blank" rel="noreferrer"
                      href={`/api/translation/books/${document.id}/source.pdf#page=${block.page}`}>
                      PDF {block.page}{block.end_page !== block.page ? `–${block.end_page}` : ""}</a>
                    {block.kind === "image" ? <img loading="lazy" alt={`原书第 ${block.page} 页插图`}
                      width={block.anchors[0].bbox[2] - block.anchors[0].bbox[0]}
                      height={block.anchors[0].bbox[3] - block.anchors[0].bbox[1]}
                      src={`/api/translation/books/${document.id}/blocks/${block.id}/image`} />
                      : block.kind === "code" ? <pre><code>{block.text}</code></pre>
                        : block.kind === "heading" ? <h2>{block.text}</h2> : <p>{block.text}</p>}
                  </div>
                  <div className="bi-cell bi-chinese" lang="zh-CN">
                    {block.kind === "image" ? <><span className="bi-row-note">原图 · 图中文字保留原样</span>
                      <img loading="lazy" alt={`第 ${block.page} 页原图，对照阅读`}
                        width={block.anchors[0].bbox[2] - block.anchors[0].bbox[0]}
                        height={block.anchors[0].bbox[3] - block.anchors[0].bbox[1]}
                        src={`/api/translation/books/${document.id}/blocks/${block.id}/image`} /></>
                      : block.kind === "code" ? <><span className="bi-row-note">代码保留原样</span>
                        <pre><code>{block.text}</code></pre></>
                        : block.translation ? <>
                          <span className="bi-row-note">
                            {block.translation.status === "accepted" ? "\u00a0" : block.translation.status === "needs_review" ? "待复核译文" : "初稿 · 等待审校"}</span>
                          {block.kind === "heading" ? <h2>{block.translation.text}</h2> : <p>{block.translation.text}</p>}
                        </> : <><span className="bi-row-note" aria-hidden="true">{"\u00a0"}</span>
                          <p className="bi-pending">{running ? "正在等待本段翻译…" : "本段尚未翻译"}</p></>}
                  </div>
                </div>)}
                {content && !content.blocks.length && <p className="bi-loading">本章没有可提取的正文，请查看原 PDF。</p>}
              </article>
              {content && <footer className="bi-chapter-end">
                <span>本章结束</span>
                {chapterIndex >= 0 && chapterIndex < document.chapters.length - 1 && <button
                  onClick={() => navigate(document.chapters[chapterIndex + 1].id)}>下一章：{document.chapters[chapterIndex + 1].title}</button>}
              </footer>}
            </div>
          </>}
        </main>
      </div>
    </section>
  );
}
