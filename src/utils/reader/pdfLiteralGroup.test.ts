import {test,expect,jest} from '@jest/globals';
import {renderLiteralGroup} from './pdfLiteralGroup';
import {paintTranslationNote} from './pdfTranslation';
import {LiteralGroup,ParallelBlock} from '../../components/bilingualReader/api';
jest.mock('../../assets/lib/kookit-extra-browser.min',()=>({ConfigService:{getReaderConfig:()=> 'no'}}));
function visible(node:HTMLElement){const copy=node.cloneNode(true) as HTMLElement;copy.querySelectorAll('[hidden]').forEach(n=>n.remove());return copy.textContent;}
const lines=['max 30x + 50y','s.t. x + y ≤ 30','0 ≤ x ≤ 100','0 ≤ y ≤ 100','x,y ∈ ℤ'];
const blocks=lines.map((text,i)=>({id:String(i),text,translation:{text},page:11,kind:'code',anchors:[]} as unknown as ParallelBlock));
const group={id:'formula',kind:'formula',bbox:[260,300,350,408],start_page:11,end_page:11,
 lines:lines.map((text,i)=>({id:`line${i}`,text,block_id:String(i),page:11,bbox:[260,300+i*24,350,312+i*24],spans:[{text,size:12,font:'Type3',flags:0,bbox:[]}]}))} as LiteralGroup;

test('mathematical constraints stay on five separate rows with stable old note anchors',()=>{
 document.body.innerHTML='<article class="koodo-local-translation"></article>';
 const root=renderLiteralGroup(document,group,blocks,1.5);document.querySelector('article')!.appendChild(root);
 expect(root.querySelectorAll('.translation-formula-line')).toHaveLength(5);
 expect(visible(root)).toBe(lines.join(''));
 expect((root.querySelectorAll('.translation-formula-line')[1] as HTMLElement).style.top).toBe('36px');
 const note={key:'old',color:'background-#fff',range:JSON.stringify({kind:'koodo-pdf-translation-v1',bookId:'book',page:10,
 parts:[{blockId:'2',start:0,end:1,quote:'0'}]})};
 paintTranslationNote(document,note,'book',()=>{});
 expect(root.querySelector('.koodo-translation-note')?.textContent).toBe('0');
});

test('cross-page fragment shows only source lines from its physical page',()=>{
 const fragment={...group,start_page:10,end_page:12,lines:[group.lines[2]]};
 const root=renderLiteralGroup(document,fragment,blocks,1);
 expect(visible(root)).toBe(lines[2]);
 expect(root.getAttribute('aria-label')).toContain('10–12');
});
