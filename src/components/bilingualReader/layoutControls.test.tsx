import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {jest,test,expect} from '@jest/globals';
import LayoutControls from './layoutControls';
import {translationApi} from './api';
jest.mock('./api',()=>({translationApi:require('@jest/globals').jest.fn()}));

test('manual recognition captures the page, displays expanded range and refreshes after completion',async()=>{
 jest.useFakeTimers();
 const host=document.createElement('div');document.body.appendChild(host);const root=createRoot(host);
 const notify=jest.fn();let state:any=null;
 (translationApi as any).mockImplementation(async(path:string,options?:RequestInit)=>{
  if(options?.method==='POST'){
   expect(JSON.parse(String(options.body))).toEqual({page:11,model:'original-model'});
   state={id:1,status:'queued',anchor_page:11,start_page:10,end_page:12,message:''};
  }
  return state;
 });
 try{
  await act(async()=>root.render(<LayoutControls bookId="book" page={11} model="original-model" automatic={false} onApplied={notify}/>));
  await act(async()=>host.querySelector<HTMLButtonElement>('button')!.click());
  expect(host.textContent).toContain('10–12');
  state={...state,status:'running',start_page:8,end_page:14,message:'正在识别第 8–14 页的排版。'};
  await act(async()=>jest.advanceTimersByTime(1800));
  expect(host.textContent).toContain('8–14');
  state={...state,status:'completed',message:'已识别第 8–14 页'};
  await act(async()=>jest.advanceTimersByTime(1800));
  expect(notify).toHaveBeenCalledTimes(1);
  expect(host.querySelector<HTMLButtonElement>('button')!.disabled).toBe(false);
 }finally{await act(async()=>root.unmount());host.remove();jest.useRealTimers();jest.clearAllMocks();}
});
