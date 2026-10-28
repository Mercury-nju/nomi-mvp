import { useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { ChevronDown, Hand, LoaderCircle, MousePointer2, RefreshCw, Scan } from 'lucide-react';
import { api } from './api';

interface Observation {
  observationId: string; screenshotUrl: string; width: number; height: number;
  title?: string; url?: string; challenge: boolean; availableActions: string[]; message?: string;
}
interface Point { x: number; y: number }

function screenshotUrl(value?: string) {
  return value?.startsWith('/api/') && !value.includes('..') && !value.includes('\\') ? value : undefined;
}

export default function BrowserAssist() {
  const [open, setOpen] = useState(false);
  const [observation, setObservation] = useState<Observation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [imageLoaded, setImageLoaded] = useState(false);
  const [mode, setMode] = useState<'click'|'drag'>('click');
  const [gesture, setGesture] = useState<{from: Point; to: Point} | null>(null);
  const gestureRef = useRef<{point: Point; pointerId: number; observationId: string} | null>(null);
  const image = useRef<HTMLImageElement>(null);
  const imageUrl = screenshotUrl(observation?.screenshotUrl);
  const allowed = imageLoaded && !!observation?.challenge && !!observation.availableActions?.includes(mode) && !busy;

  async function observe() {
    setBusy(true); setError(''); setImageLoaded(false); setGesture(null); gestureRef.current = null;
    try { setObservation(await api<Observation>('/browser/observation')); }
    catch (err) { setError(err instanceof Error ? err.message : '暂时无法查看页面，请先打开抖音窗口。'); }
    finally { setBusy(false); }
  }
  function point(event: PointerEvent<HTMLImageElement>): Point | null {
    if (!observation || !image.current) return null;
    const bounds = image.current.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return null;
    return { x: Math.max(0,Math.min(observation.width - 1,Math.round((event.clientX - bounds.left) * observation.width / bounds.width))),
      y: Math.max(0,Math.min(observation.height - 1,Math.round((event.clientY - bounds.top) * observation.height / bounds.height))) };
  }
  function down(event: PointerEvent<HTMLImageElement>) {
    if (!allowed || !observation || event.button !== 0) return;
    const start = point(event); if (!start) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    gestureRef.current = {point:start,pointerId:event.pointerId,observationId:observation.observationId};
    setGesture({from:start,to:start});
  }
  function move(event: PointerEvent<HTMLImageElement>) {
    const start = gestureRef.current;
    if (!start || start.pointerId !== event.pointerId || mode !== 'drag') return;
    const end = point(event); if (end) setGesture({from:start.point,to:end});
  }
  async function up(event: PointerEvent<HTMLImageElement>) {
    const start = gestureRef.current;
    if (!start || start.pointerId !== event.pointerId || !allowed) return;
    const end = point(event); gestureRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!end || (mode === 'drag' && Math.hypot(end.x-start.point.x,end.y-start.point.y)<3)) {setGesture(null);return;}
    setBusy(true); setError('');
    try {
      const result = await api<Observation>('/browser/action','POST',{observationId:start.observationId,action:mode,x:start.point.x,y:start.point.y,...(mode==='drag'?{toX:end.x,toY:end.y}:{})});
      setImageLoaded(false); setObservation(result);
    } catch (err) { setError(err instanceof Error ? err.message : '页面操作未完成，请重新查看页面后再试。'); }
    finally { setBusy(false);setGesture(null); }
  }
  return <section className="ag-panel ag-browser-assist">
    <button className="ag-browser-toggle" onClick={()=>setOpen(value=>!value)} aria-expanded={open}><Scan size={18}/><span>页面处理<small>查看当前页面，处理需要交互的验证</small></span><ChevronDown size={16} className={open?'expanded':''}/></button>
    {open && <div className="ag-browser-content">
      <div className="ag-browser-controls"><button className="ag-button secondary" disabled={busy} onClick={()=>void observe()}>{busy?<LoaderCircle size={14} className="ag-spin"/>:<RefreshCw size={14}/>} {observation?'重新查看页面':'查看当前验证页面'}</button>{observation && <span className={`ag-badge ${observation.challenge?'ag-unknown':'ag-completed'}`}>{observation.challenge?'需要处理页面验证':'当前没有可操作的验证'}</span>}</div>
      {error && <p className="ag-local-error" role="alert">{error}</p>}
      {observation && <>
        <div className="ag-browser-caption"><strong>{observation.title || '当前浏览器页面'}</strong><span>{observation.message || (observation.challenge?'选择点击或拖动，在下方页面中操作。':'可以返回任务中心继续查看执行状态。')}</span></div>
        {observation.challenge && <div className="ag-browser-modes" role="group" aria-label="页面操作方式"><button className={mode==='click'?'selected':''} disabled={busy||!observation.availableActions?.includes('click')} onClick={()=>setMode('click')}><MousePointer2 size={14}/>点击</button><button className={mode==='drag'?'selected':''} disabled={busy||!observation.availableActions?.includes('drag')} onClick={()=>setMode('drag')}><Hand size={14}/>拖动</button><small>{mode==='drag'?'按住起点，拖至目标位置后松开。':'点击页面中需要选择的位置。'}</small></div>}
        {imageUrl ? <div className={`ag-browser-image ${allowed?'interactive':''} ${busy?'busy':''}`}>
          <img ref={image} key={observation.observationId} src={imageUrl} alt="当前抖音页面验证截图" draggable={false} onPointerDown={down} onPointerMove={move} onPointerUp={event=>void up(event)} onPointerCancel={()=>{gestureRef.current=null;setGesture(null);}} onLoad={()=>setImageLoaded(true)} onError={()=>{setImageLoaded(false);setError('页面截图暂时无法显示，请重新查看页面。');}} style={{touchAction:allowed?'none':'auto'}}/>
          {gesture && observation && <svg className="ag-browser-gesture" viewBox={`0 0 ${observation.width} ${observation.height}`} preserveAspectRatio="none" aria-hidden="true"><line x1={gesture.from.x} y1={gesture.from.y} x2={gesture.to.x} y2={gesture.to.y}/><circle cx={gesture.from.x} cy={gesture.from.y} r={7}/><circle cx={gesture.to.x} cy={gesture.to.y} r={7}/></svg>}
          {busy&&<div className="ag-browser-wait"><LoaderCircle size={24} className="ag-spin"/><span>正在处理页面…</span></div>}
        </div> : <p className="ag-note">当前没有可显示的页面截图，请重新查看。</p>}
        <p className="ag-note ag-browser-footnote">每次操作后会更新页面。截图过期时请重新查看；此处只处理页面验证。</p>
      </>}
      {!observation && !error && <p className="ag-note">先打开抖音浏览器。出现页面验证时，可以在这里查看并操作。</p>}
    </div>}
  </section>;
}
