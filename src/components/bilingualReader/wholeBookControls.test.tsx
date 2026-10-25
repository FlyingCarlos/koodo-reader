import React from "react";
import ReactDOM from "react-dom";
import { act } from "react-dom/test-utils";
import { test, expect, jest } from "@jest/globals";
import WholeBookControls from "./wholeBookControls";
import { translationApi } from "./api";
import { PDF_TRANSLATION_UPDATE } from "./events";

jest.mock("./api", () => ({translationApi: require("@jest/globals").jest.fn()}));

test("repairing legacy table formatting invalidates the mounted book without starting whole-book translation", async () => {
  const container = document.createElement("div"); document.body.appendChild(container);
  const changed = jest.fn(); window.addEventListener(PDF_TRANSLATION_UPDATE, changed);
  const task = {id:null,status:"not_started",chapters:[],completed:10,total:10,completed_chapters:1,total_chapters:1,tables:{total:2,completed:1}};
  (translationApi as any).mockResolvedValue(task);
  try {
    await act(async () => { ReactDOM.render(<WholeBookControls book={{key:"reader-key",name:"Book"} as any}
      metadata={{id:"source-id"} as any} models={[]} model="" setModel={() => {}} modelsLoading={false}/>,container); });
    const repair = [...container.querySelectorAll("button")].find(button => button.textContent === "恢复已有译文表格")!;
    expect(repair.disabled).toBe(false);
    await act(async () => { repair.click(); });
    expect((translationApi as any).mock.calls[1][0]).toBe("/books/source-id/tables/repair");
    expect((translationApi as any).mock.calls[1][1].method).toBe("POST");
    expect(changed).toHaveBeenCalledTimes(1);
    expect((changed.mock.calls[0][0] as CustomEvent).detail).toEqual({key:"reader-key"});
    expect(container.textContent).toContain("已译章节表格：1 / 2 页已恢复");
  } finally {
    act(() => { ReactDOM.unmountComponentAtNode(container); }); container.remove();
    window.removeEventListener(PDF_TRANSLATION_UPDATE, changed); jest.clearAllMocks();
  }
});
