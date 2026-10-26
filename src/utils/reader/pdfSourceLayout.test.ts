import { renderSourceCode, renderSourceLiteral, renderSourceParagraph } from './pdfSourceLayout';
import { paintTranslationNote } from './pdfTranslation';
import { ParallelBlock } from '../../components/bilingualReader/api';
jest.mock('../../assets/lib/kookit-extra-browser.min', () => ({ConfigService:{getReaderConfig:()=> 'no'}}));
const block = (text:string, id='code') => ({id,text,translation:{text},kind:'code'} as ParallelBlock);
function visible(root:HTMLElement) { const copy=root.cloneNode(true) as HTMLElement;copy.querySelectorAll('[hidden]').forEach(n=>n.remove());return copy.textContent; }

test('source code keeps indentation, blank lines and English comments while legacy anchors keep offsets',()=>{
  const canonical='  # Keep this comment value = 4  ';
  const source='# Keep this comment\n\n    value = 4';
  const root=renderSourceLiteral(document,block(canonical),source);
  expect(visible(root)).toBe(source);
  expect(Array.from(root.querySelectorAll('[data-translation-block]')).map(n=>n.textContent).join('')).toBe(canonical);
});

test('code moved from a legacy cross-page block restores notes at nonzero offsets',()=>{
  const canonical='x + y <= 30 30x + 50y model = Model()';
  document.body.innerHTML='<article class="koodo-local-translation"></article>';
  document.querySelector('article')!.appendChild(renderSourceLiteral(document,block(canonical),'model = Model()'));
  const start=canonical.indexOf('model');
  const range={kind:'koodo-pdf-translation-v1',bookId:'book',page:8,parts:[{blockId:'code',start,end:canonical.length,quote:canonical.slice(start)}]};
  paintTranslationNote(document,{key:'old',range:JSON.stringify(range),color:'background-#fff'},'book',()=>{});
  expect(document.querySelector('.koodo-translation-note')?.textContent).toContain('model');
});

test('missing legacy import gets a stable source anchor and comments stay English',()=>{
  const region={id:'p10-code0',bbox:[0,0,1,1],parts:[{block_id:null,prefix:'',text:'from math import sqrt'},{block_id:'code',prefix:'\n\n',text:'# English comment\nvalue = 2'}]};
  const root=renderSourceCode(document,region,[block('中文代码注释')]);
  expect(visible(root)).toBe('from math import sqrt\n\n# English comment\nvalue = 2');
  expect(root.querySelector('[data-translation-block]')?.getAttribute('data-translation-block')).toBe('p10-code0-literal0');
});

test('formula is inserted without rewriting accepted Chinese text',()=>{
  const prose=block('添加约束，得到解：','prose');prose.kind='paragraph';
  const literal=block('x + y <= 30 model = Model()');
  const format:any={translated_marks:{},inline_sources:[{id:'math',block_id:'code',owner_id:'prose',text:'x + y <= 30'}],inline_positions:{math:4}};
  const root=renderSourceParagraph(document,prose,[prose,literal],format);
  expect(visible(root)).toBe('添加约束x + y <= 30，得到解：');
  expect(root.textContent).not.toContain('Model');
});
import { jest, test, expect } from '@jest/globals';
