import { PageFormat, ParallelBlock, SourceCode } from "../../components/bilingualReader/api";
import { renderTranslationSlice } from "./pdfRichText";

export function sourceLiteralRange(text: string, source: string, from=0): [number, number] | null {
  const positions: number[] = []; let normalized = "";
  for (let i=0;i<text.length;i++) if (!/\s/.test(text[i])) {positions.push(i); normalized+=text[i];}
  const needle=source.replace(/\s/g,""); const at=normalized.indexOf(needle,positions.filter(p=>p<from).length);
  return at<0 || !needle ? null : [positions[at],positions[at+needle.length-1]+1];
}

// Added layout whitespace is outside canonical anchors. Old notes retain their
// original UTF-16 offsets even when a formerly flattened code block becomes pre.
export function renderSourceLiteral(doc: Document, block: ParallelBlock, source: string, from=0): HTMLElement {
  const root=doc.createElement("span"), canonical=block.translation?.text || block.text;
  let range=sourceLiteralRange(canonical,source,from);
  if (!range) {root.textContent=source; root.dataset.sourceLiteral=block.id; return root;}
  if(canonical.replace(/\s/g,"")===source.replace(/\s/g,""))range=[0,canonical.length];
  let cursor=range[0];
  const anchored=(start:number,end:number,hidden=false)=>{
    if(end<=start)return;
    const span=doc.createElement("span");span.dataset.translationBlock=block.id;span.dataset.translationStart=String(start);
    span.textContent=canonical.slice(start,end);
    if(hidden){span.className="translation-source-separator";span.hidden=true;}
    root.appendChild(span);
  };
  for(const token of source.match(/\s+|\S+/g)||[]){
    if(/^\s/.test(token)){
      const start=cursor;while(cursor<range[1]&&/\s/.test(canonical[cursor]))cursor++;
      anchored(start,cursor,true);
      const space=doc.createElement("span");space.textContent=token;space.dataset.sourceWhitespace="true";space.setAttribute("aria-hidden","true");root.appendChild(space);
    }else{
      let remaining=token.length;
      while(remaining){
        const before=cursor;while(cursor<range[1]&&/\s/.test(canonical[cursor]))cursor++;
        anchored(before,cursor,true);
        const start=cursor;while(cursor<range[1]&&!/\s/.test(canonical[cursor])&&remaining){cursor++;remaining--;}
        anchored(start,cursor);
      }
    }
  }
  anchored(cursor,range[1],true);
  return root;
}

export function renderSourceCode(doc:Document, region:SourceCode, blocks:ParallelBlock[]):HTMLElement {
  const pre=doc.createElement("pre");pre.className="translation-source-code";
  const code=doc.createElement("code");pre.appendChild(code);
  region.parts.forEach((part,index)=>{
    code.appendChild(doc.createTextNode(part.prefix));
    const block=blocks.find(b=>b.id===part.block_id) || {id:`${region.id}-literal${index}`,text:part.text,translation:null} as ParallelBlock;
    code.appendChild(renderSourceLiteral(doc,block,part.text));
  });
  return pre;
}

export function renderSourceParagraph(doc:Document, block:ParallelBlock, blocks:ParallelBlock[], format?:PageFormat):HTMLElement {
  const result=doc.createElement(block.kind==="heading"?"h2":"p");
  if(!block.translation){result.textContent="本段尚未翻译";result.className="translation-pending";return result;}
  const text=block.translation?.text||"";
  const inserts=(format?.inline_sources||[]).filter(i=>i.owner_id===block.id && !sourceLiteralRange(text,i.text))
    .map(i=>({item:i,at:format?.inline_positions?.[i.id]})).filter(i=>Number.isInteger(i.at)&&i.at!>=0&&i.at!<=text.length)
    .sort((a,b)=>a.at!-b.at!);
  let cursor=0;
  for(const {item,at} of inserts){
    result.appendChild(renderTranslationSlice(doc,block,format?.translated_marks[block.id],cursor,at));
    const source=blocks.find(b=>b.id===item.block_id);
    const literal=doc.createElement("code");literal.className="translation-inline-literal";
    literal.appendChild(source?renderSourceLiteral(doc,source,item.text):doc.createTextNode(item.text));
    result.appendChild(literal);cursor=at!;
  }
  result.appendChild(renderTranslationSlice(doc,block,format?.translated_marks[block.id],cursor,text.length));
  // Before format alignment is ready, keep the formulas visible with this
  // paragraph rather than mixing them with the next page's source code.
  if(!inserts.length){
    for(const item of format?.inline_sources||[]){
      if(item.owner_id!==block.id||sourceLiteralRange(text,item.text))continue;
      const literal=doc.createElement("code");literal.className="translation-inline-literal";
      const source=blocks.find(b=>b.id===item.block_id);
      literal.appendChild(source?renderSourceLiteral(doc,source,item.text):doc.createTextNode(item.text));result.appendChild(literal);
    }
  }
  return result;
}
