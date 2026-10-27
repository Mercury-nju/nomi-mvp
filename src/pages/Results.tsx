import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowDown, ArrowLeft, ArrowRight, CalendarDays, ChevronLeft, ChevronRight, ContactRound, Info, MessageSquareText, ScanSearch, Search, Users, X } from 'lucide-react';
import { useStore } from '../lib/store';
import { customerFacts, selectCustomers } from '../lib/customers';
import type { Customer, Metrics } from '../lib/types';
import { TaskBadge } from './Work';
import CustomerDetail, { CustomerAvatar, displayTime } from './CustomerDetail';
import './WorkResults.css';
import './CustomerDetails.css';

type TimeFilter = 'all' | 'today' | 'week' | 'custom';
type CustomerStage = 'all' | keyof Metrics | 'pending' | 'replied';
function todayDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function daysBefore(date: string, days: number) {
  return new Date(new Date(`${date}T12:00:00+08:00`).getTime() - days * 86400000).toISOString().slice(0, 10);
}
function percentage(numerator: number, denominator: number) {
  return denominator === 0 ? '--' : `${(numerator / denominator * 100).toFixed(1)}%`;
}
const stages: { key: keyof Metrics; label: string; definition: string; icon: typeof Users; color: string }[] = [
  { key: 'analyzed', label: '分析用户', definition: '完成分析的去重用户', icon: ScanSearch, color: 'blue' },
  { key: 'targeted', label: '目标客户', definition: '符合找客条件的用户', icon: Users, color: 'indigo' },
  { key: 'contacted', label: '成功触达', definition: '私信实际发送成功的用户', icon: MessageSquareText, color: 'cyan' },
  { key: 'leads', label: '留资客户', definition: '已识别有效留资依据的用户', icon: ContactRound, color: 'green' },
];
const statusFilters: { key: CustomerStage; label: string }[] = [{ key: 'all', label: '全部' }, { key: 'pending', label: '待触达' }, { key: 'contacted', label: '已触达' }, { key: 'replied', label: '有回复' }, { key: 'leads', label: '已留资' }];
function matchesStage(customer: Customer, stage: CustomerStage) {
  const facts = customerFacts(customer);
  if (stage === 'targeted') return facts.targeted;
  if (stage === 'contacted') return facts.contacted;
  if (stage === 'leads') return facts.lead;
  if (stage === 'replied') return facts.replied;
  if (stage === 'pending') return facts.status === '待触达';
  return true;
}
function countCustomers(customers: Customer[]): Metrics {
  return customers.reduce((result, customer) => {
    const facts = customerFacts(customer);
    result.analyzed += 1;
    if (facts.targeted) result.targeted += 1;
    if (facts.contacted) result.contacted += 1;
    if (facts.lead) result.leads += 1;
    return result;
  }, { analyzed: 0, targeted: 0, contacted: 0, leads: 0 });
}
const customerKey = (customer: Customer) => `${customer.accountId}:${customer.platformId || customer.id}`;

