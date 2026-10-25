import React from "react";
import ReactDOM from "react-dom";
import { act } from "react-dom/test-utils";
import { jest, test, expect, afterEach } from "@jest/globals";
import TranslationBadge from "./translationBadge";
import { TranslationLibrary, TranslationLibraryProvider } from "./translationLibrary";
import { OPEN_BOOK_TRANSLATION } from "./events";
import { translationApi } from "./api";

jest.mock("./api", () => ({translationApi: require("@jest/globals").jest.fn()}));
const container = document.createElement("div");
document.body.appendChild(container);
const book = {key:"book",name:"Test Book",format:"PDF"} as any;
afterEach(() => { act(() => { ReactDOM.unmountComponentAtNode(container); }); jest.clearAllMocks(); jest.useRealTimers(); });

test("badge click opens the correct export dialog without opening or selecting the book", () => {
  const navigate = jest.fn(), opened = jest.fn();
  window.addEventListener(OPEN_BOOK_TRANSLATION, opened);
  act(() => { ReactDOM.render(<TranslationLibrary.Provider value={{book:{completed:2,total:10,complete:false}}}>
    <div onClick={navigate}><TranslationBadge book={book} /></div>
  </TranslationLibrary.Provider>,container); });
  const button = container.querySelector("button")!;
  expect(button.textContent).toBe("有译文");
  expect(button.title).toContain("2/10");
  act(() => { button.click(); });
  expect(opened).toHaveBeenCalledTimes(1);
  expect((opened.mock.calls[0][0] as CustomEvent).detail).toBe(book);
  expect(navigate).not.toHaveBeenCalled();
  window.removeEventListener(OPEN_BOOK_TRANSLATION, opened);
});

test("only the complete state advertises a finished book, and unsupported books have no badge", () => {
  act(() => { ReactDOM.render(<TranslationLibrary.Provider value={{book:{completed:10,total:10,complete:true}}}>
    <TranslationBadge book={book}/><TranslationBadge book={{...book,key:"missing"}}/>
    <TranslationBadge book={{...book,format:"EPUB"}}/>
  </TranslationLibrary.Provider>,container); });
  expect(container.querySelectorAll("button")).toHaveLength(1);
  expect(container.querySelector("button")!.textContent).toBe("已全译");
});

test("bookshelf shares one status request and updates badges as translation completes", async () => {
  jest.useFakeTimers();
  (translationApi as any).mockResolvedValueOnce({book:{completed:2,total:10,complete:false}})
    .mockResolvedValueOnce({book:{completed:10,total:10,complete:true}});
  await act(async () => { ReactDOM.render(<TranslationLibraryProvider>
    <TranslationBadge book={book}/><TranslationBadge book={book}/><TranslationBadge book={book}/>
  </TranslationLibraryProvider>,container); });
  expect(translationApi).toHaveBeenCalledTimes(1);
  expect((translationApi as any).mock.calls[0][0]).toBe("/library");
  expect(container.querySelector("button")!.textContent).toBe("有译文");
  await act(async () => { jest.advanceTimersByTime(10000); });
  expect(translationApi).toHaveBeenCalledTimes(2);
  expect(container.querySelector("button")!.textContent).toBe("已全译");
});
