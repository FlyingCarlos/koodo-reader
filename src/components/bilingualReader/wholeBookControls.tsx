import React, { useEffect, useState } from "react";
import Book from "../../models/Book";
import { BookTranslation, TranslationBook, translationApi } from "./api";
import { PDF_TRANSLATION_UPDATE } from "./events";

const LABELS: Record<string, string> = {
  not_started: "尚未开始整本翻译", queued: "等待整本翻译", running: "正在翻译整本书",
  completed: "整本翻译完成", paused: "整本翻译已暂停", failed: "翻译中断，已有译文已保存",
  paused_usage_limit: "订阅额度已达上限，已有译文已保存", needs_review: "有译文待复核，整本任务已停止推进",
};
export default function WholeBookControls({ book, metadata, models, model, setModel, modelsLoading }: {
  book: Book; metadata: TranslationBook;
  models: {slug: string; display_name: string}[]; modelsLoading: boolean; model: string; setModel: (value: string) => void;
}) {
  const [task, setTask] = useState<BookTranslation | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const update = async () => {
      try {
        const value = await translationApi<BookTranslation>(`/books/${metadata.id}/whole`);
        if (!cancelled) { setTask(value); setError(""); }
      } catch (failure) { if (!cancelled) setError(failure instanceof Error ? failure.message : "读取任务失败。"); }
      if (!cancelled) timer = setTimeout(update, 4000);
    };
    void update();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [metadata.id]);
  const action = async (command: "start" | "pause" | "resume" | "tables") => {
    setBusy(command === "tables" ? "正在提交表格恢复…" : "正在更新整本任务…"); setError("");
    try {
      setTask(await translationApi<BookTranslation>(command === "tables" ? `/books/${metadata.id}/tables/repair` : `/books/${metadata.id}/whole${command === "start" ? "" : `/${command}`}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: command === "start" ? JSON.stringify({ model }) : undefined,
      }));
      window.dispatchEvent(new CustomEvent(PDF_TRANSLATION_UPDATE, { detail: { key: book.key } }));
    } catch (failure) { setError(failure instanceof Error ? failure.message : "任务更新失败。"); }
    finally { setBusy(""); }
  };
  const download = async () => {
    setBusy("正在生成双语包…"); setError("");
    try {
      const response = await fetch(`/api/translation/books/${metadata.id}/export`, { method: "POST", headers: { "X-Koodo-Translation": "1" } });
      if (!response.ok) throw new Error((await response.json()).error || "导出失败，请重试。");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a"); link.href = url;
      link.download = `${book.name.replace(/[\\/:*?"<>|]/g, "_")}.koodo.zip`;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "导出失败。"); }
    finally { setBusy(""); }
  };
  const active = task && ["queued", "running"].includes(task.status);
  return <div className="whole-book-controls">
    <p>按目录顺序翻译全书，复用已有译文，仅补齐未完成的章节。关闭窗口后后台继续执行。</p>
    {!task?.id && <label className="whole-book-model">新章节使用的模型
      <select value={model} onChange={event => setModel(event.target.value)} disabled={!!busy}>
        {!models.length && <option value="">{modelsLoading ? "正在读取可用模型…" : "订阅未连接"}</option>}
        {models.map(item => <option key={item.slug} value={item.slug}>{item.display_name}</option>)}
      </select>
    </label>}
    {task ? <>
      <p role="status">{LABELS[task.status] || task.status}</p>
      {task.current_chapter && <p>当前章节：{task.chapters.find(chapter => chapter.id === task.current_chapter)?.title}</p>}
      <p>{task.completed_chapters} / {task.total_chapters} 章已完成 · {task.completed} / {task.total} 段已审校</p>
      {!!task.tables?.total && <p role="status">已译章节表格：{task.tables.completed} / {task.tables.total} 页已恢复</p>}
      <progress aria-label="整本翻译进度" max={task.total || 1} value={task.completed} />
      <div className="whole-book-actions">
        {!task.id && <button disabled={!!busy || !model || !task.total} onClick={() => action("start")}>开始整本翻译</button>}
        {active && <button disabled={!!busy} onClick={() => action("pause")}>暂停整本翻译</button>}
        {["paused", "failed", "paused_usage_limit"].includes(task.status) && <button disabled={!!busy} onClick={() => action("resume")}>继续整本翻译</button>}
        {task.tables && task.tables.completed < task.tables.total && <button disabled={!!busy || !!active} onClick={() => action("tables")}>恢复已有译文表格</button>}
        <button disabled={!!busy} onClick={download}>导出双语包{task.status === "completed" ? "" : "（当前进度）"}</button>
      </div>
      <details className="whole-book-chapters"><summary>查看章节进度</summary><ol>
        {task.chapters.map(chapter => <li key={chapter.id}><span>{chapter.title}</span><span>{chapter.completed} / {chapter.total}</span></li>)}
      </ol></details>
    </> : <p role="status">正在读取整本任务…</p>}
    {busy && <p role="status">{busy}</p>}
    {error && <p role="alert">{error}</p>}
    <p className="pdf-translation-hint">双语包包含原 PDF、原封面、译文及格式和段落定位信息。书架保留原书；笔记和高亮仍由原阅读器管理，请通过原有备份功能保存。新章节翻译后自动恢复表格；旧译文可点击“恢复已有译文表格”。此操作复用正文，可能使用订阅模型对齐单元格；导出不会调用模型。</p>
  </div>;
}
