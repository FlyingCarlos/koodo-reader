import React, { useContext } from "react";
import Book from "../../models/Book";
import { openBookTranslation } from "./events";
import { TranslationLibrary } from "./translationLibrary";
import "./translationBadge.css";

export default function TranslationBadge({ book, inline = false }: {book: Book; inline?: boolean}) {
  const status = useContext(TranslationLibrary)[book.key];
  if (book.format !== "PDF" || !status?.completed) return null;
  const label = status.complete ? "已全译" : "有译文";
  const description = `${status.complete ? "整本译文已完成" : "已有部分译文"}，${status.completed}/${status.total} 段已审校。点击查看并导出双语包。`;
  return <button type="button" draggable={false}
    className={`book-translation-badge${status.complete ? " book-translation-badge--complete" : ""}${inline ? " book-translation-badge--inline" : ""}`}
    title={description} aria-label={`${book.name}：${label}，${status.completed}/${status.total} 段已审校。查看并导出双语包。`}
    onMouseDown={event => event.stopPropagation()}
    onClick={event => { event.preventDefault(); event.stopPropagation(); openBookTranslation(book); }}>
    {label}
  </button>;
}
