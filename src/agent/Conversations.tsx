import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, CircleAlert, ExternalLink, Hand, LoaderCircle, MessageSquare, Plus, RefreshCw, Send } from 'lucide-react';
import { api, externalUrl } from './api';
import type { Customer } from './types';
import './conversations.css';

type Mode = 'suggest' | 'auto' | 'human' | 'paused';
interface Conversation { id: string; customerId: string; nickname: string; profileUrl?: string; mode: Mode; revision: number; baselineEstablished: boolean; lastSyncAt?: string; reason?: string; pendingCount?: number; updatedAt?: string; stage?: string }
interface Message { id: string; direction: string; text: string; type?: string; at?: string; observedAt?: string; baseline?: boolean; status?: string; reason?: string; evidencePath?: string }
interface Suggestion { text: string; action?: string; reason?: string; revision: number }
interface Detail extends Conversation { messages: Message[]; suggestion?: Suggestion | null; outbox: Message[] }
interface Monitor { enabled: boolean; intervalSeconds: number; reason?: string }
const modes: Record<Mode, string> = { suggest: '建议回复', auto: '自动承接', human: '人工接管', paused: '已暂停' };
const stages: Record<string, string> = { new: '初次回应', greeting: '初次回应', discovery: '了解需求', needs: '了解需求', handoff: '待人工', closed: '已结束', active: '沟通中', waiting: '等待回复' };
const statuses: Record<string, string> = { queued: '等待发送', sending: '发送中', success: '页面显示已发送', confirmed: '页面显示已发送', failed: '发送失败', unknown: '结果未知，请核查，勿重复发送', cancelled: '已取消', stale: '会话已更新，未发送', received: '收到消息', resolved: '人工核查已记录' };
function time(value?: string) { return value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '尚未同步'; }
function evidence(value?: string) { const path = value?.startsWith('evidence/') ? `/api/${value}` : value; return path?.startsWith('/api/evidence/') && !path.includes('..') ? path : undefined; }

