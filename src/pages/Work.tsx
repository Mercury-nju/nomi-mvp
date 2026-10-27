import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, CalendarClock, Check, CheckCircle2, ChevronRight, Clock3, ExternalLink, Info, Pause, Play, Plus, Search, SlidersHorizontal, TriangleAlert, Users, XCircle } from 'lucide-react';
import { useStore } from '../lib/store';
import { metrics, setTaskEnabled, todayContacts } from '../lib/domain';
import { customerFacts, selectCustomers } from '../lib/customers';
import type { Account, Execution, Task, TaskStatus } from '../lib/types';
import './WorkResults.css';

const taskStatuses: Record<TaskStatus, { label: string; color: string }> = {
  running: { label: '正常运行', color: 'green' },
  paused: { label: '已暂停', color: 'gray' },
  error: { label: '运行异常', color: 'orange' },
};
const executionStatuses: Record<Execution['status'], { label: string; color: string }> = {
  pending: { label: '待执行', color: 'gray' },
  running: { label: '执行中', color: 'blue' },
  completed: { label: '已完成', color: 'green' },
  partial: { label: '部分完成', color: 'orange' },
  failed: { label: '执行失败', color: 'red' },
};
const resultFields = [
  { key: 'analyzed', label: '分析用户' },
  { key: 'targeted', label: '目标客户' },
  { key: 'contacted', label: '成功触达' },
  { key: 'leads', label: '留资客户' },
] as const;

function customerResultsUrl(task: Task, stage: typeof resultFields[number]['key'] = 'analyzed', executionId?: string) {
  const params = new URLSearchParams({ account: task.accountId, task: task.id, stage, returnTo: `/work/${task.id}` });
  if (executionId) params.set('execution', executionId);
  return `/results?${params.toString()}#potential-customers`;
}

function displayDate(value: string, includeYear = false) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', ...(includeYear ? { year: 'numeric' as const } : {}),
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value));
}

function nextRun(task: Task, account: Account | undefined) {
  if (!account?.connected) return '等待账号重新登录';
  if (task.status !== 'running' || !task.enabled) return '暂无';
  const time = task.schedule.match(/(\d{1,2}):(\d{2})/);
  if (!time) return task.schedule;
  const now = new Date();
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  let next = new Date(`${date}T${time[1].padStart(2, '0')}:${time[2]}:00+08:00`);
  if (next.getTime() <= now.getTime()) next = new Date(next.getTime() + 86400000);
  return displayDate(next.toISOString());
}

export function TaskBadge({ task }: { task: Task }) {
  const status = taskStatuses[task.status];
  return <span className={`badge ${status.color} wr-task-badge`}><span className="wr-status-dot" />{status.label}</span>;
}

function AccountLabel({ account }: { account?: Account }) {
  if (!account) return <span className="muted">账号不可用</span>;
  return <span className="wr-account-label"><span className="wr-mini-avatar" style={{ background: account.color }}>{account.initials}</span><span>{account.name}</span></span>;
}

