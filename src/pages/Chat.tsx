import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowUp, ArrowUpRight, Check, CheckCheck, ChevronDown, ChevronRight, CircleAlert, Clock3, History, MessageSquarePlus, Plus, ScanSearch, SlidersHorizontal, Target, Users, X, ShieldCheck, BookOpen, ArrowRight } from 'lucide-react';
import { useStore } from '../lib/store';
import { accountRevision, allocation, createTask, emptyKnowledge, metrics, setTaskEnabled, uid, updateTask } from '../lib/domain';
import { needsBusiness, needsRequirements, parsePlan, taskPlan } from '../lib/chat';
import type { AppState, ChatCard, Conversation, Knowledge, Message, Plan } from '../lib/types';
import './Chat.css';
import { messagePreview } from '../lib/messaging';

const suggestions = [
  { icon: ScanSearch, title: '寻找潜在客户', description: '从真实需求信号中，发现对的人', prompt: '帮我找杭州近期在抖音咨询热玛吉价格或效果的人，每天联系 20 个高意向客户。', color: 'blue' },
  { icon: Target, title: '监控指定账号', description: '关注同行动态，捕捉潜在需求', prompt: '帮我监控指定抖音账号的作品和评论，寻找有明确需求的潜在客户。', color: 'green' },
  { icon: SlidersHorizontal, title: '调整现有任务', description: '修改目标、时间或每日触达计划', prompt: '把热玛吉任务每天触达人数改成 10 人。', color: 'orange' },
];