export default function Results() {
  const { state } = useStore();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [selectedCustomer, setSelectedCustomer] = useState<string>();
  const detailSection = useRef<HTMLElement>(null);
  const accountValue = params.get('account') ?? 'all';
  const accountId = accountValue === 'all' ? '' : accountValue;
  const taskId = params.get('task') || '';
  const executionId = params.get('execution') || '';
  const requestedTime = params.get('time') || 'all';
  const time: TimeFilter = ['all', 'today', 'week', 'custom'].includes(requestedTime) ? requestedTime as TimeFilter : 'all';
  const customFrom = params.get('from') ?? daysBefore(todayDate(), 6);
  const customTo = params.get('to') ?? todayDate();
  const requestedStage = params.get('stage') || 'all';
  const stage: CustomerStage = ['all', 'analyzed', 'targeted', 'contacted', 'leads', 'pending', 'replied'].includes(requestedStage) ? requestedStage as CustomerStage : 'all';
  const search = params.get('q') || '';
  const returnTo = params.get('returnTo');
  const safeReturnTo = returnTo && /^\/work\/[A-Za-z0-9_-]+$/.test(returnTo) ? returnTo : undefined;
  const date = todayDate();
  const range = time === 'all' ? {} : time === 'today' ? { from: date, to: date } : time === 'week' ? { from: daysBefore(date, 6), to: date } : { from: customFrom || undefined, to: customTo || undefined };
  const invalidRange = time === 'custom' && (!customFrom || !customTo || customFrom > customTo);
  const availableTasks = state.tasks.filter(task => !accountId || task.accountId === accountId);
  const selectedTask = availableTasks.find(task => task.id === taskId);
  const execution = state.executions.find(item => item.id === executionId && (!taskId || item.taskId === taskId));
  const invalidContext = (!!taskId && !selectedTask) || (!!executionId && (!execution || !availableTasks.some(task => task.id === execution.taskId))) || (!!accountId && !state.accounts.some(account => account.id === accountId));
  const customers = useMemo(() => invalidRange || invalidContext ? [] : selectCustomers(state, { accountId: accountId || undefined, from: range.from, to: range.to, taskId: taskId || undefined, executionId: executionId || undefined }), [state, invalidRange, invalidContext, accountId, range.from, range.to, taskId, executionId]);
  const total = useMemo(() => countCustomers(customers), [customers]);
  const executionAvailable = useMemo(() => execution && !invalidContext ? countCustomers(selectCustomers(state, { accountId: accountId || undefined, taskId: taskId || undefined, executionId })) : undefined, [state, execution, invalidContext, accountId, taskId, executionId]);
  const incompleteExecution = execution && executionAvailable && stages.some(item => execution[item.key] !== executionAvailable[item.key]);
  const tasks = availableTasks.filter(task => (!taskId || task.id === taskId) && (!executionId || task.id === execution?.taskId));
  const interval = executionId ? '本次执行' : time === 'all' ? '累计' : time === 'today' ? '今日发现批次' : time === 'week' ? '近 7 天发现批次' : '所选发现批次';
  const selectedAccount = state.accounts.find(account => account.id === accountId);
  const customerList = useMemo(() => customers.filter(customer => matchesStage(customer, stage) && (!search.trim() || [customer.nickname, customer.platformId].some(value => value?.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())))), [customers, stage, search]);
  const taskResults = useMemo(() => new Map(state.tasks.filter(task => (!accountId || task.accountId === accountId) && (!taskId || task.id === taskId)).map(task => [task.id, countCustomers(invalidRange || invalidContext ? [] : selectCustomers(state, { accountId: accountId || undefined, from: range.from, to: range.to, executionId: executionId || undefined, taskId: task.id }))])), [state, accountId, taskId, range.from, range.to, executionId, invalidRange, invalidContext]);
  const pageCount = Math.max(1, Math.ceil(customerList.length / 10));
  const requestedPage = Number(params.get('page') || 1);
  const page = Math.min(pageCount, Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1);
  const visibleCustomers = customerList.slice((page - 1) * 10, page * 10);
  const detail = customers.find(customer => customerKey(customer) === selectedCustomer);
  function updateFilters(values: Record<string, string | undefined>, resetPage = true) {
    const next = new URLSearchParams(params);
    Object.entries(values).forEach(([key, value]) => value !== undefined && (value !== '' || key === 'from' || key === 'to') ? next.set(key, value) : next.delete(key));
    if (resetPage) next.delete('page');
    setSelectedCustomer(undefined);
    setParams(next, { replace: true, preventScrollReset: true });
  }
  function drilldown(nextStage: CustomerStage, nextTask?: string) {
    updateFilters({ stage: nextStage, q: undefined, ...(nextTask ? { task: nextTask } : {}) });
    requestAnimationFrame(() => { detailSection.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); detailSection.current?.focus({ preventScroll: true }); });
  }
  useEffect(() => {
    if (executionId || window.location.hash === '#potential-customers') requestAnimationFrame(() => detailSection.current?.scrollIntoView({ block: 'start' }));
  }, [executionId]);
  const stageLabel = stages.find(item => item.key === stage)?.label || statusFilters.find(item => item.key === stage)?.label || '全部';
  return <div className="page wr-page wr-results">
    {safeReturnTo && <button className="wr-back" onClick={() => navigate(safeReturnTo)}><ArrowLeft size={15} />返回原任务详情</button>}
    <div className="wr-results-toolbar"><div className="wr-results-filters"><label className="wr-select-label"><Users size={16} /><select className="select" aria-label="筛选结果所属抖音账号" value={accountValue} onChange={event => updateFilters({ account: event.target.value, task: undefined, execution: undefined })}><option value="all">全部抖音账号</option>{state.accounts.map(account => <option value={account.id} key={account.id}>{account.name}</option>)}</select></label><span className="wr-toolbar-divider" /><div className="wr-time-tabs" aria-label="统计时间范围">{([{ value: 'all', label: '累计' }, { value: 'today', label: '今日' }, { value: 'week', label: '近 7 天' }, { value: 'custom', label: '自定义' }] as { value: TimeFilter; label: string }[]).map(item => <button key={item.value} className={time === item.value ? 'active' : ''} aria-pressed={time === item.value} onClick={() => updateFilters({ time: item.value })}>{item.label}</button>)}</div></div><span className="wr-results-scope">{selectedAccount ? selectedAccount.name : '全部账号汇总'}</span></div>
    {time === 'custom' && <div className="wr-custom-range"><CalendarDays size={16} /><label><span>开始日期</span><input className="field" type="date" aria-label="客户首次发现开始日期" value={customFrom} max={customTo || date} onChange={event => updateFilters({ from: event.target.value })} /></label><span className="muted">至</span><label><span>结束日期</span><input className="field" type="date" aria-label="客户首次发现结束日期" value={customTo} min={customFrom} max={date} onChange={event => updateFilters({ to: event.target.value })} /></label>{invalidRange && <span className="wr-range-error" role="alert">请选择完整且有效的日期范围</span>}</div>}
    {(taskId || executionId || invalidContext) && <div className="nc-context"><Info size={15} /><span>{invalidContext ? '任务、执行批次或账号不存在，无法显示对应客户。' : <>当前范围：{selectedTask?.name || '关联任务'}{executionId && <> · {displayTime(execution?.startedAt)} 的执行批次</>}</>}</span><button className="wr-text-button" onClick={() => updateFilters({ task: undefined, execution: undefined })}><X size={13} />清除任务与批次筛选</button></div>}
    {incompleteExecution && executionAvailable && <div className="nc-context nc-incomplete" role="status"><Info size={16} /><div><strong>本次执行的客户明细数据尚未完整</strong><p>{stages.map(item => `${item.label}：执行汇总 ${execution[item.key]} 人 / 可追溯明细 ${executionAvailable[item.key]} 人`).join('；')}。</p><p>下方指标和列表仅展示可追溯记录，不补造客户或消息。上方时间筛选还会进一步限定首次发现日期。</p></div></div>}
    <div className="metric-grid wr-metric-grid">{stages.map(item => <button type="button" className={`metric-card wr-metric-card nc-metric-button ${item.color} ${stage === item.key ? 'nc-active-metric' : ''}`} key={item.key} aria-label={`查看${item.label}明细，共${total[item.key]}人`} onClick={() => drilldown(item.key)}><div className="wr-metric-label"><span>{item.label}</span><item.icon size={18} strokeWidth={1.6} /></div><div className="wr-metric-value">{total[item.key].toLocaleString()}<span>人</span></div><div className="wr-metric-definition">{item.definition}</div><span className="wr-metric-interval">{interval}<span>查看明细 <ArrowRight size={11} /></span></span></button>)}</div>
    <p className="wr-cohort-note"><Info size={14} /><span>{executionId ? '按当前执行批次归属展示；顶部时间筛选仍按客户首次发现时间生效。清除批次后恢复首次发现批次汇总。' : '按客户首次发现时间归属，后续触达与留资结果持续更新。'}</span></p>
    <section className="panel wr-funnel-panel"><div className="wr-panel-heading"><div><h2 className="section-title">找客转化漏斗</h2><p className="wr-section-description">同一批客户，四个阶段的进展。</p></div><span className="wr-quiet-label">{time === 'all' ? '全部发现批次' : range.from && range.to ? `${range.from.replaceAll('-', '.')} — ${range.to.replaceAll('-', '.')}` : '请选择时间范围'}</span></div>
      {total.analyzed === 0 ? <div className="empty-state wr-funnel-empty"><ScanSearch size={26} /><h3>{invalidRange ? '请选择有效的日期范围' : '这个范围内还没有结果'}</h3><p>没有符合筛选条件的发现批次，四项结果均为 0。</p><button className="button secondary" onClick={() => navigate('/chat')}>前往对话创建任务<ArrowRight size={14} /></button></div> : <div className="wr-funnel" aria-label="找客转化漏斗">{stages.map((stage, index) => {
        const previous = index > 0 ? stages[index - 1] : undefined;
        const width = index === 0 ? 100 : total[stage.key] / total.analyzed * 100;
        return <div className={`wr-funnel-row ${stage.color}`} key={stage.key}><button className="wr-funnel-stage nc-funnel-button" onClick={() => drilldown(stage.key)} aria-label={`查看漏斗${stage.label}明细`}><span className="wr-stage-index">0{index + 1}</span><span>{stage.label}</span><ChevronRight size={12} /></button><button className="wr-funnel-bar-track nc-funnel-button" onClick={() => drilldown(stage.key)} aria-label={`查看${total[stage.key]}位${stage.label}`}><span className="wr-funnel-bar" style={{ width: `${width}%` }} /><span className="wr-funnel-bar-value">{total[stage.key].toLocaleString()}<small> 人</small></span></button><div className="wr-funnel-rate">{previous ? <><span><ArrowDown size={12} />{percentage(total[stage.key], total[previous.key])}</span><small>{stage.label} / {previous.label}</small></> : <><span>100%</span><small>初始分析用户</small></>}</div></div>;
      })}<div className="wr-funnel-footnote">相邻阶段转化率按去重用户计算，条形长度表示该阶段占分析用户的比例。</div></div>}
    </section>
    <section className="panel wr-results-table-panel"><div className="wr-panel-heading"><div className="wr-heading-with-info"><h2 className="section-title">任务结果</h2><span className="wr-quiet-label">{tasks.length} 个任务</span></div><span className="wr-quiet-label">留资率 = 留资客户 / 成功触达</span></div><div className="table-wrap"><table className="data-table wr-results-table"><thead><tr><th>任务名称</th><th>所属抖音账号</th><th>分析用户</th><th>目标客户</th><th>成功触达</th><th>留资客户</th><th>留资率</th><th>任务状态</th><th><span className="wr-sr-only">操作</span></th></tr></thead><tbody>{tasks.map(task => {
      const account = state.accounts.find(item => item.id === task.accountId);
      const value = taskResults.get(task.id)!;
      return <tr key={task.id}><td><button className="wr-task-name" onClick={() => navigate(`/work/${task.id}`)}>{task.name}</button>{value.analyzed === 0 && <span className="wr-cell-subtitle">{state.executions.some(execution => execution.taskId === task.id) ? '本期无新发现用户' : '尚未执行'}</span>}</td><td><span className="wr-result-account">{account?.name || '账号不可用'}</span></td>{stages.map(item => <td key={item.key}><button className={`nc-number-link ${item.key === 'leads' ? 'wr-lead-number' : ''}`} aria-label={`查看${task.name}的${item.label}${value[item.key]}人`} onClick={() => drilldown(item.key, task.id)}>{value[item.key].toLocaleString()}</button></td>)}<td>{percentage(value.leads, value.contacted)}</td><td><TaskBadge task={task} /></td><td><button className="wr-text-button" aria-label={`查看${task.name}客户明细`} onClick={() => drilldown('analyzed', task.id)}>客户明细<ChevronRight size={14} /></button></td></tr>;
    })}</tbody></table></div>{tasks.length === 0 && <div className="empty-state wr-list-empty"><Users size={26} /><h3>还没有找客任务</h3><p>先创建任务，结果会随着执行逐步积累。</p><button className="button primary" onClick={() => navigate('/chat')}>前往对话创建任务<ArrowRight size={15} /></button></div>}<div className="wr-table-footer"><span>共 {tasks.length} 个任务</span><span><Info size={13} />各任务独立统计覆盖用户，任务行相加可能大于去重汇总。</span></div></section>
    <section className="panel nc-customers-panel" id="potential-customers" ref={detailSection} tabIndex={-1} aria-labelledby="potential-customers-title"><div className="wr-panel-heading"><div><h2 className="section-title" id="potential-customers-title">潜客明细 <span className="nc-count">{customerList.length} 人</span></h2><p className="wr-section-description">沿用上方账号、首次发现时间和任务范围；同一账号下按平台标识去重。</p></div><span className="wr-demo-label">演示数据</span></div>
      <div className="nc-list-filters"><label><span>状态</span><select className="select" aria-label="筛选潜客状态" value={stage} onChange={event => updateFilters({ stage: event.target.value })}>{statusFilters.map(item => <option value={item.key} key={item.key}>{item.label}</option>)}{stage === 'analyzed' && <option value="analyzed">分析用户</option>}{stage === 'targeted' && <option value="targeted">目标客户</option>}</select></label><label><span>任务</span><select className="select" aria-label="筛选潜客任务" value={taskId} onChange={event => updateFilters({ task: event.target.value, execution: undefined })}><option value="">全部任务</option>{availableTasks.map(task => <option value={task.id} key={task.id}>{task.name}</option>)}</select></label><label className="nc-search"><Search size={15} /><input className="field" value={search} aria-label="搜索潜客昵称或平台账号标识" placeholder="搜索昵称 / 抖音账号标识" onChange={event => updateFilters({ q: event.target.value })} />{search && <button className="wr-icon-button" aria-label="清除潜客搜索" onClick={() => updateFilters({ q: undefined })}><X size={14} /></button>}</label></div>
      <p className="nc-list-caption" role="status">{stageLabel} · 共 {customerList.length} 人{search && <> · 搜索「{search}」</>}{(stage === 'contacted' || stage === 'replied') && '（包含已进入后续状态的客户）'}</p>
      <div className="table-wrap"><table className="data-table nc-customer-table"><thead><tr><th>抖音客户 / 标识</th><th>所属任务</th><th>线索来源 / 匹配判断</th><th>当前状态</th><th>触达状态</th><th>最近触达</th><th>留资状态</th><th>操作</th></tr></thead><tbody>{visibleCustomers.map(customer => {
        const facts = customerFacts(customer);
        const source = customer.sources?.find(item => (!taskId || item.taskId === taskId) && (!executionId || item.executionId === executionId));
        const relatedTasks = customer.taskIds.filter(id => !taskId || id === taskId).map(id => state.tasks.find(task => task.id === id)?.name || '任务暂无数据');
        return <tr key={customerKey(customer)}><td><div className="nc-customer-cell"><CustomerAvatar customer={customer} /><div><strong>{customer.nickname || '昵称暂无数据'}</strong><span>{customer.platformId || '抖音标识暂无数据'}</span><small>演示数据</small></div></div>{!accountId && <span className="wr-cell-subtitle">{state.accounts.find(account => account.id === customer.accountId)?.name || '所属账号暂无数据'}</span>}</td><td><span className="nc-task-cell">{relatedTasks.join('、') || '暂无数据'}</span></td><td><span className="nc-source-type">{source?.type || '来源暂无数据'}{(customer.sources?.length || 0) > 1 && ` · ${customer.sources!.length} 条证据`}</span><p className="nc-match-summary">AI 分析：{source?.matchReason || '暂未找到充分依据'}</p></td><td><span className={`nc-status ${facts.lead ? 'lead' : ''}`}>{facts.status}</span></td><td><span className={`nc-contact-state ${facts.contactStatus === '发送失败' || facts.contactStatus === '状态待确认' ? 'attention' : ''}`}>{facts.contactStatus}</span></td><td className="nc-time-cell">{facts.lastContactAt ? displayTime(facts.lastContactAt) : '未触达'}</td><td><span className={facts.lead ? 'nc-lead-label' : 'muted'}>{facts.lead ? '已留资' : customer.leadAt || customer.leadEvidence ? '待确认' : '未留资'}</span></td><td><button className="wr-text-button" aria-label={`查看${customer.nickname || customer.platformId || '客户'}详情`} onClick={() => setSelectedCustomer(customerKey(customer))}>查看详情<ChevronRight size={13} /></button></td></tr>;
      })}</tbody></table></div>{customerList.length === 0 && <div className="empty-state wr-list-empty"><ScanSearch size={25} /><h3>{invalidRange ? '请选择有效的日期范围' : '没有符合筛选条件的客户'}</h3><p>{search ? '仅搜索已获取的昵称与平台账号标识；缺失字段不会推测补齐。' : '当前范围暂无可追溯客户记录，不会用虚构条目补齐统计。'}</p><button className="button secondary" onClick={() => updateFilters({ stage: 'all', q: undefined })}>清除状态与搜索</button></div>}<div className="wr-table-footer nc-pagination"><span>共 {customerList.length} 人 · 每页 10 人</span><div><button className="wr-icon-button" aria-label="上一页潜客" disabled={page <= 1} onClick={() => updateFilters({ page: String(page - 1) }, false)}><ChevronLeft size={15} /></button><span>{page} / {pageCount}</span><button className="wr-icon-button" aria-label="下一页潜客" disabled={page >= pageCount} onClick={() => updateFilters({ page: String(page + 1) }, false)}><ChevronRight size={15} /></button></div></div>
    </section>
    <p className="wr-bottom-note">留资仅统计有有效记录依据的客户；所有示例客户、来源、模拟发送、模拟回复与模拟留资均为演示数据，不包含真实联系方式。</p>
    {detail && <CustomerDetail customer={detail} state={state} onClose={() => setSelectedCustomer(undefined)} />}
  </div>;
}