export default function Work() {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { state, transact, selectAccount, notify } = useStore();
  const [accountFilter, setAccountFilter] = useState(() => searchParams.get('account') || '');
  const [statusFilter, setStatusFilter] = useState<TaskStatus | ''>('');
  const [selectedExecution, setSelectedExecution] = useState<string>('');
  const task = state.tasks.find(item => item.id === taskId);

  function adjustTask(item: Task) {
    selectAccount(item.accountId);
    navigate(`/chat?task=${item.id}`);
  }

  function toggleTask(item: Task) {
    const account = state.accounts.find(a => a.id === item.accountId);
    if (!account?.connected && !item.enabled) {
      notify('请先重新登录抖音账号，再恢复任务');
      navigate('/douyin-accounts');
      return;
    }
    try {
      const success = transact(draft => { setTaskEnabled(draft, item.id, !item.enabled); });
      if (success) notify(item.enabled ? '任务已暂停，历史执行与结果已保留' : '任务已恢复，将按计划执行');
    } catch (error) {
      notify(error instanceof Error ? error.message : '操作失败，请重试');
    }
  }

  if (taskId && !task) return <div className="empty-state wr-not-found"><Search size={28} /><h2>没有找到这个任务</h2><p>任务可能不在当前演示数据中。</p><button className="button secondary" onClick={() => navigate('/work')}>返回任务列表</button></div>;

  if (task) {
    const account = state.accounts.find(a => a.id === task.accountId);
    const executions = state.executions.filter(item => item.taskId === task.id).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const execution = executions.find(item => item.id === selectedExecution) || executions[0];
    const result = metrics(state, task.accountId, undefined, undefined, task.id);
    const executionCounts = new Map(executions.map(item => {
      const customers = selectCustomers(state, { accountId: task.accountId, taskId: task.id, executionId: item.id });
      const actual = customers.reduce((counts, customer) => {
        const facts = customerFacts(customer);
        counts.targeted += Number(facts.targeted);
        counts.contacted += Number(facts.contacted);
        counts.leads += Number(facts.lead);
        return counts;
      }, { analyzed: customers.length, targeted: 0, contacted: 0, leads: 0 });
      return [item.id, { actual, complete: resultFields.every(field => actual[field.key] === item[field.key]) }] as const;
    }));
    const reconciliation = execution ? executionCounts.get(execution.id) : undefined;
    return <div className="page wr-page wr-detail">
      <button className="wr-back" onClick={() => navigate('/work')}><ArrowLeft size={16} />返回任务列表</button>
      <header className="page-header wr-detail-header">
        <div><div className="eyebrow">TASK / {task.id}</div><div className="wr-detail-title"><h1 className="page-title">{task.name}</h1><TaskBadge task={task} /></div><div className="wr-detail-subtitle"><AccountLabel account={account} /><span className="wr-dot-divider">·</span><span>创建于 {displayDate(task.createdAt, true)}</span></div></div>
        <div className="wr-header-actions"><button className="button secondary" onClick={() => toggleTask(task)}>{task.enabled ? <Pause size={15} /> : <Play size={15} />}{task.enabled ? '暂停任务' : '恢复任务'}</button><button className="button primary" onClick={() => adjustTask(task)}><SlidersHorizontal size={15} />调整任务</button></div>
      </header>
      {!account?.connected && <div className="wr-alert"><TriangleAlert size={18} /><div><strong>抖音账号已掉线，任务暂时无法执行</strong><p>重新登录后可按原计划继续；已有结果会保留，掉线期间的私信不会补发。</p></div><button className="button secondary" onClick={() => navigate('/douyin-accounts')}>重新登录<ArrowRight size={14} /></button></div>}
      <section className="panel wr-overview">
        <div className="wr-panel-heading"><h2 className="section-title">任务概况</h2><span className="wr-quiet-label"><CheckCircle2 size={14} />已确认的执行方案</span></div>
        <div className="wr-objective"><span className="wr-field-label">找客目标</span><p>{task.target}</p></div>
        <dl className="wr-config-grid"><div><dt>地区</dt><dd>{task.region || '不限地区'}</dd></div><div><dt>寻找渠道</dt><dd>{task.source}</dd></div><div><dt>执行周期</dt><dd>{task.schedule}</dd></div><div><dt>关键词 / 需求信号</dt><dd>{task.signals || '未单独设置'}</dd></div><div><dt>每日计划触达</dt><dd>{task.dailyQuota}<span className="muted"> 人 / 天</span></dd></div><div><dt>触达模式</dt><dd>{task.mode === 'find' ? '仅找客' : '找客并触达 · 抖音私信'}</dd></div></dl>
        <div className="wr-overview-foot"><Info size={14} /><span>调整仅影响未来执行，历史结果与已发送记录会保留。</span><span className="wr-next-label">下次执行：{nextRun(task, account)}</span></div>
      </section>
      <div className="wr-result-summary"><span>任务累计结果</span>{resultFields.map(field => <div key={field.key}><button className="wr-table-link" onClick={() => navigate(customerResultsUrl(task, field.key))} aria-label={`查看本任务${field.label}明细`}><strong>{result[field.key].toLocaleString()}</strong> {field.label}</button></div>)}<button className="wr-text-button" onClick={() => navigate(customerResultsUrl(task))}>查看结果中心<ExternalLink size={13} /></button></div>
      <section className="panel wr-execution-panel">
        <div className="wr-panel-heading"><div className="wr-heading-with-info"><h2 className="section-title">{execution && execution.id !== executions[0]?.id ? '历史执行详情' : '最近一次执行'}</h2>{execution && <span className="wr-quiet-label">{displayDate(execution.startedAt, true)}</span>}<span className="wr-demo-label">演示数据</span></div>{execution && <span className={`badge ${executionStatuses[execution.status].color}`}>{executionStatuses[execution.status].label}</span>}</div>
        {!execution ? <div className="empty-state wr-small-empty"><CalendarClock size={27} /><h3>尚未执行</h3><p>任务已保存，执行记录会在首轮运行后出现在这里。</p><span className="wr-quiet-label">下次执行：{nextRun(task, account)}</span></div> : <>
          <div className="wr-execution-metrics">{resultFields.map(field => <div key={field.key}><button className="wr-table-link" onClick={() => navigate(customerResultsUrl(task, field.key, execution.id))} aria-label={`查看本轮${field.label}明细`}><span>{field.label}</span><strong>{execution[field.key].toLocaleString()}<small> 人</small></strong></button></div>)}</div>
          {reconciliation && !reconciliation.complete && <div className="wr-execution-reason" role="status"><TriangleAlert size={15} /><div><strong>数据尚未完整</strong><p>当前可核验：分析 {reconciliation.actual.analyzed} 人、目标 {reconciliation.actual.targeted} 人、成功触达 {reconciliation.actual.contacted} 人、留资 {reconciliation.actual.leads} 人。执行汇总与已关联客户记录不一致，缺少执行归属的旧记录不计入本轮明细。</p></div></div>}
          {execution.reason && <div className="wr-execution-reason"><TriangleAlert size={15} />{execution.reason}</div>}
          <div className="wr-timeline" aria-label="执行步骤">{execution.steps.map((step, index) => <div className={`wr-step ${step.status}`} key={`${step.name}-${index}`}><span className="wr-step-icon">{step.status === 'completed' ? <Check size={14} /> : step.status === 'failed' ? <XCircle size={14} /> : <Clock3 size={14} />}</span><div><strong>{step.name}</strong><span>{step.time || '尚未执行'}</span>{step.reason && <p>{step.reason}</p>}</div></div>)}</div>
          <div className="wr-table-footer"><span>仅展示本次执行已关联的客户记录</span><button className="wr-text-button" onClick={() => navigate(customerResultsUrl(task, 'analyzed', execution.id))}>查看本轮潜客<ExternalLink size={13} /></button></div>
        </>}
      </section>
      <section className="panel wr-history-panel"><div className="wr-panel-heading"><h2 className="section-title">历史执行记录</h2><span className="wr-quiet-label">演示数据 · 共 {executions.length} 次 · 点击记录查看执行步骤</span></div><div className="table-wrap"><table className="data-table wr-history-table"><thead><tr><th>开始时间</th><th>分析用户</th><th>目标客户</th><th>成功触达</th><th>留资客户</th><th>执行状态</th><th>详情</th></tr></thead><tbody>{executions.map(item => {
        const counts = executionCounts.get(item.id)!;
        return <tr key={item.id} className={execution?.id === item.id ? 'wr-selected-row' : ''}><td><button className="wr-table-link" onClick={() => setSelectedExecution(item.id)}>{displayDate(item.startedAt, true)}</button></td>{resultFields.map(field => <td key={field.key}><button className="wr-table-link" onClick={() => navigate(customerResultsUrl(task, field.key, item.id))} aria-label={`查看 ${displayDate(item.startedAt)} 的${field.label}明细`}>{item[field.key].toLocaleString()}</button>{!counts.complete && <span className="wr-cell-subtitle">可核验 {counts.actual[field.key]} 人</span>}</td>)}<td><span className={`badge ${executionStatuses[item.status].color}`}>{executionStatuses[item.status].label}</span>{!counts.complete && <span className="wr-cell-subtitle">数据尚未完整</span>}</td><td><div className="wr-row-actions"><button className="wr-text-button" onClick={() => navigate(customerResultsUrl(task, 'analyzed', item.id))}>查看该次执行的客户明细<ExternalLink size={13} /></button><button className="wr-icon-button" onClick={() => setSelectedExecution(item.id)} aria-label={`查看 ${displayDate(item.startedAt)} 的执行详情`}><ChevronRight size={16} /></button></div></td></tr>;
      })}{executions.length === 0 && <tr><td colSpan={7} className="wr-table-empty">暂无历史执行记录</td></tr>}</tbody></table></div></section>
      <p className="wr-bottom-note">所有执行与结果均为演示记录，未连接真实抖音私信。</p>
    </div>;
  }

  const accountTasks = state.tasks.filter(item => !accountFilter || item.accountId === accountFilter);
  const filteredTasks = accountTasks.filter(item => !statusFilter || item.status === statusFilter);
  const filterTabs: { value: TaskStatus | ''; label: string }[] = [{ value: '', label: '全部任务' }, { value: 'running', label: '正常运行' }, { value: 'paused', label: '已暂停' }, { value: 'error', label: '异常' }];
  return <div className="page wr-page">
    <header className="page-header"><div><div className="eyebrow">WORKSPACE</div><h1 className="page-title">定时任务中心</h1><p className="page-description">把找客交给计划，每一次执行都有迹可循。</p></div><button className="button primary" onClick={() => navigate('/chat')}><Plus size={16} />创建任务</button></header>
    <div className="wr-work-intro"><div className="wr-work-intro-icon"><CalendarClock size={21} /></div><div><strong>计划就绪，工作持续推进</strong><p>共 {state.tasks.length} 个任务，{state.tasks.filter(item => item.status === 'running').length} 个正常运行。执行结果将记录在对应任务中。</p></div></div>
    <section className="panel wr-work-table-panel">
      <div className="wr-work-toolbar"><div className="wr-filter-tabs" aria-label="任务状态筛选">{filterTabs.map(tab => <button key={tab.value} aria-pressed={statusFilter === tab.value} className={statusFilter === tab.value ? 'active' : ''} onClick={() => setStatusFilter(tab.value)}>{tab.label}<span>{tab.value ? accountTasks.filter(item => item.status === tab.value).length : accountTasks.length}</span></button>)}</div><select className="select wr-account-select" aria-label="筛选任务所属抖音账号" value={accountFilter} onChange={event => setAccountFilter(event.target.value)}><option value="">全部抖音账号</option>{state.accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></div>
      <div className="table-wrap"><table className="data-table wr-work-table"><thead><tr><th>任务 / 找客目标</th><th>所属账号</th><th>每日计划</th><th>今日触达</th><th>任务状态</th><th>执行安排</th><th>操作</th></tr></thead><tbody>{filteredTasks.map(item => {
        const account = state.accounts.find(a => a.id === item.accountId);
        const lastExecution = state.executions.filter(execution => execution.taskId === item.id).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
        const contacts = todayContacts(state, item.accountId, item.id);
        return <tr key={item.id}><td><button className="wr-task-name" onClick={() => navigate(`/work/${item.id}`)}>{item.name}</button><p className="wr-task-target" title={item.target}>{item.target}</p></td><td><AccountLabel account={account} /></td><td><span className="wr-quota-number">{item.dailyQuota}</span><span className="muted"> 人 / 天</span>{item.mode === 'find' && <span className="wr-cell-subtitle">仅找客</span>}</td><td><span className="wr-contact-progress"><strong>{contacts}</strong><span> / {item.dailyQuota}</span></span><div className="wr-progress-track"><span style={{ width: `${item.dailyQuota ? Math.min(contacts / item.dailyQuota * 100, 100) : 0}%` }} /></div></td><td><TaskBadge task={item} />{!account?.connected && <button className="wr-reconnect-link" onClick={() => navigate('/douyin-accounts')}>账号掉线 · 重新登录</button>}</td><td className="wr-schedule-cell"><span>{item.schedule}</span><span>最近：{lastExecution ? displayDate(lastExecution.startedAt) : '尚未执行'}</span><span>下次：{nextRun(item, account)}</span></td><td><div className="wr-row-actions"><button className="wr-text-button" onClick={() => navigate(`/work/${item.id}`)}>查看详情<ChevronRight size={13} /></button><div><button className="wr-icon-button" onClick={() => toggleTask(item)} aria-label={`${item.enabled ? '暂停' : '恢复'}${item.name}`} title={item.enabled ? '暂停任务' : '恢复任务'}>{item.enabled ? <Pause size={15} /> : <Play size={15} />}</button><button className="wr-icon-button" onClick={() => adjustTask(item)} aria-label={`调整${item.name}`} title="通过对话调整任务"><SlidersHorizontal size={15} /></button></div></div></td></tr>;
      })}</tbody></table></div>
      {filteredTasks.length === 0 && <div className="empty-state wr-list-empty"><Users size={30} /><h3>{state.tasks.length === 0 ? '从第一个找客任务开始' : '这个范围内还没有任务'}</h3><p>{state.tasks.length === 0 ? '描述你想找的客户，确认方案后即可创建定时任务。' : '切换账号或任务状态，查看其他任务。'}</p><button className="button primary" onClick={() => { if (accountFilter) selectAccount(accountFilter); navigate('/chat'); }}>开始找客户<ArrowRight size={15} /></button></div>}
      <div className="wr-table-footer"><span>共 {filteredTasks.length} 个任务</span><span><Info size={13} />暂停的任务仍保留计划额度；今日触达按实际发送时间统计。</span></div>
    </section>
    <p className="wr-bottom-note"><Clock3 size={13} />正常运行表示任务已启用，等待或执行下一轮。演示环境不会自动发送私信。</p>
  </div>;
}