export default function Conversations({ customers, online }: { customers: Customer[]; online: boolean }) {
  const [list, setList] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState('');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [monitor, setMonitor] = useState<Monitor>({ enabled: false, intervalSeconds: 10 });
  const [customerId, setCustomerId] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [text, setText] = useState('');
  const [draftRevision, setDraftRevision] = useState<number | null>(null);
  const [sendAuthorized, setSendAuthorized] = useState(false);
  const [autoAuthorized, setAutoAuthorized] = useState(false);
  const [resolutionAuthorized, setResolutionAuthorized] = useState<Record<string, boolean>>({});
  const selectedRef = useRef('');
  const revisionRef = useRef<number | null>(null);
  const requestRef = useRef<{ id: string; text: string; revision: number } | null>(null);
  const live = useRef(true);
  const polling = useRef(false);
  const clearDraft = useCallback(() => { setText(''); setDraftRevision(null); setSendAuthorized(false); requestRef.current = null; }, []);
  const applyDetail = useCallback((value: Detail) => {
    if (!live.current || selectedRef.current !== value.id) return;
    if (revisionRef.current !== null && revisionRef.current !== value.revision) {
      clearDraft(); setNotice('会话已更新，旧草稿已清空，请根据最新消息重新回复。');
    }
    revisionRef.current = value.revision; setDetail(value);
  }, [clearDraft]);
  const refresh = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    try {
      const [items, settings] = await Promise.all([api<Conversation[]>('/conversations'), api<Monitor>('/conversation-monitor')]);
      if (!live.current) return;
      setList(items); setMonitor(settings);
      const id = selectedRef.current;
      if (id) applyDetail(await api<Detail>(`/conversations/${id}`));
    } catch (err) { if (live.current) setError(err instanceof Error ? err.message : '会话读取失败'); }
    finally { polling.current = false; }
  }, [applyDetail]);
  useEffect(() => { live.current = true; void refresh(); const timer = setInterval(() => void refresh(), 4000); return () => { live.current = false; clearInterval(timer); }; }, [refresh]);
  async function select(id: string) {
    selectedRef.current = id; revisionRef.current = null; setSelected(id); setDetail(null); clearDraft(); setAutoAuthorized(false); setResolutionAuthorized({}); setError(''); setNotice('');
    try { applyDetail(await api<Detail>(`/conversations/${id}`)); } catch (err) { setError(err instanceof Error ? err.message : '会话读取失败'); }
  }
  async function act(key: string, fn: () => Promise<void>) {
    if (busy && key !== 'human') return;
    setBusy(key); setError(''); setNotice('');
    try { await fn(); await refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : '操作失败，请检查执行服务'); }
    finally { setBusy(current => current === key ? '' : current); }
  }
  async function configure(mode: Mode) {
    if (!selected || (mode === 'auto' && !autoAuthorized)) return;
    await act(mode, async () => {
      applyDetail(await api<Detail>(`/conversations/${selected}`, 'PUT', { mode, authorized: mode === 'auto' && autoAuthorized }));
      clearDraft(); setAutoAuthorized(false); setNotice(mode === 'human' ? '已接管该会话，未发送的自动回复将停止。' : `会话已切换为${modes[mode]}。`);
    });
  }
  const untracked = customers.filter(customer => !list.some(item => item.customerId === customer.id));
  const stale = !!detail && draftRevision !== null && draftRevision !== detail.revision;
  const canSend = online && !!detail && !!text.trim() && sendAuthorized && !stale && draftRevision === detail.revision && !busy && detail.mode !== 'auto' && detail.mode !== 'paused';
  return <div className="cv-workspace">
    <div className="ag-page-heading"><div><span className="ag-eyebrow">CONVERSATION AGENT</span><h1>私信承接</h1><p>从已知客户开启会话观察，保留双方原话，随时切换人工接管。</p></div></div>
    {error && <div className="ag-alert error" role="alert"><CircleAlert size={18}/><p>{error}</p></div>}
    {notice && <div className="cv-notice" role="status"><Check size={16}/>{notice}</div>}
    <section className="ag-panel cv-monitor"><div><h2>会话观察</h2><p>{monitor.enabled ? '已启用，按计划检查已加入的会话。' : '尚未开启，不会在后台读取或自动回复私信。'}开启后会暂停找客任务，让浏览器优先承接对话。</p>{monitor.reason && <p className="cv-reason">{monitor.reason}</p>}</div><div className="cv-monitor-actions"><label>检查间隔（秒）<input aria-label="会话检查间隔（秒）" type="number" min={5} max={300} value={monitor.intervalSeconds} onChange={event => setMonitor(current => ({ ...current, intervalSeconds: Number(event.target.value) }))}/></label><button className={`ag-button ${monitor.enabled ? 'secondary' : 'primary'}`} disabled={!online || !!busy} onClick={() => void act('monitor', async () => { setMonitor(await api<Monitor>('/conversation-monitor', 'PUT', { enabled: !monitor.enabled, intervalSeconds: monitor.intervalSeconds })); setNotice(monitor.enabled ? '已停止后台观察。' : '已开启会话观察；自动回复仍需逐会话授权。'); })}>{monitor.enabled ? '停止观察' : '开启观察并暂停找客'}</button></div></section>
    <section className="ag-panel cv-add"><label>加入已知客户<select aria-label="加入已知客户" value={customerId} onChange={event => setCustomerId(event.target.value)}><option value="">请选择客户</option>{untracked.map(customer => <option key={customer.id} value={customer.id}>{customer.nickname || customer.platformId || customer.id}</option>)}</select></label><button className="ag-button secondary" disabled={!customerId || !online || !!busy} onClick={() => void act('create', async () => { const item = await api<Conversation>('/conversations', 'POST', { customerId }); setCustomerId(''); await select(item.id); setNotice('已加入，默认仅建议回复。首次同步只建立历史基线。'); })}><Plus size={15}/>加入会话</button><p>仅观察主动加入的客户，不会自动承接整个账号的陌生私信。</p></section>
    <div className="cv-layout"><section className="ag-panel cv-list" aria-label="会话列表"><div className="cv-list-title"><h2>我的会话</h2><span>{list.length}</span></div>{list.length ? list.map(item => <button className={`cv-conversation ${selected === item.id ? 'selected' : ''}`} key={item.id} onClick={() => void select(item.id)}><div><strong>{item.nickname || '昵称待核实'}</strong><span className={`cv-mode cv-mode-${item.mode}`}>{modes[item.mode]}</span></div><p>{item.reason || (item.baselineEstablished ? `${item.pendingCount || 0} 条待处理` : '等待首次同步')}</p><small>{time(item.lastSyncAt)}</small></button>) : <div className="ag-empty"><MessageSquare size={28}/><h3>还没有会话</h3><p>从上方加入客户，先查看真实消息，再决定如何承接。</p></div>}</section>
      <section className="ag-panel cv-detail" aria-label="会话详情">{!detail ? <div className="ag-empty"><MessageSquare size={30}/><h3>{selected ? '正在读取会话' : '选择一个会话'}</h3><p>同步记录、建议回复和发送结果会保留在这里。</p></div> : <>
        <header className="cv-detail-header"><div><h2>{detail.nickname || '昵称待核实'}</h2><p>{modes[detail.mode]} · {stages[detail.stage || ''] || detail.stage || '等待观察'} · {time(detail.lastSyncAt)}</p>{externalUrl(detail.profileUrl) && <a className="ag-link" href={externalUrl(detail.profileUrl)} target="_blank" rel="noopener noreferrer">公开主页<ExternalLink size={12}/></a>}</div><button className="ag-button secondary" disabled={!online || busy === 'human'} onClick={() => void configure('human')}><Hand size={15}/>人工接管</button></header>
        {detail.reason && <div className="cv-inline-note" role="status">{detail.reason}</div>}
        {!detail.baselineEstablished && <div className="cv-inline-note">首次同步仅导入可见历史，不自动回复历史消息。</div>}
        <div className="cv-controls"><button className="ag-button secondary" disabled={!online || !!busy} onClick={() => void act('sync', async () => { applyDetail(await api<Detail>(`/conversations/${selected}/sync`, 'POST')); setNotice('同步已完成，请核对会话状态及消息。'); })}>{busy === 'sync' ? <LoaderCircle size={14} className="ag-spin"/> : <RefreshCw size={14}/>}同步消息</button><button className="ag-button ghost" disabled={!online || !!busy || detail.mode === 'suggest'} onClick={() => void configure('suggest')}>仅建议回复</button><button className="ag-button ghost" disabled={!online || !!busy || detail.mode === 'paused'} onClick={() => void configure('paused')}>暂停此会话</button></div>
        <div className="cv-messages" aria-label="双方消息记录">{detail.messages?.length ? detail.messages.map(message => <article className={`cv-message cv-${message.direction}`} key={message.id}><div><strong>{message.direction === 'inbound' ? detail.nickname : message.direction === 'outbound' ? '我方' : '方向待核实'}</strong><small>{time(message.at || message.observedAt)}{message.baseline ? ' · 历史基线' : ''}</small></div><p>{message.text || `[${message.type || '未知类型'}消息]`}</p>{message.status && <small>{statuses[message.status] || message.status}</small>}{message.reason && <small>{message.reason}</small>}{evidence(message.evidencePath) && <a className="ag-link" href={evidence(message.evidencePath)} target="_blank" rel="noopener noreferrer">查看证据<ExternalLink size={11}/></a>}</article>) : <div className="cv-no-messages">尚无已核对的消息。点击同步消息建立历史基线。</div>}</div>
        <div className="cv-auto"><label><input aria-label="授权此会话自动承接" type="checkbox" checked={autoAuthorized} onChange={event => setAutoAuthorized(event.target.checked)}/>允许对该客户后续的新消息自动承接；未知问题转人工</label><button className="ag-button secondary" disabled={!online || !!busy || !autoAuthorized || !detail.baselineEstablished} onClick={() => void configure('auto')}>开启此会话自动承接</button><small>需同时开启上方会话观察。规则模式仅处理已定义场景，不承诺理解任意对话。</small></div>
        <div className="cv-compose"><div className="cv-compose-title"><h3>本轮回复</h3><button className="ag-button ghost" disabled={!online || !!busy || !detail.baselineEstablished} onClick={() => void act('draft', async () => { const id = selectedRef.current; const response = await api<Detail | Suggestion>(`/conversations/${id}/draft`, 'POST'); if (selectedRef.current !== id) return; const suggested = 'messages' in response ? response.suggestion : response; if ('messages' in response) applyDetail(response); if (suggested && revisionRef.current === suggested.revision) { setText(suggested.text || ''); setDraftRevision(suggested.revision); setSendAuthorized(false); requestRef.current = null; setNotice(suggested.reason || '已生成建议，请核对后发送。'); } else { clearDraft(); setNotice('会话已变化或没有可发送的建议，请同步后核对。'); } })}>生成建议回复</button></div>{detail.suggestion?.reason && <p className="ag-note">{detail.suggestion.reason}</p>}<textarea aria-label="本轮回复内容" rows={4} value={text} maxLength={500} placeholder="根据最新消息编辑回复，勾选确认后才能实际发送。" onChange={event => { setText(event.target.value); setDraftRevision(detail.revision); setSendAuthorized(false); requestRef.current = null; }}/><label className="cv-send-consent"><input aria-label="确认发送本条私信" type="checkbox" checked={sendAuthorized} disabled={!text.trim() || stale} onChange={event => setSendAuthorized(event.target.checked)}/>确认向当前客户发送这条私信</label><div className="cv-compose-footer"><small>{detail.mode === 'auto' ? '自动承接中；手动回复前请先人工接管。' : detail.mode === 'paused' ? '此会话已暂停，切换为人工接管后可手动发送。' : '发送前将重新核对身份和会话版本；状态未知不会自动重发。'}</small><button className="ag-button primary" disabled={!canSend} onClick={() => void act('send', async () => { if (!detail || !canSend) return; const clean = text.trim(); const id = selectedRef.current; const revision = detail.revision; if (!requestRef.current || requestRef.current.text !== clean || requestRef.current.revision !== revision) requestRef.current = { id: crypto.randomUUID(), text: clean, revision }; await api(`/conversations/${id}/send`, 'POST', { text: clean, authorized: true, requestId: requestRef.current.id, revision }); if (id === selectedRef.current) { clearDraft(); setNotice('发送操作已记录，请查看下方实际结果。'); applyDetail(await api<Detail>(`/conversations/${id}`)); } })}><Send size={14}/>发送本条私信</button></div></div>
        {!!detail.outbox?.length && <section className="cv-outbox"><h3>发送记录</h3>{detail.outbox.slice().reverse().map(item => <div key={item.id}><strong>{statuses[item.status || ''] || item.status || '状态待核实'}</strong><p>{item.text}</p><small>{item.reason}</small>{evidence(item.evidencePath) && <a className="ag-link" href={evidence(item.evidencePath)} target="_blank" rel="noopener noreferrer">查看页面证据<ExternalLink size={11}/></a>}{item.status === 'unknown' && <div className="cv-resolution"><label><input type="checkbox" aria-label="已在抖音会话核对这条消息的实际状态" checked={!!resolutionAuthorized[item.id]} onChange={event => setResolutionAuthorized(current => ({ ...current, [item.id]: event.target.checked }))}/>已在抖音会话核对这条消息的实际状态</label><div>{([{ resolution: 'sent', label: '已人工核对：确实已发出' }, { resolution: 'not_sent', label: '已人工核对：确实未发出' }] as const).map(option => <button key={option.resolution} className="ag-button secondary" disabled={!online || !!busy || !resolutionAuthorized[item.id]} onClick={() => void act('resolve', async () => { const id = selectedRef.current; applyDetail(await api<Detail>(`/conversations/${id}/outbox/${item.id}/resolve`, 'POST', { resolution: option.resolution, authorized: true, note: `已核对真实抖音会话，${option.resolution === 'sent' ? '确实已发出' : '确实未发出'}。` })); setResolutionAuthorized(current => ({ ...current, [item.id]: false })); setNotice('人工核查结果已记录；这不是平台送达回执，也不会自动重发该消息。'); })}>{option.label}</button>)}</div><small>仅记录你的核查结论，不代表平台确认送达，不会自动重新发送。</small></div>}</div>)}</section>}
      </>}</section></div>
  </div>;
}
