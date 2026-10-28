import { Children, cloneElement, isValidElement, useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Activity, ArrowDown, ArrowRight, BookOpen, Check, ChevronRight, CircleAlert, Clock3, ExternalLink, LoaderCircle, MessageSquare, Pause, Play, Plus, Radio, RefreshCw, Search, Send, ShieldCheck, Square, Users, X } from 'lucide-react';
import { api, externalUrl, unwrap } from './api';
import { customerInTask, filterCustomers, taskMessages, taskSources } from './scope';
import type { Account, AgentEvent, Channel, Customer, Execution, Knowledge, Plan, Section, Task } from './types';
import './agent.css';
import BrowserAssist from './BrowserAssist';
import Conversations from './Conversations';

const navigation: { id: Section; title: string; icon: typeof Activity }[] = [
  { id: 'chat', title: '提需求', icon: MessageSquare }, { id: 'work', title: '任务中心', icon: Activity },
  { id: 'results', title: '结果中心', icon: Users }, { id: 'accounts', title: '账号管理', icon: Radio }, { id: 'knowledge', title: '知识库', icon: BookOpen },
  { id: 'conversations', title: '私信承接', icon: Send },
];
const channelNames: Record<Channel, string> = { dm: '抖音私信', live_mention: '直播 @ 回复', video_comment: '作品评论回复' };
const sourceNames = { keyword_comments: '关键词找作品与评论', account_comments: '指定账号作品与评论', live_chat: '直播弹幕观察' };
const statusNames: Record<string, string> = { ready: '待执行', queued: '等待执行', running: '执行中', paused: '已暂停', completed: '已完成', failed: '执行失败', cancelled: '已停止', partial: '部分完成', pending: '待执行', success: '页面显示已发送', unknown: '发送状态待确认', sending: '发送中', skipped: '已跳过', received: '已记录回复', connected: '已连接', login_required: '等待手动登录', expired: '登录已过期', disconnected: '未连接', worker_offline: '执行服务离线' };
const blankPlan = (): Plan => ({ name: '', target: '', region: '', signals: '', sourceType: 'keyword_comments', keywords: [], sourceUrl: '', scheduleMode: 'once', scheduleTime: '10:00', limit: 10, observeSeconds: 60, mode: 'find', channel: 'dm', authorized: false, communicationStrategy: '', workKeywords: [], maxWorks: 10, maxComments: 50, scanLimit: 100 });
const knowledgeFields = [['identity', '业务身份', '例如：为本地销售提供获客服务'], ['brand', '品牌 / 机构', '填写已确认的品牌名称'], ['region', '服务地区', '例如：杭州'], ['service', '产品与服务', '介绍你实际提供的服务'], ['audience', '目标客户', '描述想服务的人群'], ['advantage', '核心优势', '填写有事实依据的优势'], ['style', '沟通语气', '例如：礼貌、自然、简短'], ['goal', '沟通目标', '例如：先了解对方的获客需求'], ['cautions', '沟通要求', '例如：不承诺效果，不重复打扰']] as const;
function formatTime(value?: string) { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
function Badge({ status }: { status: string }) { return <span className={`ag-badge ag-${status}`}>{statusNames[status] || status}</span>; }
function Empty({ icon: Icon = Search, title, children }: { icon?: typeof Search; title: string; children?: React.ReactNode }) { return <div className="ag-empty"><Icon size={32} strokeWidth={1.3} /><h3>{title}</h3><p>{children}</p></div>; }
function SafeLink({ url, children }: { url?: string; children: React.ReactNode }) { const safe = externalUrl(url); return safe ? <a className="ag-link" href={safe} target="_blank" rel="noopener noreferrer">{children}<ExternalLink size={12}/></a> : null; }
function EvidenceLink({ url }: { url?: string }) { const path = url?.startsWith('evidence/') ? `/api/${url}` : url; return path?.startsWith('/api/evidence/') && !path.includes('..') ? <a className="ag-link ag-evidence-link" href={path} target="_blank" rel="noopener noreferrer">查看页面证据<ExternalLink size={12}/></a> : null; }

export default function AgentWorkspace({ initialSection = 'chat' }: { initialSection?: Section }) {
  const [section, setSection] = useState<Section>(initialSection);
  const [account, setAccount] = useState<Account>({ status: 'disconnected' });
  const [tasks, setTasks] = useState<Task[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [knowledge, setKnowledge] = useState<Knowledge>({});
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [online, setOnline] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [request, setRequest] = useState('');
  const [lastRequest, setLastRequest] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [keywordsText, setKeywordsText] = useState('');
  const [workKeywordsText, setWorkKeywordsText] = useState('');
  const [editingTaskId, setEditingTaskId] = useState('');
  const [questions, setQuestions] = useState<string[]>([]);
  const [provider, setProvider] = useState('');
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [taskFilter, setTaskFilter] = useState('');
  const [matchFilter, setMatchFilter] = useState('all');
  const [search, setSearch] = useState('');
  const cursor = useRef(0);
  const loading = useRef(false);
  const alive = useRef(true);

  const refresh = useCallback(async (initial = false) => {
    if (loading.current) return;
    loading.current = true;
    try {
      const [accountResult, taskResult, customerResult, executionResult] = await Promise.all([
        api('/account'), api('/tasks'), api('/customers'), api('/executions'),
      ]);
      if (!alive.current) return;
      setAccount(unwrap<Account>(accountResult, 'account'));
      setTasks(unwrap<Task[]>(taskResult, 'tasks'));
      const list = unwrap<Customer[]>(customerResult, 'customers');
      setCustomers(list);
      setSelectedCustomer(current => current ? list.find(item => item.id === current.id) || current : null);
      setExecutions(unwrap<Execution[]>(executionResult, 'executions'));
      setOnline(true);
      if (initial) setKnowledge(unwrap<Knowledge>(await api('/knowledge'), 'knowledge'));
      const result = await api<{events: AgentEvent[]; cursor: number}>(`/events?after=${cursor.current}`);
      if (!alive.current) return;
      cursor.current = result.cursor;
      if (result.events.length) setEvents(previous => [...previous, ...result.events].slice(-100));
    } catch (err) { if (alive.current) { setOnline(false); if (initial) setError(err instanceof Error ? err.message : '无法连接执行服务'); } }
    finally { loading.current = false; }
  }, []);
  useEffect(() => { alive.current = true; void refresh(true); const timer = setInterval(() => void refresh(), 3500); return () => { alive.current = false; clearInterval(timer); }; }, [refresh]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 6500); return () => clearTimeout(timer); }, [notice]);
  async function action<T>(key: string, fn: () => Promise<T>): Promise<T | undefined> {
    if (busy) return;
    setBusy(key); setError('');
    try { const result = await fn(); await refresh(); return result; }
    catch (err) { setError(err instanceof Error ? err.message : '操作未完成，请重试'); return undefined; }
    finally { setBusy(''); }
  }
  async function makePlan(event?: React.FormEvent) {
    event?.preventDefault(); if (!request.trim()) return;
    const text = plan && lastRequest ? `${lastRequest}\n补充调整：${request.trim()}` : request.trim();
    const result = await action('plan', () => api<{plan: Plan; questions: string[]; provider: string}>('/plan', 'POST', { text, knowledge }));
    if (result) { setLastRequest(text); setPlan({ ...blankPlan(), ...result.plan }); setKeywordsText((result.plan.keywords || []).join('，')); setWorkKeywordsText((result.plan.workKeywords || []).join('，')); setQuestions(result.questions || []); setProvider(result.provider); setRequest(''); }
  }
  async function create(run: boolean) {
    if (!plan) return;
    if (plan.scanLimit < plan.limit) { setError('候选查看预算不能小于希望找到的匹配人数。'); return; }
    if (!plan.name.trim() || !plan.target.trim()) { setError('请填写任务名称和目标客户。'); return; }
    if (plan.sourceType !== 'keyword_comments' && !externalUrl(plan.sourceUrl)) { setError('请填写有效的抖音链接。'); return; }
    if (plan.sourceType === 'keyword_comments' && !plan.keywords.length) { setError('请填写至少一个搜索关键词。'); return; }
    if (plan.mode === 'contact' && !plan.authorized) { setError('请确认本任务的触达范围，或选择仅找客。'); return; }
    await action('create', async () => {
      const task = unwrap<Task>(await api(editingTaskId ? `/tasks/${editingTaskId}` : '/tasks', editingTaskId ? 'PUT' : 'POST', plan), 'task');
      setSelectedTaskId(task.id); setPlan(null); setEditingTaskId(''); setQuestions([]); setSection('work');
      if (run) { try { await api(`/tasks/${task.id}/run`, 'POST'); setNotice('任务已提交执行，可以在这里查看实际进度。'); } catch (err) { setNotice('任务已保存，但尚未开始执行。'); throw err; } }
      else setNotice('任务已保存。一次性任务可手动开始，定时任务将按计划安排。');
    });
  }
  const selectedTask = tasks.find(item => item.id === selectedTaskId);
  const running = tasks.filter(task => task.status === 'running' || task.status === 'queued').length;
  const filteredCustomers = filterCustomers(customers,taskFilter,matchFilter,search);
  const matched = filteredCustomers.filter(customer => customer.match?.status === 'matched');
  const sentCustomers = filteredCustomers.filter(customer => taskMessages(customer,taskFilter).some(message => message.direction !== 'inbound' && message.status === 'success'));
  const replied = filteredCustomers.filter(customer => taskMessages(customer,taskFilter).some(message => message.direction === 'inbound' && message.status === 'received'));
  const sourceSummary = (customer: Customer) => taskSources(customer,taskFilter)[0];
  const scopeTaskName = tasks.find(task => task.id === taskFilter)?.plan.name;
  const patchPlan = (patch: Partial<Plan>) => setPlan(current => current ? { ...current, ...patch } : current);

  return <div className="ag-shell">
    <aside className="ag-sidebar">
      <button className="ag-brand" onClick={() => setSection('chat')}><img src="/logo-transparent.png" alt=""/><span>Nomi<small>你的专属获客智能体</small></span></button>
      <span className="ag-nav-label">工作空间</span>
      <nav aria-label="主导航">{navigation.map(({ id, title, icon: Icon }) => <button key={id} aria-label={title} title={title} className={section === id ? 'active' : ''} onClick={() => setSection(id)} aria-current={section === id ? 'page' : undefined}><Icon size={19}/><span>{title}</span>{id === 'work' && running > 0 && <b>{running}</b>}</button>)}</nav>
      <div className="ag-side-bottom"><div className="ag-service"><i className={online ? 'online' : ''}/><span>{online === null ? '正在连接工作台' : online ? '执行服务已连接' : '执行服务未连接'}<small>{account.connected ? account.nickname || account.name || '抖音账号已登录' : '请连接抖音账号'}</small></span></div><p>让每一次发现，都有依据。</p></div>
    </aside>
    <main className="ag-main">
      <header className="ag-topbar"><span>Nomi 工作空间 <ChevronRight size={12}/><b>{navigation.find(item => item.id === section)?.title}</b></span><button onClick={() => setSection('accounts')} className="ag-account-pill"><i className={account.connected ? 'online' : ''}/>{account.connected ? account.nickname || '抖音已连接' : '连接抖音'}<ChevronRight size={12}/></button></header>
      <div className="ag-page">
        {online === false && <div className="ag-alert" role="status"><CircleAlert size={18}/><div><strong>暂时无法连接执行服务</strong><p>任务和结果不会被模拟生成。请连接此工作台对应的执行服务；云端网页不会自动连接你电脑上的浏览器。</p></div><button className="ag-button ghost" onClick={() => void refresh(true)}><RefreshCw size={14}/>重新连接</button></div>}
        {error && <div className="ag-alert error" role="alert"><CircleAlert size={18}/><p>{error}</p><button className="ag-icon" aria-label="关闭错误提示" onClick={() => setError('')}><X size={16}/></button></div>}
        {section === 'chat' && <>
          <div className="ag-chat-intro"><div className="ag-intro-mark"><img src="/nomi-avatar.png" alt="Nomi"/></div><span className="ag-eyebrow">YOUR PROSPECTING AGENT</span><h1>你想找到什么样的客户？</h1><p>告诉 Nomi 目标，从真实发言里发现需求，把判断和行动留在同一条链路里。</p></div>
          {!plan && <div className="ag-suggestions">{[
            {icon: Search, title: '从作品评论找客户', text: '帮我从抖音作品评论里找 10 个杭州有获客需求的销售，只找人，先不私信。', desc: '关键词搜索 → 筛选作品 → 阅读评论'},
            {icon: Radio, title: '观察一个直播间', text: '帮我观察抖音直播间的公开弹幕，识别有明确获客需求的人，观察 60 秒，先不触达。', desc: '观察发言 → 查看主页 → 记录依据'},
            {icon: Users, title: '关注指定账号的评论', text: '帮我查看指定抖音账号最近作品下的评论，找有明确咨询需求的人，只找人。', desc: '指定账号 → 近期作品 → 需求信号'},
          ].map(({icon: Icon, title, text, desc}) => <button key={title} onClick={() => setRequest(text)}><Icon size={19}/><strong>{title}</strong><small>{desc}</small><ArrowRight size={16}/></button>)}</div>}
          {lastRequest && <div className="ag-request-bubble"><span>你的需求</span><p>{lastRequest}</p></div>}
          {plan && <section className="ag-panel ag-plan"><div className="ag-panel-title"><div><span className="ag-eyebrow">EXECUTION PLAN</span><h2>{editingTaskId ? "调整任务执行方案" : "把需求变成执行方案"}</h2></div><span className="ag-neutral-label">待你确认</span></div>
            {!!questions.length && <div className="ag-plan-questions"><strong>还有这些条件需要你补充</strong><ul>{questions.map((question, i) => <li key={i}>{question}</li>)}</ul><span>可以直接编辑下方条件，或在对话中继续补充。</span></div>}
            {provider && <p className="ag-note">{provider.includes('rule') || provider.includes('fallback') || provider.includes('local') ? '已整理为可编辑方案，请核对目标与条件。' : '已根据你的需求生成方案，请核对后执行。'}</p>}
            <div className="ag-form-grid"><Field label="任务名称" wide><input value={plan.name} onChange={e => patchPlan({name:e.target.value})} placeholder="为这个任务起一个名称"/></Field><Field label="目标客户" wide><textarea rows={2} value={plan.target} onChange={e => patchPlan({target:e.target.value})} placeholder="要找谁，什么发言能证明有需求"/></Field><Field label="目标地区"><input value={plan.region} onChange={e => patchPlan({region:e.target.value})} placeholder="例如：杭州；不限地区可填写不限"/></Field><Field label="意向信号"><input value={plan.signals} onChange={e => patchPlan({signals:e.target.value})} placeholder="例如：想获客、客户少、找线索"/></Field><Field label="寻找路径" wide><div className="ag-choice-row">{Object.entries(sourceNames).map(([key,value]) => <button key={key} className={plan.sourceType === key ? 'selected' : ''} onClick={() => patchPlan({sourceType:key as Plan['sourceType'],channel:'dm',authorized:false})}>{value}</button>)}</div></Field>
              {plan.sourceType === 'keyword_comments' ? <Field label="搜索关键词" wide><input value={keywordsText} onChange={e => {setKeywordsText(e.target.value);patchPlan({keywords:e.target.value.split(/[,，\n]/).map(item => item.trim()).filter(Boolean)});}} placeholder="多个关键词用逗号分隔，例如：杭州销售获客，销售找客户"/></Field> : <Field label={plan.sourceType === 'live_chat' ? '直播间链接' : '抖音账号主页'} wide><input value={plan.sourceUrl} onChange={e => patchPlan({sourceUrl:e.target.value})} placeholder={plan.sourceType === 'live_chat' ? 'https://live.douyin.com/…' : 'https://www.douyin.com/user/…'}/></Field>}
              <Field label="希望找到的匹配人数"><input type="number" min={1} max={100} value={plan.limit} onChange={e => patchPlan({limit:Number(e.target.value)})}/></Field>{plan.sourceType === 'live_chat' ? <Field label="本轮观察时长（秒）"><input type="number" min={10} max={1800} value={plan.observeSeconds} onChange={e => patchPlan({observeSeconds:Number(e.target.value)})}/></Field> : <div className="ag-inline-note"><ShieldCheck size={16}/>只读取公开内容，无法访问的来源会记录原因并跳过。</div>}
              <Field label="本轮最多查看候选人数"><input type="number" min={1} max={500} value={plan.scanLimit} onChange={e => patchPlan({scanLimit:Number(e.target.value)})}/></Field><div className="ag-inline-note">达到目标人数或候选预算即结束本轮，匹配不足会如实保留结果。</div>
              {plan.sourceType !== 'live_chat' && <><Field label="作品标题筛选（可选）" wide><input value={workKeywordsText} onChange={e => {setWorkKeywordsText(e.target.value);patchPlan({workKeywords:e.target.value.split(/[,，\n]/).map(item => item.trim()).filter(Boolean)});}} placeholder="只看标题包含这些词的作品；多个词用逗号分隔"/></Field><Field label="最多查看作品数"><input type="number" min={1} max={50} value={plan.maxWorks} onChange={e => patchPlan({maxWorks:Number(e.target.value)})}/></Field><Field label="每个作品最多查看评论数"><input type="number" min={1} max={200} value={plan.maxComments} onChange={e => patchPlan({maxComments:Number(e.target.value)})}/></Field></>}
              <Field label="执行安排"><select value={plan.scheduleMode} onChange={e => patchPlan({scheduleMode:e.target.value as Plan['scheduleMode']})}><option value="once">执行一次</option><option value="daily">每天执行</option></select></Field>{plan.scheduleMode === 'daily' && <Field label="每天开始时间（北京时间）"><input type="time" value={plan.scheduleTime} onChange={e => patchPlan({scheduleTime:e.target.value})}/></Field>}
              <Field label="执行方式" wide><div className="ag-choice-row"><button className={plan.mode === 'find' ? 'selected' : ''} onClick={() => patchPlan({mode:'find',authorized:false})}>仅找客，查看证据后再决定</button><button className={plan.mode === 'contact' ? 'selected' : ''} onClick={() => patchPlan({mode:'contact',authorized:false})}>找客并按计划触达</button></div></Field>
              {plan.mode === 'contact' && <><Field label="触达渠道"><select value={plan.channel} onChange={e => patchPlan({channel:e.target.value as Channel,authorized:false})}>{Object.entries(channelNames).filter(([key]) => key === 'dm' || (plan.sourceType === 'live_chat' ? key === 'live_mention' : key === 'video_comment')).map(([key,value]) => <option key={key} value={key}>{value}</option>)}</select></Field><Field label="沟通要求"><input value={plan.communicationStrategy} onChange={e => patchPlan({communicationStrategy:e.target.value})} placeholder="例如：先回应原话，礼貌简短，不承诺效果"/></Field><label className="ag-checkbox ag-wide"><input type="checkbox" checked={plan.authorized} onChange={e => patchPlan({authorized:e.target.checked})}/><span>授权本任务通过「{channelNames[plan.channel]}」联系明确匹配的客户，每轮最多 {plan.limit} 人。判断不足、已联系或发送状态不明的记录不自动重发。</span></label></>}
            </div><div className="ag-plan-footer"><button className="ag-button ghost" onClick={() => {setPlan(null);setEditingTaskId('');setQuestions([]);}}>取消方案</button><div><button className="ag-button secondary" disabled={!!busy || !online} onClick={() => void create(false)}>{editingTaskId ? "保存调整" : "保存任务"}</button><button className="ag-button primary" disabled={!!busy || !online} onClick={() => void create(true)}>{busy === 'create' ? <LoaderCircle size={15} className="ag-spin"/> : <Play size={15}/>}{editingTaskId ? "保存并执行一轮" : "确认并立即执行"}</button></div></div>
          </section>}
          <form className="ag-composer" onSubmit={makePlan}><textarea aria-label="输入获客需求" value={request} onChange={e => setRequest(e.target.value)} placeholder={plan ? '继续补充或调整需求…' : '例如：找 10 个杭州想做获客的销售，告诉我判断理由，先不触达。'} rows={3} onKeyDown={e => {if(e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void makePlan(e);}}/><div><span>{plan ? '补充内容会与原始需求一起整理，请再次核对。' : '先确认计划，再执行真实操作。'} <small>Ctrl + Enter 发送</small></span><button aria-label="整理执行方案" className="ag-send" disabled={!!busy || !request.trim() || !online}>{busy === 'plan' ? <LoaderCircle size={19} className="ag-spin"/> : <ArrowRight size={20}/>}</button></div></form>
        </>}
        {section === 'work' && <>
          <PageHeading eyebrow="AGENT WORK" title="任务中心" description="每一步真实执行，每一个结果都可回看。"><button className="ag-button primary" onClick={() => setSection('chat')}><Plus size={15}/>创建任务</button></PageHeading>
          <div className="ag-summary-strip"><Activity size={20}/><div><strong>{running ? `${running} 个任务正在执行或等待` : '工作台已准备好'}</strong><p>共 {tasks.length} 个任务 · 任务启用与实际执行分别记录</p></div><span className="ag-neutral-label">北京时间</span></div>
          {tasks.length ? <div className="ag-work-layout"><section className="ag-task-list">{tasks.map(task => <button key={task.id} onClick={() => setSelectedTaskId(task.id)} className={`ag-task-card ${selectedTaskId === task.id ? 'selected' : ''}`}><div><Badge status={task.status}/><small>{formatTime(task.createdAt)}</small></div><h3>{task.plan.name}</h3><p>{task.plan.target}</p><footer><span>{sourceNames[task.plan.sourceType]}</span><ChevronRight size={15}/></footer></button>)}</section><section className="ag-panel ag-task-detail">{selectedTask ? <>
            <div className="ag-panel-title"><div><h2>{selectedTask.plan.name}</h2><p>{selectedTask.plan.target}</p></div><Badge status={selectedTask.status}/></div><div className="ag-task-actions"><button className="ag-button primary" disabled={!!busy || ['running','queued','paused'].includes(selectedTask.status)} onClick={() => void action('run', () => api(`/tasks/${selectedTask.id}/run`,'POST'))}><Play size={14}/>立即执行一轮</button>{selectedTask.status === 'paused' ? <button className="ag-button secondary" disabled={!!busy} onClick={() => void action('resume', () => api(`/tasks/${selectedTask.id}/resume`,'POST'))}><Play size={14}/>恢复任务</button> : <button className="ag-button secondary" disabled={!!busy || selectedTask.status === 'cancelled'} onClick={() => void action('pause', () => api(`/tasks/${selectedTask.id}/pause`,'POST'))}><Pause size={14}/>暂停任务</button>}<button className="ag-button ghost" disabled={!!busy || ['cancelled','completed','failed'].includes(selectedTask.status)} onClick={() => void action('cancel', () => api(`/tasks/${selectedTask.id}/cancel`,'POST'))}><Square size={13}/>停止任务</button><button className="ag-button secondary" disabled={!!busy || ['running','queued'].includes(selectedTask.status)} onClick={() => {setEditingTaskId(selectedTask.id);setPlan({...blankPlan(),...selectedTask.plan});setKeywordsText(selectedTask.plan.keywords.join('，'));setWorkKeywordsText((selectedTask.plan.workKeywords || []).join('，'));setLastRequest(`调整任务「${selectedTask.plan.name}」。目标：${selectedTask.plan.target}；地区：${selectedTask.plan.region}；意向信号：${selectedTask.plan.signals}；寻找路径：${sourceNames[selectedTask.plan.sourceType]}；关键词：${selectedTask.plan.keywords.join('、')}；来源：${selectedTask.plan.sourceUrl || '关键词搜索'}；目标人数：${selectedTask.plan.limit}；候选预算：${selectedTask.plan.scanLimit || 100}；执行方式：${selectedTask.plan.mode === 'find' ? '仅找客' : channelNames[selectedTask.plan.channel]}。`);setQuestions([]);setRequest('');setSection('chat');}}>调整任务</button></div>
            <dl className="ag-definition-grid"><div><dt>寻找路径</dt><dd>{sourceNames[selectedTask.plan.sourceType]}</dd></div><div><dt>执行安排</dt><dd>{selectedTask.plan.scheduleMode === 'daily' ? `每天 ${selectedTask.plan.scheduleTime}` : '执行一次'}</dd></div><div><dt>目标地区</dt><dd>{selectedTask.plan.region || '未指定'}</dd></div><div><dt>目标人数</dt><dd>{selectedTask.plan.limit} 人</dd></div><div><dt>执行方式</dt><dd>{selectedTask.plan.mode === 'find' ? '仅找客' : channelNames[selectedTask.plan.channel]}</dd></div><div><dt>下次执行</dt><dd>{formatTime(selectedTask.nextRunAt)}</dd></div></dl><SafeLink url={selectedTask.plan.sourceUrl}>查看指定来源</SafeLink>
            <div className="ag-detail-section-heading"><h3>执行记录</h3><button className="ag-link" onClick={() => {setTaskFilter(selectedTask.id);setSection('results');}}>查看本任务客户<ArrowRight size={13}/></button></div>
            {executions.filter(item => item.taskId === selectedTask.id).length ? executions.filter(item => item.taskId === selectedTask.id).slice().sort((a,b) => b.startedAt.localeCompare(a.startedAt)).map(execution => <ExecutionCard key={execution.id} execution={execution}/>) : <Empty icon={Clock3} title="尚未开始执行">任务保存不会产生客户结果。点击立即执行，或等待定时安排。</Empty>}
          </> : <Empty title="选择一个任务">查看任务条件、执行步骤和实际结果。</Empty>}</section></div> : <section className="ag-panel"><Empty icon={Activity} title="还没有任务">从一句需求开始，Nomi 会先整理可执行方案。</Empty></section>}
          <EventLog events={events}/>
        </>}
        {section === 'results' && <>
          <PageHeading eyebrow="EVIDENCE & RESULTS" title="结果中心" description="先看原始发言，再看判断理由。指标和列表使用同一筛选范围。"/>
          <div className="ag-metrics">{[{label:'已发现用户',value:filteredCustomers.length,icon:Search},{label:'明确匹配',value:matched.length,icon:Users},{label:'页面显示已发送',value:sentCustomers.length,icon:Send},{label:'已记录回复',value:replied.length,icon:MessageSquare}].map(({label,value,icon:Icon}) => <div className="ag-panel" key={label}><span>{label}<Icon size={16}/></span><strong>{value}<small> 人</small></strong></div>)}</div>
          <section className="ag-panel ag-results"><div className="ag-panel-title"><div><h2>客户与判断依据</h2><p>普通互动不自动等于业务意向，信息不足会标记待核实。</p></div><span className="ag-neutral-label">真实执行记录</span></div><div className="ag-filters"><label><span className="ag-sr">按任务筛选</span><select aria-label="按任务筛选" value={taskFilter} onChange={e => setTaskFilter(e.target.value)}><option value="">全部任务</option>{tasks.map(task => <option value={task.id} key={task.id}>{task.plan.name}</option>)}</select></label><label><span className="ag-sr">按匹配状态筛选</span><select aria-label="按匹配状态筛选" value={matchFilter} onChange={e => setMatchFilter(e.target.value)}><option value="all">全部判断</option><option value="matched">明确匹配</option><option value="uncertain">待核实</option><option value="excluded">已排除</option></select></label><label className="ag-search"><Search size={15}/><input aria-label="搜索昵称或发言" placeholder="搜索昵称、标识或发言" value={search} onChange={e => setSearch(e.target.value)}/></label></div>
            {filteredCustomers.length ? <div className="ag-table-wrap"><table className="ag-table"><thead><tr><th>抖音用户</th><th>发现来源 / 原始发言</th><th>判断</th><th>触达状态</th><th>发现时间</th><th/></tr></thead><tbody>{filteredCustomers.map(customer => <tr key={customer.id}><td><div className="ag-customer-identity"><span className="ag-user-avatar">{(customer.nickname || '访').slice(0,1)}</span><div><strong>{customer.nickname || '昵称未读取'}</strong><small>{customer.platformId || '标识待核实'}</small></div></div></td><td><span>{sourceNames[sourceSummary(customer)?.type as keyof typeof sourceNames] || sourceSummary(customer)?.type || '公开来源'}</span><p className="ag-table-quote">{sourceSummary(customer)?.text || '暂无原始发言'}</p></td><td><MatchBadge customer={customer}/></td><td><Badge status={taskMessages(customer,taskFilter).filter(item => item.direction !== 'inbound').at(-1)?.status || 'ready'}/></td><td className="ag-nowrap">{formatTime(customer.discoveredAt)}</td><td><button className="ag-link" onClick={() => setSelectedCustomer(customer)}>查看详情<ChevronRight size={14}/></button></td></tr>)}</tbody></table></div> : <Empty icon={Users} title={customers.length ? '没有符合筛选条件的用户' : '还没有发现用户'}>{customers.length ? '试试调整任务、判断或搜索条件。' : '真实执行产生的客户、发言与判断将出现在这里。'}</Empty>}<footer className="ag-list-footer">共 {filteredCustomers.length} 人<span>发送记录不代表平台已送达或对方已读。</span></footer></section>
        </>}
        {section === 'accounts' && <>
          <PageHeading eyebrow="ACCOUNT CONNECTION" title="连接你的抖音账号" description="由你手动完成登录，Nomi 使用该账号执行已确认的任务。"/>
          <section className="ag-panel ag-account-card"><div className="ag-account-hero"><div className="ag-douyin-mark">♪</div><div><h2>{account.nickname || account.name || '抖音工作账号'}</h2><p>{account.handle || '本地独立浏览器会话'}</p></div><Badge status={account.connected ? 'connected' : account.status || 'disconnected'}/></div><div className="ag-account-explanation"><ShieldCheck size={22}/><div><h3>{account.connected ? '登录会话已连接' : '在打开的浏览器中手动登录'}</h3><p>{account.reason || account.message || (account.connected ? '任务会使用这份登录会话。登录过期或页面不可用时，会保留已有结果并显示原因。' : '点击下方按钮打开抖音窗口，完成登录或验证码后返回。工作台会自动检查连接状态。')}</p></div></div><div className="ag-task-actions"><button className="ag-button primary" disabled={!!busy || !online} onClick={() => void action('login', async () => {await api('/account/login','POST');setNotice('已请求打开登录窗口，请在浏览器中手动完成登录。');})}>{busy === 'login' ? <LoaderCircle size={16} className="ag-spin"/> : <Radio size={16}/>} {account.connected ? '打开抖音窗口' : '打开浏览器登录'}</button><button className="ag-button secondary" disabled={!!busy || !online} onClick={() => void action('check', async () => {const result=unwrap<Account>(await api('/account'),'account');setAccount(result);setNotice(result.connected ? '已检测到登录状态。' : '尚未检测到有效登录，请完成浏览器中的登录。');})}><RefreshCw size={14}/>检查登录状态</button><button className="ag-button ghost" disabled={!!busy || !account.connected} onClick={() => void action('disconnect', async () => {await api('/account/disconnect','POST');setNotice('会话连接已关闭，历史任务和结果保留。');})}>断开会话</button></div><p className="ag-note">断开会话不会删除任务和历史结果。账号异常时不会补发状态不明的消息。</p></section>
          <BrowserAssist/><section className="ag-panel ag-principles"><h3>每次行动都有边界</h3><div><span><Check size={16}/>公开内容可读，隐私内容跳过</span><span><Check size={16}/>你先确认方案，任务再开始</span><span><Check size={16}/>生成话术和实际发送分开记录</span></div></section>
        </>}
        {section === 'conversations' && <Conversations customers={customers} online={!!online}/>}
        {section === 'knowledge' && <>
          <PageHeading eyebrow="BUSINESS KNOWLEDGE" title="让 Nomi 了解你的业务" description="业务资料帮助理解目标和生成话术，不会改写已保存的发言与发送记录。"/>
          <form className="ag-panel ag-knowledge" onSubmit={event => {event.preventDefault();void action('knowledge',async () => {await api('/knowledge','PUT',knowledge);setNotice('业务资料已保存，将用于后续计划和话术。');});}}><div className="ag-panel-title"><div><h2>业务与沟通资料</h2><p>只填写已确认的信息；没有的内容可以留空。</p></div><BookOpen size={22}/></div><div className="ag-form-grid">{knowledgeFields.map(([key,label,placeholder]) => <Field key={key} label={label} wide={['service','audience','cautions'].includes(key)}>{['service','audience','cautions'].includes(key) ? <textarea value={knowledge[key] || ''} onChange={e => setKnowledge(current => ({...current,[key]:e.target.value}))} placeholder={placeholder} rows={3}/> : <input value={knowledge[key] || ''} onChange={e => setKnowledge(current => ({...current,[key]:e.target.value}))} placeholder={placeholder}/>}</Field>)}</div><div className="ag-plan-footer"><span className="ag-note">修改只作用于未来的计划与话术。</span><button className="ag-button primary" disabled={!!busy || !online}>{busy === 'knowledge' ? <LoaderCircle size={15} className="ag-spin"/> : <Check size={15}/>}保存资料</button></div></form>
        </>}
      </div>
    </main>
    {notice && <div className="ag-toast" role="status"><Check size={17}/>{notice}</div>}
    {selectedCustomer && <CustomerDrawer customer={customerInTask(selectedCustomer,taskFilter)} scopeTaskName={scopeTaskName} scopeTaskId={taskFilter || undefined} tasks={tasks} knowledge={knowledge} onClose={() => setSelectedCustomer(null)} onUpdate={() => refresh()} reportError={setError} notify={setNotice}/>}
  </div>;
}

function Field({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  const controls = Children.map(children, child => isValidElement(child) && typeof child.type === 'string' && ['input','textarea','select'].includes(child.type)
    ? cloneElement(child as ReactElement<{ 'aria-label'?: string }>, { 'aria-label': label }) : child);
  return <label className={`ag-field ${wide ? 'ag-wide' : ''}`}><span>{label}</span>{controls}</label>;
}
function PageHeading({eyebrow,title,description,children}:{eyebrow:string;title:string;description:string;children?:React.ReactNode}) {return <div className="ag-page-heading"><div><span className="ag-eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{children}</div>;}
function MatchBadge({customer}:{customer:Customer}) {const status=customer.match?.status;return <span className={`ag-match ag-match-${status || 'uncertain'}`}>{status === 'matched' ? '明确匹配' : status === 'excluded' ? '已排除' : '待核实'}</span>;}
function eventTitle(event: AgentEvent) { const labels: Record<string,string> = {'task.created':'任务已创建','task.updated':'任务状态更新','execution.updated':'执行进度更新','customer.updated':'客户记录更新','account.updated':'账号连接更新','knowledge.updated':'业务资料已保存','execution.step':'执行步骤更新','schedule.skipped':'已跳过错过的计划'}; return event.message || labels[event.kind || event.type || ''] || '执行动态更新'; }
function ExecutionCard({execution}:{execution:Execution}) {return <article className="ag-execution"><div className="ag-execution-heading"><span><Clock3 size={14}/>{formatTime(execution.startedAt)}</span><Badge status={execution.status}/></div><div className="ag-execution-counts"><span>发现 <b>{execution.analyzed}</b></span><span>匹配 <b>{execution.targeted}</b></span><span>已发送 <b>{execution.contacted}</b></span><span>留资 <b>{execution.leads}</b></span></div>{(execution.reason || execution.error) && <p className="ag-execution-reason">{execution.reason || execution.error}</p>}<ol className="ag-steps">{execution.steps?.map((step,index)=><li key={index} className={`ag-step-${step.status}`}><i>{step.status === 'completed' || step.status === 'success' ? <Check size={12}/> : step.status === 'running' ? <LoaderCircle size={12} className="ag-spin"/> : step.status === 'failed' ? <X size={12}/> : <span/>}</i><div><strong>{step.name}</strong>{step.reason && <p>{step.reason}</p>}</div><small>{formatTime(step.time)}</small></li>)}</ol></article>;}
function EventLog({events}:{events:AgentEvent[]}) {return <details className="ag-panel ag-event-log"><summary>最近执行动态 <span>{events.length} 条</span><ArrowDown size={14}/></summary>{events.length ? <ol>{events.slice(-15).reverse().map((event,index)=><li key={event.id || index}><time>{formatTime(event.at || event.time)}</time><span>{eventTitle(event)}</span>{event.data && <small>{String(event.data.message || event.data.reason || event.data.name || '')}</small>}</li>)}</ol> : <p className="ag-note">开始任务后，这里会记录执行动态。</p>}</details>;}

function CustomerDrawer({customer,scopeTaskName,scopeTaskId,tasks,knowledge,onClose,onUpdate,reportError,notify}:{customer:Customer;scopeTaskName?:string;scopeTaskId?:string;tasks:Task[];knowledge:Knowledge;onClose:()=>void;onUpdate:()=>Promise<void>;reportError:(text:string)=>void;notify:(text:string)=>void}) {
  const [text,setText]=useState('');const [strategy,setStrategy]=useState('');const [channel,setChannel]=useState<Channel>('dm');const [busy,setBusy]=useState('');const [error,setError]=useState('');const [authorized,setAuthorized]=useState(false);
  const panel=useRef<HTMLElement>(null);const close=useRef<HTMLButtonElement>(null);const closing=useRef(onClose);closing.current=onClose;
  useEffect(()=>{const active=document.activeElement as HTMLElement;const overflow=document.body.style.overflow;document.body.style.overflow='hidden';close.current?.focus();const handler=(event:KeyboardEvent)=>{if(event.key==='Escape')closing.current();if(event.key==='Tab'){const list=Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input, select, textarea')||[]);const first=list[0],last=list.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}};document.addEventListener('keydown',handler);return()=>{document.body.style.overflow=overflow;document.removeEventListener('keydown',handler);active?.focus();};},[]);
  useEffect(()=>{setText('');setAuthorized(false);setError('');},[customer.id]);
  async function draft(){setBusy('draft');setError('');try{const result=await api<{text:string;provider:string}>(`/customers/${customer.id}/draft`,'POST',{strategy,knowledge,taskId:scopeTaskId});setText(result.text);setAuthorized(false);}catch(err){setError(err instanceof Error?err.message:'话术生成未完成');}finally{setBusy('');}}
  async function send(){if(!authorized||!text.trim())return;setBusy('send');setError('');try{const result=await api<{status?:string;reason?:string}>(`/customers/${customer.id}/send`,'POST',{text,channel,authorized:true,taskId:scopeTaskId});setAuthorized(false);setText('');await onUpdate();notify(result.status==='unknown'?'发送状态待确认，已保留记录，请勿重复发送。':result.status==='failed'?`本次发送未成功：${result.reason || '请查看沟通记录'}`:'本次操作结果已记录，请核对下方沟通记录。');}catch(err){const message=err instanceof Error?err.message:'发送结果暂未确认，请先查看记录，避免重复发送。';setError(message);reportError(message);setAuthorized(false);await onUpdate();}finally{setBusy('');}}
  async function verifyMessage(messageId:string){setBusy(`verify:${messageId}`);setError('');try{const result=await api<{status:string}>(`/customers/${customer.id}/messages/${messageId}/verify`,'POST');await onUpdate();notify(result.status==='success'?'已重新打开目标会话，找到完整外发原文；未确认送达或已读。':'重开会话仍未取得确认，已标记待确认，不自动重发。');}catch(err){setError(err instanceof Error?err.message:'复核中断，请检查记录。');}finally{setBusy('');}}
  return <div className="ag-drawer-backdrop" onClick={onClose}><aside className="ag-drawer" role="dialog" aria-modal="true" aria-labelledby="ag-customer-title" ref={panel} onClick={e=>e.stopPropagation()}><header><div><span className="ag-eyebrow">CUSTOMER EVIDENCE</span><h2 id="ag-customer-title">客户与原始依据</h2></div><button ref={close} className="ag-icon" onClick={onClose} aria-label="关闭客户详情"><X size={21}/></button></header><div className="ag-drawer-body"><section className="ag-customer-profile"><div className="ag-customer-identity"><span className="ag-user-avatar large">{(customer.nickname || '访').slice(0,1)}</span><div><h2>{customer.nickname || '昵称未读取'}</h2><small>{customer.platformId || '平台标识待核实'}</small></div><MatchBadge customer={customer}/></div><div className="ag-profile-meta"><SafeLink url={customer.profileUrl}>查看公开主页</SafeLink><span>首次发现 {formatTime(customer.discoveredAt)}</span></div></section>
    <section><h3>为什么找到这个人</h3>{scopeTaskName && <p className="ag-scope-note">当前判断对应任务：{scopeTaskName}。下方保留完整历史来源与沟通记录。</p>}<div className="ag-match-explanation">{customer.match?.reasons?.length ? <ul>{customer.match.reasons.map((reason,index)=><li key={index}>{reason}</li>)}</ul> : <p>暂未形成充分的匹配依据。</p>}{!!customer.match?.missing?.length && <div className="ag-missing"><strong>仍需核实</strong><ul>{customer.match.missing.map((reason,index)=><li key={index}>{reason}</li>)}</ul></div>}</div></section>
    <section><h3>来源与原始发言 <small>{customer.sources?.length || 0} 条</small></h3>{customer.sources?.length ? customer.sources.map((source,index)=><article className="ag-evidence" key={source.id || index}><div><strong>{String(index+1).padStart(2,'0')} · {sourceNames[source.type as keyof typeof sourceNames] || source.type || '公开来源'}</strong><time>{formatTime(source.discoveredAt)}</time></div><p>{source.title || '来源标题未读取'}</p><p className="ag-note">所属任务：{tasks.find(task => task.id === source.taskId)?.plan.name || '任务归属未记录'}</p><SafeLink url={source.url}>打开来源</SafeLink><span className="ag-evidence-label">原始发言</span><blockquote>{source.text || source.evidenceText || '没有保存可核对的原始文本'}</blockquote>{source.matchReason && <p className="ag-note">判断：{source.matchReason}</p>}<EvidenceLink url={source.evidencePath}/></article>) : <p className="ag-note">没有可展示的来源证据。</p>}</section>
    <section className="ag-contact"><h3>根据发言准备一次触达</h3><p className="ag-note">先生成并核对内容，再由你点击发送。不会因为生成话术而自动联系。</p><Field label="本次沟通要求"><input value={strategy} onChange={e=>setStrategy(e.target.value)} placeholder="例如：自然打招呼，简短礼貌"/></Field><div className="ag-draft-actions"><select aria-label="触达渠道" value={channel} onChange={e=>{setChannel(e.target.value as Channel);setAuthorized(false);}}>{Object.entries(channelNames).filter(([key]) => key === 'dm' || customer.sources?.some(source => key === 'live_mention' ? source.type === '直播弹幕' || source.type === 'live_chat' : source.type === '作品评论' || source.type === 'keyword_comments' || source.type === 'account_comments')).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select><button className="ag-button secondary" disabled={!!busy} onClick={()=>void draft()}>{busy==='draft'?<LoaderCircle size={14} className="ag-spin"/>:<MessageSquare size={14}/>}生成话术</button></div><textarea aria-label="待发送话术" maxLength={500} rows={4} value={text} onChange={e=>{setText(e.target.value);setAuthorized(false);}} placeholder="生成的话术会显示在这里，也可以自行填写（最多 500 字）。"/><label className="ag-checkbox"><input type="checkbox" checked={authorized} onChange={e=>setAuthorized(e.target.checked)}/><span>确认使用「{channelNames[channel]}」向此用户发送上方内容一次。</span></label>{error&&<p className="ag-local-error" role="alert">{error}</p>}<button className="ag-button primary ag-full" disabled={!!busy||!text.trim()||!authorized} onClick={()=>void send()}>{busy==='send'?<LoaderCircle size={15} className="ag-spin"/>:<Send size={15}/>}发送这一条</button></section>
    <section><h3>实际沟通记录 <small>{customer.messages?.length || 0} 条</small></h3><p className="ag-note">页面显示已发送不代表已送达或已读。状态不明的记录不会自动重发。</p>{customer.messages?.length ? <ol className="ag-message-history">{customer.messages.map((message,index)=><li key={message.id || index}><div><strong>{message.direction==='inbound'?'对方回复':channelNames[message.channel || 'dm']}</strong><Badge status={message.status}/></div><p>{message.text}</p><footer>{formatTime(message.at)} · {tasks.find(task => task.id === message.taskId)?.plan.name || "单人触达 / 未归属任务"}</footer>{message.reason&&<p className="ag-note">{message.reason}</p>}<EvidenceLink url={message.evidencePath || message.evidence}/>{message.confirmationLevel==='reopened_thread' && <p className="ag-note">已重开目标会话核验 · 未确认送达或已读</p>}{message.verification && <p className="ag-note">最近复核 {formatTime(message.verification.at)} · 完整原文 {message.verification.outgoingTextCount || 0} 条{message.status==='unknown'?' · 结果待确认，不自动重发':''}</p>}{message.id && message.direction==='outbound' && message.channel==='dm' && <button className="ag-button secondary" disabled={!!busy || message.status==='sending'} onClick={()=>void verifyMessage(message.id!)}>{busy===`verify:${message.id}`?<LoaderCircle size={14} className="ag-spin"/>:<RefreshCw size={14}/>}复核发送记录</button>}</li>)}</ol> : <div className="ag-no-messages"><MessageSquare size={22}/><span>暂无实际发送或回复记录</span></div>}</section>
  </div></aside></div>;
}