export default function Chat() {
  const { state, transact, selectAccount, notify } = useStore();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState('');
  const [history, setHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cardError, setCardError] = useState('');
  const [ambiguous, setAmbiguous] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const submitting = useRef(false);
  const handledTask = useRef('');
  const account = state.accounts.find(a => a.id === state.selectedAccountId) || state.accounts[0];
  const accountId = account?.id || '';
  const convId = state.activeConversation[accountId];
  const conversation = state.conversations.find(c => c.id === convId && c.accountId === accountId);
  const messages = conversation?.messages || [];
  const sessions = state.conversations.filter(c => c.accountId === accountId);
  const k = state.knowledge[accountId] || emptyKnowledge();
  const pending = [...messages].reverse().find(m => m.card?.status === 'pending')?.card;
  const accountTasks = state.tasks.filter(t => t.accountId === accountId);

  useEffect(() => { if (messages.length) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages.length, pending?.type]);
  useEffect(() => { setCardError(''); setAmbiguous(false); setText(''); }, [accountId, convId]);

  function getConversation(d: AppState, id?: string): Conversation {
    const active = id || d.activeConversation[accountId];
    let c = d.conversations.find(item => item.id === active && item.accountId === accountId);
    if (!c) {
      c = { id: uid('C'), accountId, title: '新对话', messages: [], createdAt: new Date().toISOString() };
      d.conversations.push(c); d.activeConversation[accountId] = c.id;
    }
    return c;
  }
  function append(c: Conversation, content: string, card?: ChatCard) {
    c.messages.push({ id: uid('M'), role: 'assistant', text: content, ...(card ? { card } : {}) });
  }
  function nextCard(type: ChatCard['type'], plan: Plan, extra?: Partial<ChatCard>): ChatCard {
    return { id: uid('card'), type, status: 'pending', plan, accountRevision: accountRevision(state, accountId), ...extra };
  }
  function beginAdjust(taskId: string) {
    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return;
    if (task.accountId !== accountId) { selectAccount(task.accountId); return; }
    transact(d => {
      let c = d.conversations.find(c => c.id === task.conversationId && c.accountId === task.accountId);
      if (!c) { c = { id: uid('C'), accountId: task.accountId, title: `调整${task.name}`, messages: [], createdAt: new Date().toISOString() }; d.conversations.push(c); }
      d.activeConversation[task.accountId] = c.id;
      c.messages.forEach(m => { if (m.card?.status === 'pending') m.card.status = 'expired'; });
      append(c, '告诉我你想怎样调整，或直接编辑下方配置。确认后只会影响未来执行，历史数据会保留。', nextCard('adjust', taskPlan(task), { taskId: task.id, taskRevision: task.revision }));
    });
    setAmbiguous(false);
  }
  useEffect(() => {
    const id = params.get('task');
    if (!id || !account) return;
    const task = state.tasks.find(t => t.id === id);
    if (!task) { notify('未找到该任务'); setParams({}, { replace: true }); return; }
    if (task.accountId !== accountId) { selectAccount(task.accountId); return; }
    if (handledTask.current !== id) { handledTask.current = id; beginAdjust(id); setParams({}, { replace: true }); }
  }, [params, accountId]);

  function patchCard(cardId: string, patch: Partial<ChatCard>) {
    setCardError('');
    transact(d => { const card = getConversation(d).messages.find(m => m.card?.id === cardId)?.card; if (card?.status === 'pending') Object.assign(card, patch); });
  }
  function changePlan(card: ChatCard, patch: Partial<Plan>) { patchCard(card.id, { plan: { ...card.plan!, ...patch } }); }
  function cancel(card: ChatCard) { patchCard(card.id, { status: 'cancelled' }); notify('已取消，任务配置没有变更'); }
  function startNew() {
    transact(d => { const c = { id: uid('C'), accountId, title: '新对话', messages: [], createdAt: new Date().toISOString() }; d.conversations.push(c); d.activeConversation[accountId] = c.id; });
    setHistory(false); setText(''); inputRef.current?.focus();
  }
  function fail(message: string) { setCardError(message); notify(message); }

  function submit(event?: React.FormEvent) {
    event?.preventDefault();
    const value = text.trim();
    if (!value || busy || !account) return;
    setText(''); setCardError('');
    if (/调整|修改|改成|改为|暂停|恢复|话术|沟通|语气|策略/.test(value) && !pending) {
      const topic = ['热玛吉', '超声炮', '玻尿酸', '皮肤管理', '装修'].find(t => value.includes(t));
      const matches = topic ? accountTasks.filter(t => t.name.includes(topic)) : accountTasks;
      if (matches.length === 1) {
        const task = matches[0];
        transact(d => {
          const c = getConversation(d); if (!c.messages.length) c.title = value.slice(0, 18);
          c.messages.push({ id: uid('M'), role: 'user', text: value });
          append(c, /暂停|恢复/.test(value) ? '请确认任务状态调整。额度继续保留，历史记录不会改变。' : '已根据你的要求整理调整内容，请确认前后差异。', nextCard('adjust', parsePlan(value, k, taskPlan(task)), { taskId: task.id, taskRevision: task.revision, desiredEnabled: /暂停/.test(value) ? false : /恢复/.test(value) ? true : undefined }));
        }); return;
      }
      transact(d => { const c = getConversation(d); c.messages.push({ id: uid('M'), role: 'user', text: value }); append(c, matches.length ? '当前账号有多个任务，请先选择要调整的任务。' : '当前账号没有找到对应任务。可以在定时任务中心查看，或描述新任务的目标。'); });
      setAmbiguous(matches.length > 0); return;
    }
    transact(d => {
      const c = getConversation(d); if (!c.messages.length) c.title = value.slice(0, 18);
      c.messages.push({ id: uid('M'), role: 'user', text: value });
      const activeCard = [...c.messages].reverse().find(m => m.card?.status === 'pending')?.card;
      if (/取消/.test(value) && activeCard) { activeCard.status = 'cancelled'; append(c, '已取消当前方案，原任务和历史记录保持不变。'); return; }
      if (/为什么|为何/.test(value)) {
        const execution = d.executions.filter(e => accountTasks.some(t => t.id === e.taskId)).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
        append(c, execution?.reason ? `最近一次执行记录的原因是：${execution.reason}。可进入定时任务中心查看具体步骤。` : '现有演示执行记录中没有足够证据解释这个原因，无法判断。你可以在定时任务中心中核对每次执行的时间和结果。'); return;
      }
      if (/多少|几个|当前计划|查看任务|运行情况|什么任务|任务数量/.test(value) && !/每天|每日|改/.test(value)) {
        const stats = metrics(d, accountId);
        append(c, `「${account.name}」目前共有 ${accountTasks.length} 个任务，${accountTasks.filter(t => t.status === 'running').length} 个正常运行。每日已分配 ${allocation(d, accountId)} / ${account.limit} 人；累计分析 ${stats.analyzed.toLocaleString()} 人，识别目标客户 ${stats.targeted} 人，成功触达 ${stats.contacted} 人，留资 ${stats.leads} 人。以上均为已保存的演示记录。`); return;
      }
      if (activeCard?.plan && ['requirements', 'plan', 'conflict', 'adjust', 'business'].includes(activeCard.type) && !/另建|新建|再创建|再建/.test(value)) {
        activeCard.plan = parsePlan(value, k, activeCard.plan);
        if (activeCard.taskId && /暂停|恢复/.test(value)) activeCard.desiredEnabled = !/暂停/.test(value);
        append(c, '已更新当前待确认方案，请检查卡片中的目标、执行时间和触达人数。'); return;
      }
      if (!/找|客户|潜客|监控|需求|私信|触达|咨询|热玛吉|超声炮|玻尿酸|装修/.test(value)) {
        append(c, '我可以帮你创建或调整抖音找客任务。请告诉我目标客户、地区和希望发现的需求信号，例如“找杭州近期咨询热玛吉价格的人，每天联系20人”。'); return;
      }
      if (activeCard) activeCard.status = 'cancelled';
      const plan = parsePlan(value, k);
      if (needsBusiness(k)) append(c, '为了按你的实际业务制定方案，先补充当前账号的业务信息。保存后可在知识库继续编辑。', nextCard('business', plan, { knowledge: { ...k } }));
      else if (needsRequirements(plan)) append(c, '先确认你要找的人。标为建议的条件可以修改，确认后再制定执行方案。', nextCard('requirements', plan));
      else append(c, '目标已经清楚了。我整理了一份找客计划，确认执行范围后就可以创建任务。', nextCard('plan', plan));
    });
  }

  function confirm(card: ChatCard, findOnly = false) {
    if (submitting.current || card.status !== 'pending') return;
    setCardError('');
    if (card.type === 'business') {
      const knowledge = card.knowledge!;
      if (needsBusiness(knowledge)) return fail('请填写账号身份、服务地区和服务内容，避免使用未经确认的业务资料。');
      transact(d => { const c = getConversation(d); const live = c.messages.find(m => m.card?.id === card.id)?.card; if (!live || live.status !== 'pending') return; d.knowledge[accountId] = knowledge; live.status = 'confirmed'; const p = { ...card.plan!, region: card.plan!.region || knowledge.region }; append(c, '业务信息已保存到当前账号知识库。接下来确认找客条件。', nextCard(needsRequirements(p) ? 'requirements' : 'plan', p, { accountRevision: accountRevision(d, accountId) })); }); return;
    }
    const plan = { ...card.plan! };
    if (card.type === 'requirements') {
      if (!plan.target.trim() || !plan.region.trim() || !plan.signals.trim() || !plan.source.trim() || plan.source.includes('需补充')) return fail('请补齐目标客户、地区、需求信号和具体来源。监控任务需填写目标抖音号。');
      if (!plan.target.includes('时间范围：')) plan.target += '；时间范围：近期 7 天';
      transact(d => { const c = getConversation(d); const live = c.messages.find(m => m.card?.id === card.id)?.card; if (live?.status !== 'pending') return; live.status = 'confirmed'; append(c, '找客条件已确认。以下执行频率和触达计划可继续调整。', nextCard('plan', plan)); }); return;
    }
    if (findOnly) { plan.mode = 'find'; plan.dailyQuota = 0; plan.authorized = false; }
    if (!plan.name.trim() || !plan.target.trim() || !plan.region.trim() || !plan.signals.trim() || !plan.source.trim()) return fail('请完整填写任务名称、目标、地区、需求信号与来源。');
    if (!/^每天 ([01]\d|2[0-3]):[0-5]\d$/.test(plan.schedule)) return fail('执行周期请使用“每天 HH:mm”，例如每天 10:00。');
    if (!Number.isInteger(plan.dailyQuota) || plan.dailyQuota < 0) return fail('每日计划人数必须是大于或等于 0 的整数。');
    if (plan.mode === 'contact' && !plan.authorized) return fail('请先确认本任务的私信触达授权，或切换为仅找客。');
    if (plan.mode === 'find') plan.dailyQuota = 0;
    const adjustingTask = card.taskId ? state.tasks.find(t => t.id === card.taskId) : undefined;
    if (card.taskId && (!adjustingTask || adjustingTask.revision !== card.taskRevision)) {
      patchCard(card.id, { status: 'expired' }); return fail('任务配置已变化，请从定时任务中心重新发起调整。');
    }
    if (['plan', 'conflict', 'adjust'].includes(card.type) && card.accountRevision !== accountRevision(state, accountId)) {
      patchCard(card.id, { status: 'expired' }); return fail('账号配置已变化，当前卡片已过期。请点击重新校验后确认。');
    }
    if (!account.connected && !adjustingTask) return fail('当前抖音账号已掉线，请先到抖音账号页面重新登录。');
    const total = allocation(state, accountId) - (adjustingTask?.dailyQuota || 0) + plan.dailyQuota;
    if (card.type !== 'conflict' && total > account.limit) {
      transact(d => { const c = getConversation(d); const live = c.messages.find(m => m.card?.id === card.id)?.card; if (live?.status !== 'pending') return; live.status = 'confirmed'; append(c, `当前账号每日计划额度已分配 ${allocation(state, accountId)} 人，这份方案会超出 ${account.limit} 人的演示上限。你可以调整其他任务，或先仅找客。`, nextCard('conflict', plan, { taskId: card.taskId, taskRevision: card.taskRevision, desiredEnabled: card.desiredEnabled, allocations: Object.fromEntries(accountTasks.filter(t => t.id !== card.taskId).map(t => [t.id, t.dailyQuota])) })); }); return;
    }
    if (card.type === 'conflict' && !findOnly) {
      const proposed = Object.values(card.allocations || {}).reduce((a, b) => a + b, 0) + plan.dailyQuota;
      if (proposed > account.limit) return fail(`合计 ${proposed} 人，仍超过账号每日上限 ${account.limit} 人。`);
    }
    submitting.current = true; setBusy(true);
    const ok = transact(d => {
      const c = getConversation(d); const live = c.messages.find(m => m.card?.id === card.id)?.card;
      if (!live || live.status !== 'pending') throw new Error('该卡片已提交，请勿重复操作。');
      const allocations = card.type === 'conflict' && !findOnly ? card.allocations : undefined;
      if (adjustingTask) {
        const task = updateTask(d, adjustingTask.id, plan, allocations);
        if (card.desiredEnabled !== undefined) setTaskEnabled(d, task.id, card.desiredEnabled);
        live.status = 'confirmed'; append(c, `「${task.name}」已调整，只影响未来执行。已有执行与留资记录已保留。`, { id: uid('card'), type: 'success', status: 'confirmed', resultTaskId: task.id, taskId: task.id, plan });
      } else {
        const task = createTask(d, { ...plan, accountId, conversationId: c.id }, allocations);
        live.status = 'confirmed'; append(c, '任务已创建并保存，等待下一个执行时间。创建任务不会产生找客或触达结果。', { id: uid('card'), type: 'success', status: 'confirmed', resultTaskId: task.id, plan });
      }
    });
    if (!ok) setCardError('保存未完成，请检查账号连接与额度后重试。输入内容已保留。');
    window.setTimeout(() => { submitting.current = false; setBusy(false); }, 300);
  }

  function planField(card: ChatCard, key: keyof Plan, label: string, multiline = false) {
    const value = String(card.plan?.[key] ?? '');
    return <label className={`form-field ${multiline ? 'full' : ''}`} key={key}><span>{label}</span>{multiline ? <textarea className="field" value={value} onChange={e => changePlan(card, { [key]: e.target.value })} rows={2}/> : <input className="field" value={value} onChange={e => changePlan(card, { [key]: key === 'dailyQuota' ? Number(e.target.value) : e.target.value })} type={key === 'dailyQuota' ? 'number' : 'text'} min={0}/>}</label>;
  }
  function renderCard(card: ChatCard) {
    const labels = { business: '业务信息确认', requirements: '找客需求确认', plan: '找客方案确认', conflict: '触达额度冲突', success: '任务已就绪', adjust: '任务调整确认' };
    const cardIcons = { business: BookOpen, requirements: Target, plan: ScanSearch, conflict: CircleAlert, success: CheckCheck, adjust: SlidersHorizontal };
    const Icon = cardIcons[card.type];
    if (card.type === 'success') {
      const task = state.tasks.find(t => t.id === card.resultTaskId);
      if (!task) return null;
      const stats = metrics(state, accountId, undefined, undefined, task.id);
      return <section className="chat-card success-card"><div className="card-heading"><span className="card-icon success"><Icon size={17}/></span><div><h3>{task.name}</h3><span>任务已保存 · {account.name}</span></div><span className={`badge ${task.status === 'running' ? 'green' : 'gray'}`}>{task.status === 'running' ? '正常运行' : task.status === 'paused' ? '已暂停' : '运行异常'}</span></div><div className="success-details"><span><Clock3 size={13}/>{task.schedule}</span><span><Users size={13}/>{task.dailyQuota ? `${task.dailyQuota} 人/天` : '仅找客，不安排触达'}</span></div><div className="success-metrics">{[['分析用户', stats.analyzed], ['目标客户', stats.targeted], ['成功触达', stats.contacted], ['留资客户', stats.leads]].map(([label, value]) => <div key={label}><strong>{Number(value).toLocaleString()}</strong><span>{label}</span></div>)}</div><div className="card-footer"><span className="muted">{state.executions.some(e => e.taskId === task.id) ? '演示记录 · 结果以执行记录为准' : '尚未执行 · 不代表已发送私信'}</span><Link className="button primary small" to={`/work/${task.id}`}>查看定时任务中心 <ArrowUpRight size={14}/></Link><button className="button ghost small" onClick={() => beginAdjust(task.id)}>调整任务</button></div></section>;
    }
    if (card.status !== 'pending') return <div className={`card-summary ${card.status}`}><Icon size={15}/><span>{labels[card.type]}</span><span className="summary-value">{card.plan?.name}</span><span className="summary-state">{card.status === 'confirmed' ? <><Check size={13}/> 已确认</> : card.status === 'expired' ? '已过期' : '已取消'}</span>{card.status === 'expired' && card.plan && <button className="button ghost small" onClick={() => transact(d => { const c = getConversation(d); c.messages.forEach(m => { if (m.card?.status === 'pending') m.card.status = 'expired'; }); const task = d.tasks.find(t => t.id === card.taskId); append(c, '已读取最新账号配置，请重新检查方案与授权。', nextCard(task ? 'adjust' : 'plan', { ...card.plan!, authorized: false }, { taskId: task?.id, taskRevision: task?.revision, desiredEnabled: card.desiredEnabled, accountRevision: accountRevision(d, accountId) })); })}>重新校验</button>}</div>;
    const task = state.tasks.find(t => t.id === card.taskId);
    const conflictTotal = Object.values(card.allocations || {}).reduce((a, b) => a + b, 0) + (card.plan?.dailyQuota || 0);
    return <section className={`chat-card ${card.type === 'conflict' ? 'conflict-card' : ''}`}>
      <div className="card-heading"><span className={`card-icon ${card.type === 'conflict' ? 'warning' : ''}`}><Icon size={17}/></span><div><h3>{labels[card.type]}</h3><span>{card.type === 'conflict' ? '调整每日计划，让每个任务有序执行' : card.type === 'adjust' ? '确认后仅影响未来执行，保留历史记录' : '请检查以下内容，确认后再继续'}</span></div><span className={`badge ${card.type === 'conflict' ? 'orange' : 'blue'}`}>待确认</span></div>
      <div className="card-body">
        {card.type === 'business' && <div className="form-grid">{([['identity', '我的身份'], ['brand', '所属机构或品牌'], ['service', '主推产品 / 服务内容'], ['region', '服务地区'], ['advantage', '核心优势'], ['purpose', '触达目的']] as [keyof Knowledge, string][]).map(([key, label]) => <label className="form-field" key={key}><span>{label}</span><input className="field" value={String(card.knowledge?.[key] || '')} onChange={e => patchCard(card.id, { knowledge: { ...card.knowledge!, [key]: e.target.value } })} placeholder="按实际业务填写"/></label>)}</div>}
        {card.type === 'requirements' && <><p className="card-note">已有信息已预填，执行时间与人数是可修改的建议。仅使用你确认的条件。</p><div className="form-grid">{planField(card, 'target', '目标客户 / 目标需求', true)}{planField(card, 'region', '目标地区')}{planField(card, 'signals', '意向信号')}{planField(card, 'source', '找客渠道 / 指定账号', true)}<label className="form-field"><span>目标时间范围（建议）</span><input className="field" defaultValue="近期 7 天" onChange={e => changePlan(card, { target: `${card.plan!.target.replace(/；时间范围：.*$/, '')}；时间范围：${e.target.value}` })}/></label><label className="form-field"><span>排除对象（可选）</span><input className="field" placeholder="例如：同行、已明确拒绝的用户" onBlur={e => { if (e.target.value) changePlan(card, { target: `${card.plan!.target.replace(/；排除：.*$/, '')}；排除：${e.target.value}` }); }}/></label></div></>}
        {(card.type === 'plan' || card.type === 'adjust') && <>
          <div className="plan-account"><span className="avatar" style={{ background: account.color }}>{account.initials}</span><div><span>执行抖音账号</span><strong>{account.name}</strong></div><span className={`badge ${account.connected ? 'green' : 'red'}`}>{account.connected ? '正常连接' : '已掉线'}</span></div>
          {card.type === 'adjust' && task && <div className="adjust-before"><span>当前计划</span><strong>{task.dailyQuota} 人/天</strong><ChevronRight size={13}/><strong>{card.plan!.mode === 'find' ? 0 : card.plan!.dailyQuota} 人/天</strong><span>{task.schedule} → {card.plan!.schedule}</span>{card.desiredEnabled !== undefined && <span>{task.enabled ? '启用' : '暂停'} → {card.desiredEnabled ? '恢复运行' : '暂停'}</span>}{(['name', 'target', 'region', 'signals', 'source', 'mode'] as const).filter(key => task[key] !== card.plan![key]).map(key => <span className="adjust-diff" key={key}>{({ name: '名称', target: '目标', region: '地区', signals: '信号', source: '来源', mode: '模式' })[key]}：{String(task[key])} → {String(card.plan![key])}</span>)}</div>}
          <div className="form-grid">{planField(card, 'name', '任务名称')}{planField(card, 'schedule', '执行周期（北京时间）')}{planField(card, 'target', '找客目标', true)}{planField(card, 'region', '地区')}{planField(card, 'signals', '需求信号')}{planField(card, 'source', '寻找渠道与范围', true)}</div>
          <>{card.type === 'adjust' && task && task.communicationStrategy !== card.plan?.communicationStrategy && <p className="card-note">沟通策略：{task.communicationStrategy || '沿用账号沟通要求'} → {card.plan?.communicationStrategy || '沿用账号沟通要求'}</p>}<details className="message-preview"><summary>预览示例话术与沟通规则</summary><span className="badge gray">演示数据 · 示例话术，尚未发送</span><p className="card-note">示例用于说明沟通方向，实际内容会依据每位用户的公开线索个性化生成；不会编造价格、资质或效果承诺。</p><blockquote>{messagePreview(k, card.plan!)}</blockquote><dl><dt>当前账号身份</dt><dd>{k.identity || '暂无数据'}</dd><dt>业务与产品</dt><dd>{k.service || '暂无数据'}{k.products.length ? `；${k.products.map(product => `${product.name}：${product.description}`).join('；')}` : ''}</dd><dt>沟通目标</dt><dd>{k.goal || k.purpose || '暂无数据'}</dd><dt>风格与注意事项</dt><dd>{k.style || '暂无数据'}；{k.cautions || '暂无数据'}</dd></dl>{planField(card, 'communicationStrategy', '本任务沟通策略（仅影响后续内容）', true)}<p className="card-note">确认后保存策略；调整不改写任何历史私信与回复。</p></details></>
          {card.plan!.mode === 'contact' && <><div className="quota-field"><span>每日计划触达</span><label><input aria-label="每日计划触达人数" type="number" min={0} value={card.plan!.dailyQuota} onChange={e => changePlan(card, { dailyQuota: Number(e.target.value) })}/><span>人 / 天</span></label><small>使用抖音私信 · 计划不保证每日达成</small></div><label className="authorization"><input type="checkbox" checked={card.plan!.authorized} onChange={e => changePlan(card, { authorized: e.target.checked })}/><span>我授权本任务按已确认的目标与额度自动发起私信，遵守账号状态、去重及拒绝联系规则。<small>当前为模拟执行，不会发送真实私信。</small></span></label></>}
          <div className="knowledge-context"><BookOpen size={13}/><span>基于当前账号知识库：{k.products[0]?.name || k.service || '尚未补充产品资料'} · {k.style || '未设定沟通风格'}</span></div>
        </>}
        {card.type === 'conflict' && <>
          <div className="conflict-overview"><span>{account.name}</span><strong>每日计划上限 {account.limit} 人</strong></div><div className="conflict-labels"><span>现有任务（含暂停任务，仍保留额度）</span><span>当前 → 调整后</span></div>
          {accountTasks.filter(t => t.id !== card.taskId).map(t => <div className="allocation-row" key={t.id}><div><span>{t.name}</span><small>{t.status === 'paused' ? '已暂停 · 保留额度' : t.status === 'error' ? '运行异常 · 保留额度' : '正常运行'}</small></div><span className="old-quota">{t.dailyQuota}</span><ArrowRight size={12}/><input type="number" min={0} aria-label={`${t.name}调整后每日额度`} value={card.allocations?.[t.id] ?? t.dailyQuota} onChange={e => patchCard(card.id, { allocations: { ...card.allocations, [t.id]: Number(e.target.value) } })}/><span>人/天</span></div>)}
          <div className="allocation-row new"><div><span>{card.taskId ? '调整任务' : '新任务'}：{card.plan!.name}</span><small>本次申请</small></div><input type="number" min={0} aria-label="新任务每日额度" value={card.plan!.dailyQuota} onChange={e => changePlan(card, { dailyQuota: Number(e.target.value) })}/><span>人/天</span></div>
          <div className={`allocation-total ${conflictTotal > account.limit ? 'over' : ''}`}><span>调整后合计</span><strong>{conflictTotal} <small>/ {account.limit} 人</small></strong><span>{conflictTotal > account.limit ? `超出 ${conflictTotal - account.limit} 人` : '额度符合要求'}</span></div><p className="card-note">每日上限仅为演示值。实际发送还受当天剩余额度、账号连接和用户去重限制。</p>
        </>}
        {cardError && <p className="card-error" role="alert"><CircleAlert size={14}/>{cardError}</p>}
      </div>
      <div className="card-footer"><button className="button ghost small" disabled={busy} onClick={() => cancel(card)}>取消</button>{card.type === 'conflict' && <button className="button secondary small" disabled={busy} onClick={() => confirm(card, true)}>{card.taskId ? '改为仅找客' : '仅创建找客任务'}</button>}<button className="button primary" disabled={busy || (card.type === 'conflict' && conflictTotal > account.limit)} onClick={() => confirm(card)}>{busy ? '保存中…' : card.type === 'business' ? '确认并保存' : card.type === 'requirements' ? '确认目标' : card.type === 'adjust' ? '确认调整' : card.type === 'conflict' ? card.taskId ? '确认额度调整' : '确认调整并创建' : '开始执行'}{!busy && <ArrowRight size={14}/>}</button></div>
    </section>;
  }

  if (!account) return <div className="page"><div className="empty-state"><ScanSearch size={34}/><h3>先连接你的第一个抖音账号</h3><p>每个账号拥有独立的对话、任务与知识库。</p><Link to="/douyin-accounts" className="button primary">添加抖音账号 <Plus size={15}/></Link></div></div>;

  return <div className="chat-page">
    <header className="chat-toolbar"><div className="chat-toolbar-actions"><div className="history-container"><button className={`icon-button ${history ? 'is-active' : ''}`} aria-label="历史会话" title="历史会话" onClick={() => setHistory(!history)}><History size={16}/></button>{history && <div className="history-menu"><div className="history-title">当前账号的对话 <button className="icon-button" aria-label="关闭历史" onClick={() => setHistory(false)}><X size={13}/></button></div>{sessions.length ? [...sessions].reverse().map(s => <button key={s.id} className={s.id === convId ? 'current' : ''} onClick={() => { transact(d => { d.activeConversation[accountId] = s.id; }); setHistory(false); }}>{s.title}<ChevronRight size={13}/></button>) : <p>还没有历史对话</p>}</div>}</div><button className="button secondary new-chat" onClick={startNew}><MessageSquarePlus size={15}/> 新对话</button><div className="account-select-wrap"><span className="avatar" style={{ background: account.color }}>{account.initials}</span><select aria-label="当前抖音账号" value={accountId} onChange={e => selectAccount(e.target.value)}>{state.accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select><ChevronDown size={13}/></div></div></header>
    <div className={`chat-scroll ${!messages.length ? 'is-welcome' : ''}`}>
      {!messages.length ? <div className="chat-welcome"><div className="welcome-intro"><img className="nomi-welcome-avatar" src="/nomi-wink-transparent.png" alt="Nomi 眨眼形象" width="112" height="112"/><div className="welcome-copy"><div className="welcome-eyebrow"><span/> 你的专属获客助手</div><h2>Hi！我是Nomi～</h2><p>告诉我你想找什么样的客户，我来帮你全网寻找、主动联系，把获客变简单！</p></div></div><div className="suggestion-grid">{suggestions.map(({ icon: Icon, title, description, prompt, color }) => <button className="suggestion-card" key={title} onClick={() => { setText(prompt); inputRef.current?.focus(); }}><span className={`suggestion-icon ${color}`}><Icon size={20} strokeWidth={1.6}/></span><strong>{title}<ArrowUpRight size={14}/></strong><span>{description}</span></button>)}</div><div className="welcome-footnote"><ShieldCheck size={13}/><span>你确认方向，智能体按计划工作。所有触达均需明确授权。</span></div></div> : <div className="messages">{messages.map((message: Message) => <div key={message.id} className={`message ${message.role}`}>
        {message.role === 'assistant' && <div className="assistant-avatar"><img className="brand-mark nomi-message-avatar" src="/logo-transparent.png" alt=""/></div>}
        <div className="message-content">{message.role === 'assistant' && <span className="assistant-name">Nomi <span>演示</span></span>}<p className="message-text">{message.text}</p>{message.card && renderCard(message.card)}</div>
        {message.role === 'user' && <div className="user-avatar">我</div>}
      </div>)}{ambiguous && <div className="task-choices">{accountTasks.map(t => <button className="button secondary" key={t.id} onClick={() => beginAdjust(t.id)}>{t.name}<ChevronRight size={13}/></button>)}</div>}<div ref={endRef}/></div>}
    </div>
    <div className="chat-composer-area"><div className="chat-context-strip"><span className={`account-state ${!account.connected ? 'offline' : ''}`}><i/>{account.connected ? '账号正常连接' : '账号已掉线'}</span><span>今日计划已分配 <strong>{allocation(state, accountId)}</strong> / {account.limit} 人</span><Link to={account.connected ? '/work' : '/douyin-accounts'}>{account.connected ? '查看任务' : '重新登录'}<ChevronRight size={12}/></Link></div><form className="chat-composer" onSubmit={submit}><textarea ref={inputRef} aria-label="输入找客需求" placeholder="告诉我你想找什么样的客户，例如：帮我找杭州近期咨询热玛吉的人…" value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} rows={2}/><div className="composer-bottom"><button className="send-button" type="submit" disabled={!text.trim() || busy} aria-label="发送需求"><ArrowUp size={18}/></button></div></form><p className="composer-disclaimer">演示数据与模拟连接 · 对话由规则驱动 · 不发送真实私信 <span>Enter 发送 / Shift + Enter 换行</span></p></div>
  </div>;
}
