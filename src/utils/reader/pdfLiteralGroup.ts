import { LiteralGroup, PageFormat, ParallelBlock } from '../../components/bilingualReader/api';
import { renderSourceLiteral, renderSourceParagraph, sourceLiteralRange } from './pdfSourceLayout';

// Model output never supplies formula/code text. All visible content and offsets
// come from the original PDF lines and the unchanged canonical blocks.
export function renderLiteralGroup(doc:Document, group:LiteralGroup, blocks:ParallelBlock[], scale:number, format?:PageFormat):HTMLElement {
  const root=doc.createElement(group.kind==='code'?'pre':'div');
  root.className=`translation-source-${group.kind}`;
  root.setAttribute('aria-label',`${group.kind==='formula'?'公式':group.kind==='code'?'代码':'段落'} · PDF ${group.start_page}–${group.end_page}`);
  const byId=new Map(blocks.map(b=>[b.id,b]));
  if(group.kind==='paragraph'){
    const paragraph=doc.createElement('p');root.appendChild(paragraph);
    Array.from(new Set(group.lines.map(line=>line.block_id))).forEach(id=>{
      const block=id&&byId.get(id);if(block)paragraph.append(...Array.from(renderSourceParagraph(doc,block,blocks,format).childNodes));
    });return root;
  }
  const positions=new Map<string,number>();
  const literal=(line:LiteralGroup['lines'][number])=>{
    const legacy=(format?.source_layout?.code||[]).flatMap(region=>region.parts.map((part,index)=>({part,id:`${region.id}-literal${index}`})))
      .find(({part})=>!part.block_id&&!!sourceLiteralRange(part.text,line.text));
    const block=byId.get(line.block_id||'')||{id:legacy?.id||`source-${line.id}`,text:legacy?.part.text||line.text,translation:null} as ParallelBlock;
    const canonical=block.translation?.text||block.text,from=positions.get(block.id)||0;
    const range=sourceLiteralRange(canonical,line.text,from);
    const node=renderSourceLiteral(doc,block,line.text,from);
    if(range)positions.set(block.id,range[1]);
    return node;
  };
  if(group.kind==='code'){
    const pitch=Math.min(...group.lines.slice(1).map((line,i)=>line.bbox[1]-group.lines[i].bbox[1]).filter(n=>n>1),12);
    const left=Math.min(...group.lines.map(line=>line.bbox[0]));
    group.lines.forEach((line,i)=>{
      if(i)root.appendChild(doc.createTextNode('\n'.repeat(Math.max(1,Math.round((line.bbox[1]-group.lines[i-1].bbox[1])/pitch)))));
      const indent=Math.max(0,Math.round((line.bbox[0]-left)/((line.spans[0]?.size||10)*.6)));
      root.appendChild(doc.createTextNode(' '.repeat(indent)));root.appendChild(literal(line));
    });return root;
  }
  const canvas=doc.createElement('div');canvas.className='translation-formula-lines';
  canvas.style.cssText=`position:relative;width:${(group.bbox[2]-group.bbox[0])*scale}px;height:${(group.bbox[3]-group.bbox[1])*scale}px;margin:0 auto`;
  group.lines.forEach(line=>{
    const row=doc.createElement('div');row.className='translation-formula-line';
    const size=Math.max(...line.spans.map(s=>s.size));
    row.style.cssText=`position:absolute;left:${(line.bbox[0]-group.bbox[0])*scale}px;top:${(line.bbox[1]-group.bbox[1])*scale}px;font-size:${size*scale}px;line-height:1.2;white-space:pre`;
    row.appendChild(literal(line));canvas.appendChild(row);
  });root.appendChild(canvas);return root;
}
