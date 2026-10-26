import React, { useEffect, useRef, useState } from 'react';
import { LayoutTask, translationApi } from './api';

export default function LayoutControls({bookId, page, model, automatic, onApplied}: {
  bookId:string; page:number; model:string; automatic:boolean; onApplied:()=>void;
}) {
  const [task,setTask]=useState<LayoutTask|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const anchor=useRef({bookId,page});anchor.current={bookId,page};
  const applied=useRef(onApplied);applied.current=onApplied;
  const active=!!task && ['queued','running'].includes(task.status);
  useEffect(()=>{
    let cancelled=false;setTask(null);setError('');
    (async()=>{
      try {
        let result=await translationApi<LayoutTask|null>(`/books/${bookId}/layout?page=${page}`);
        if(!result && automatic && model) result=await translationApi<LayoutTask|null>(`/books/${bookId}/layout`,{
          method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({page,model,automatic:true})});
        if(!cancelled)setTask(result);
      }catch(failure){if(!cancelled)setError(failure instanceof Error?failure.message:'无法读取排版识别状态。');}
    })();
    return()=>{cancelled=true;};
  },[bookId,page,model,automatic]);
  useEffect(()=>{
    if(!active)return;
    let cancelled=false;
    const timer=window.setInterval(async()=>{
      try {
        const result=await translationApi<LayoutTask|null>(`/books/${bookId}/layout?page=${page}`);
        if(cancelled)return;
        setTask(result);setError('');
        if(result?.status==='completed')applied.current();
      }catch(failure){if(!cancelled)setError(failure instanceof Error?failure.message:'读取识别进度失败，请重试。');}
    },1800);
    return()=>{cancelled=true;window.clearInterval(timer);};
  },[bookId,page,task?.id,active]);
  const recognize=async()=>{
    setBusy(true);setError('');
    try {
      const result=await translationApi<LayoutTask>(`/books/${bookId}/layout`,{method:'POST',
        headers:{'Content-Type':'application/json'},body:JSON.stringify({page,model})});
      if(anchor.current.bookId===bookId&&anchor.current.page===page)setTask(result);
    }catch(failure){setError(failure instanceof Error?failure.message:'识别未完成，请重试；已有译文仍保留。');}
    finally{setBusy(false);}
  };
  return <div className="pdf-layout-controls">
    <button type="button" disabled={busy||active||!model} onClick={recognize}>
      {busy?'正在提交…':active?'识别中…':'重新识别排版'}
    </button>
    <p className="pdf-translation-hint">从当前页及相邻页检查，按需扩展跨页代码、公式与段落；不重译正文。</p>
    {task && <p role="status" aria-live="polite">{task.status==='queued'
      ? `等待后台处理第 ${task.start_page}–${task.end_page} 页，可继续阅读。`
      : task.message || `正在识别第 ${task.start_page}–${task.end_page} 页的排版。`}</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
