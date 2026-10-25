import Book from "../../models/Book";

export const OPEN_BOOK_TRANSLATION = "koodo-open-book-translation";
export function openBookTranslation(book: Book) {
  window.dispatchEvent(new CustomEvent(OPEN_BOOK_TRANSLATION, { detail: book }));
}
