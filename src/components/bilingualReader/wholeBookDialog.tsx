import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Book from "../../models/Book";
import TranslationPanel from "./component";
import { OPEN_BOOK_TRANSLATION } from "./events";

function BookDialog({ book, close }: {book: Book; close: () => void}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return createPortal(<dialog ref={dialog} className="whole-book-dialog" aria-labelledby="whole-book-title"
    onCancel={event => { event.preventDefault(); close(); }} onKeyDown={event => event.stopPropagation()}>
    <header><h2 id="whole-book-title">整本翻译</h2><button type="button" onClick={close}>关闭</button></header>
    <p className="whole-book-title">{book.name}</p>
    <TranslationPanel book={book} rendition={null} wholeOnly />
  </dialog>, document.body);
}
export default function WholeBookDialogHost() {
  const [book, setBook] = useState<Book | null>(null);
  useEffect(() => {
    const open = (event: Event) => {
      const value = (event as CustomEvent<Book>).detail;
      if (value?.format === "PDF") setBook(value);
    };
    window.addEventListener(OPEN_BOOK_TRANSLATION, open);
    return () => window.removeEventListener(OPEN_BOOK_TRANSLATION, open);
  }, []);
  return book ? <BookDialog key={book.key} book={book} close={() => setBook(null)} /> : null;
}
