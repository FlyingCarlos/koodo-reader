import React from "react";
import ReactDOM from "react-dom";
import { act } from "react-dom/test-utils";
import { test, expect, jest } from "@jest/globals";
import PdfBackgroundSetting from "./pdfBackgroundSetting";
import { ConfigService } from "../../../assets/lib/kookit-extra-browser.min";

jest.mock("../../../assets/lib/kookit-extra-browser.min",()=>({ConfigService:{getReaderConfig:require("@jest/globals").jest.fn(),setReaderConfig:require("@jest/globals").jest.fn()}}));

test("the setting is accessible, persisted only for its book and reversible on reopen", async()=>{
  const values:Record<string,string>={};
  (ConfigService.getReaderConfig as any).mockImplementation(key=>values[key]);
  (ConfigService.setReaderConfig as any).mockImplementation((key,value)=>{values[key]=value;});
  const container=document.createElement("div"); document.body.appendChild(container);
  const renderBook=jest.fn();
  const show=(key:string)=>ReactDOM.render(<PdfBackgroundSetting key={key} bookKey={key} renderBook={renderBook}/>,container);
  try {
    await act(async()=>{show("cp-sat");});
    const toggle=()=>container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    await act(async()=>{toggle().click();});
    expect(values).toEqual({"pdfHideContentBackground:cp-sat":"yes"}); expect(renderBook).toHaveBeenCalledTimes(1);
    await act(async()=>{show("inference");}); expect(toggle().getAttribute("aria-checked")).toBe("false");
    await act(async()=>{show("cp-sat");}); expect(toggle().getAttribute("aria-checked")).toBe("true");
    await act(async()=>{toggle().click();}); expect(values["pdfHideContentBackground:cp-sat"]).toBe("no");
    expect(container.textContent).toContain("仅当前书");
  } finally { act(()=>{ReactDOM.unmountComponentAtNode(container);});container.remove();jest.clearAllMocks(); }
});
