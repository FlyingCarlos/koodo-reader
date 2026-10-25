import { jest, test, expect, afterEach } from "@jest/globals";
import { ParallelBlock, PageFormat, FormatTable } from "../../components/bilingualReader/api";
import { renderTranslationSlice, renderTranslationTable } from "./pdfRichText";
import { captureTranslationRange, paintTranslationNote, clearTranslationMarks } from "./pdfTranslation";

jest.mock("../../assets/lib/kookit-extra-browser.min", () => ({ ConfigService: { getReaderConfig: require("@jest/globals").jest.fn(() => "no") } }));
jest.mock("../../components/bilingualReader/api", () => ({ translationApi: require("@jest/globals").jest.fn() }));
const block = (id: string, text: string) => ({id, translation: {text, status: "accepted"}} as ParallelBlock);
afterEach(() => { document.getSelection()?.removeAllRanges(); document.body.replaceChildren(); });

test("rich text preserves exact canonical UTF-16 text with safe semantic wrappers", () => {
  const text = '😀延迟 x <script>alert(1)</script>';
  const root = renderTranslationSlice(document, block("body", text), [
    {kind:"bold",start:2,end:4}, {kind:"italic",start:2,end:4}, {kind:"code",start:5,end:6},
    {kind:"serif",start:7,end:text.length},
  ]);
  expect(root.textContent).toBe(text);
  expect(root.querySelector("strong em")!.textContent).toBe("延迟");
  expect(root.querySelector("code")!.textContent).toBe("x");
  expect(root.querySelector(".translation-serif")!.textContent).toContain("<script>");
  expect(root.querySelector("script")).toBeNull();
});

const table: FormatTable = {id:"table",bbox:[0,0,400,100],rows:2,columns:2,cells:[
  {id:"a",row:0,column:0,rowspan:1,colspan:1,header:true,block_ids:["header"]},
  {id:"b",row:0,column:1,rowspan:1,colspan:1,header:true,block_ids:["header"]},
  {id:"c",row:1,column:0,rowspan:1,colspan:2,header:false,block_ids:["body"]},
]};
const blocks = [block("header","优点 缺点"),block("body","😀使用 x")];
const format = (): PageFormat => ({version:1,status:"ready",body_font_size:9,paragraph_groups:[],tables:[table],
  translated_marks:{body:[{kind:"code",start:5,end:6}]},translated_cells:{
    a:[{block_id:"header",start:0,end:3}], b:[{block_id:"header",start:3,end:5}],
    c:[{block_id:"body",start:0,end:6}],
  }});

test("tables preserve cells, merged spans and old notes across a formerly flattened header", () => {
  const article = document.createElement("article"); article.className="koodo-local-translation";
  article.appendChild(renderTranslationTable(document,table,format(),blocks)!);document.body.appendChild(article);
  expect(article.querySelectorAll("tr")).toHaveLength(2);
  expect(article.querySelectorAll("th")).toHaveLength(2);
  expect(article.querySelector("td")!.colSpan).toBe(2);
  const note = {key:"legacy",color:"background-#FEF3CD",range:JSON.stringify({kind:"koodo-pdf-translation-v1",
    bookId:"book",page:28,parts:[{blockId:"header",start:0,end:5,quote:"优点 缺点"}]})};
  paintTranslationNote(document,note,"book",jest.fn());
  expect(Array.from(article.querySelectorAll(".koodo-translation-note")).map(m=>m.textContent).join("")).toBe("优点 缺点");
  clearTranslationMarks(document);
  const right = article.querySelectorAll('[data-translation-block="header"]')[1];
  const range=document.createRange();range.selectNodeContents(right);
  document.getSelection()!.addRange(range);
  expect(captureTranslationRange(document,28,"book")!.parts).toEqual([{blockId:"header",start:3,end:5,quote:"缺点"}]);
  document.getSelection()!.removeAllRanges();
  paintTranslationNote(document,{...note,key:"code",range:JSON.stringify({kind:"koodo-pdf-translation-v1",
    bookId:"book",page:28,parts:[{blockId:"body",start:5,end:6,quote:"x"}]})},"book",jest.fn());
  expect(article.querySelector("code .koodo-translation-note")?.textContent || article.querySelector(".koodo-translation-note code")?.textContent).toBe("x");
  clearTranslationMarks(document);expect(article.querySelector("code")!.textContent).toBe("x");
});

test("invalid or incomplete table fragments fall back instead of hiding existing translated text", () => {
  const incomplete=format();incomplete.translated_cells.b=[];
  expect(renderTranslationTable(document,table,incomplete,blocks)).toBeNull();
  const overlap=format();overlap.translated_cells.b=[{block_id:"header",start:0,end:5}];
  expect(renderTranslationTable(document,table,overlap,blocks)).toBeNull();
});
