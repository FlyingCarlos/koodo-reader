import { FormatTable, PageFormat, ParallelBlock, TextMark, TocEntry } from "../../components/bilingualReader/api";

// UTF-16 offsets and exact text stay authoritative, including old plain-text notes.
// No model-provided HTML, whitespace, bullet or Markdown is inserted into a block.
export function renderTranslationSlice(doc: Document, block: ParallelBlock, marks: TextMark[] = [], start = 0,
  end = block.translation?.text.length || 0): HTMLElement {
  const root = doc.createElement("span"), text = block.translation?.text || "";
  root.dataset.translationBlock = block.id;
  root.dataset.translationStart = String(start);
  const valid = marks.filter(m => Number.isInteger(m.start) && Number.isInteger(m.end)
    && m.start >= 0 && m.end <= text.length && m.start < m.end && m.start < end && m.end > start);
  const boundaries = Array.from(new Set([start, end, ...valid.flatMap(m => [Math.max(start, m.start), Math.min(end, m.end)])])).sort((a,b) => a-b);
  boundaries.slice(0, -1).forEach((at, i) => {
    let node: Node = doc.createTextNode(text.slice(at, boundaries[i + 1]));
    for (const kind of ["code", "serif", "italic", "bold"]) {
      if (!valid.some(m => m.kind === kind && m.start <= at && m.end >= boundaries[i + 1])) continue;
      const tag = kind === "bold" ? "strong" : kind === "italic" ? "em" : kind === "code" ? "code" : "span";
      const wrapper = doc.createElement(tag);
      if (kind === "serif") wrapper.className = "translation-serif";
      wrapper.appendChild(node); node = wrapper;
    }
    root.appendChild(node);
  });
  return root;
}

export function translationFragments(doc: Document, blockId: string): HTMLElement[] {
  return Array.from(doc.querySelectorAll<HTMLElement>("[data-translation-block]"))
    .filter(el => el.dataset.translationBlock === blockId)
    .sort((a,b) => Number(a.dataset.translationStart || 0) - Number(b.dataset.translationStart || 0));
}

export function renderTranslationToc(doc: Document, block: ParallelBlock, entry: TocEntry,
  marks: TextMark[] = []): HTMLElement | null {
  const text = block.translation?.text;
  if (!text) return null;
  // Old translations contain literal leader dots; new compact batches keep a
  // protected tab/page suffix. Retain all text and UTF-16 offsets in either form.
  const suffix = /([.．·…‥\s]+)(\d+|[ivxlcdmIVXLCDM]+)\s*$/.exec(text);
  if (!suffix || suffix[2] !== entry.page_label || !text.slice(0, suffix.index).trim()) return null;
  const pageStart = suffix.index + suffix[1].length;
  const row = doc.createElement("div"); row.className = "translation-toc-row";
  row.setAttribute("role", "listitem");
  if (entry.bold) row.style.fontWeight = "700";
  const title = renderTranslationSlice(doc, block, marks, 0, suffix.index);
  title.className = "translation-toc-title";
  const leader = renderTranslationSlice(doc, block, marks, suffix.index, pageStart);
  leader.className = "translation-toc-leader"; leader.setAttribute("aria-hidden", "true");
  const page = renderTranslationSlice(doc, block, marks, pageStart, text.length);
  page.className = "translation-toc-page";
  if (entry.page_bold) page.style.fontWeight = "700";
  row.append(title, leader, page);
  return row;
}

export function renderTranslationTable(doc: Document, table: FormatTable, format: PageFormat,
  blocks: ParallelBlock[]): HTMLElement | null {
  const byId = new Map(blocks.map(b => [b.id, b]));
  const covered = new Map<string, {start: number; end: number}[]>();
  for (const cell of table.cells) {
    const parts = format.translated_cells[cell.id];
    if (!parts) return null;
    for (const part of parts) {
      const text = byId.get(part.block_id)?.translation?.text;
      if (text === undefined || !cell.block_ids.includes(part.block_id) || !Number.isInteger(part.start)
        || !Number.isInteger(part.end) || part.start < 0 || part.end > text.length || part.end <= part.start) return null;
      covered.set(part.block_id, [...(covered.get(part.block_id) || []), part]);
    }
  }
  const expected = new Set(table.cells.flatMap(c => c.block_ids));
  if (expected.size !== covered.size) return null;
  for (const id of Array.from(expected)) {
    const parts = covered.get(id)?.sort((a,b) => a.start-b.start);
    if (!parts || parts[0].start !== 0 || parts[parts.length-1].end !== byId.get(id)?.translation?.text.length
      || parts.some((p,i) => i > 0 && p.start !== parts[i-1].end)) return null;
  }
  const result = doc.createElement("table");
  result.className = "translation-table";
  const body = doc.createElement("tbody"); result.appendChild(body);
  for (let row = 0; row < table.rows; row++) {
    const tr = doc.createElement("tr"); body.appendChild(tr);
    for (const cell of table.cells.filter(c => c.row === row).sort((a,b) => a.column-b.column)) {
      const td = doc.createElement(cell.header ? "th" : "td");
      td.rowSpan = cell.rowspan; td.colSpan = cell.colspan;
      if (cell.header) td.setAttribute("scope", row === 0 ? "col" : "row");
      for (const part of format.translated_cells[cell.id]) td.appendChild(renderTranslationSlice(doc,
        byId.get(part.block_id)!, format.translated_marks[part.block_id], part.start, part.end));
      tr.appendChild(td);
    }
  }
  return result;
}
