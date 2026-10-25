import React from "react";
import ReactDOM from "react-dom";
import { act, Simulate } from "react-dom/test-utils";
import { test, expect, jest } from "@jest/globals";
import ProgressPanel from "./component";

jest.mock("../../../assets/lib/kookit-extra-browser.min", () => ({ ConfigService: {
  getReaderConfig: () => "scroll", getObjectConfig: () => ({}), setObjectConfig: () => {},
} }));
jest.mock("../../../utils/common", () => ({ isReadingRawPDF: () => true, scrollContents: () => {} }));
jest.mock("react-i18next", () => ({ Trans: ({ children }) => children }));

function fakeBook(currentPage: number) {
  const listeners: Record<string, (() => Promise<void>)[]> = {};
  const rendition = {
    on: (event, callback) => { (listeners[event] ||= []).push(callback); },
    getProgress: async () => ({ currentPage, totalPage: 259 }),
    getPosition: () => ({ chapterHref: `page-${currentPage}`, chapterTitle: "Chapter" }),
    goToPage: jest.fn(async (value: number) => {
      currentPage = value;
      for (const callback of listeners["page-changed"] || []) await callback();
    }),
  };
  return { key: "book", rendition, flattenChapters: [], listeners };
}

test("native page control rebinds when the PDF instance changes, ignores old callbacks and clears a submitted page", async () => {
  const container = document.createElement("div"); document.body.appendChild(container);
  const first = fakeBook(19), second = fakeBook(32);
  const render = (htmlBook) => ReactDOM.render(<ProgressPanel {...({
    htmlBook, currentBook: { key: "book", format: "PDF" }, percentage: 0,
    handleCurrentChapter: () => {}, handleFetchPercentage: () => {},
  } as any)} />, container);
  await act(async () => { render(null); });
  await act(async () => { render(first); });
  expect(container.querySelector<HTMLInputElement>("#jumpPage")!.value).toBe("19");
  await act(async () => { render(second); });
  expect(container.querySelector<HTMLInputElement>("#jumpPage")!.value).toBe("32");
  await act(async () => { for (const callback of first.listeners["page-changed"]) await callback(); });
  expect(container.querySelector<HTMLInputElement>("#jumpPage")!.value).toBe("32");
  const input = container.querySelector<HTMLInputElement>("#jumpPage")!;
  await act(async () => { Simulate.change(input, { target: { value: "20" } } as any); });
  await act(async () => { Simulate.blur(input, { target: { value: "20" } } as any); });
  expect(second.rendition.goToPage).toHaveBeenCalledWith(20);
  expect(input.value).toBe("20");
  await act(async () => { render(null); for (const callback of second.listeners.rendered) await callback(); });
  act(() => { ReactDOM.unmountComponentAtNode(container); }); container.remove();
});
