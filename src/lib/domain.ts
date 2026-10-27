import type { AppState, Knowledge, Metrics, Plan, Task, TaskInput } from './types';
import { customerFacts, selectCustomers } from './customers';

export function uid(prefix: string): string {
  return `${prefix}-${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
}

export function emptyKnowledge(): Knowledge {
  return { identity: '', brand: '', region: '', service: '', advantage: '', audience: '', purpose: '', style: '', goal: '', cautions: '', products: [] };
}

export function allocation(state: AppState, accountId: string): number {
  return state.tasks.filter(task => task.accountId === accountId).reduce((sum, task) => sum + task.dailyQuota, 0);
}

export function accountRevision(state: AppState, accountId: string): string {
  const account = state.accounts.find(item => item.id === accountId);
  return JSON.stringify({ account, knowledge: state.knowledge[accountId], tasks: state.tasks.filter(task => task.accountId === accountId).map(task => ({ id: task.id, revision: task.revision, dailyQuota: task.dailyQuota, status: task.status })).sort((a, b) => a.id.localeCompare(b.id)) });
}

function quota(value: number): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) throw new Error('每日触达人数必须是大于或等于 0 的整数。');
}

function validatePlan(plan: Omit<Plan, 'authorized'>): void {
  for (const key of ['name', 'target', 'region', 'signals', 'source', 'schedule'] as const) {
    if (!plan[key]?.trim()) throw new Error('请补齐任务名称、客户目标、地区、意向信号、渠道与执行时间。');
  }
  if (plan.mode !== 'find' && plan.mode !== 'contact') throw new Error('请选择有效的找客模式。');
  quota(plan.dailyQuota);
  if (plan.mode === 'find' && plan.dailyQuota !== 0) throw new Error('仅找客任务的每日触达计划必须为 0。');
}

function plannedTasks(state: AppState, accountId: string, allocations: Record<string, number> = {}): Task[] {
  const tasks = state.tasks.filter(task => task.accountId === accountId).map(task => ({ ...task }));
  for (const [id, value] of Object.entries(allocations)) {
    const task = tasks.find(item => item.id === id);
    if (!task) throw new Error('额度分配包含不存在或属于其他账号的任务，请重新确认。');
    quota(value);
    if (task.mode === 'find' && value > 0) throw new Error('仅找客任务不能分配触达额度，请先调整触达模式。');
    if (task.dailyQuota !== value) {
      task.dailyQuota = value;
      task.revision += 1;
    }
  }
  return tasks;
}

function validateTotal(state: AppState, accountId: string, tasks: Task[]): void {
  const account = state.accounts.find(item => item.id === accountId);
  if (!account) throw new Error('找不到所选抖音账号，请重新选择。');
  if (tasks.reduce((sum, task) => sum + task.dailyQuota, 0) > account.limit) throw new Error(`该账号每日计划触达上限为 ${account.limit} 人，请先调整额度分配。`);
}

function commitPlans(state: AppState, tasks: Task[]): void {
  for (const task of tasks) {
    const index = state.tasks.findIndex(item => item.id === task.id);
    if (index >= 0) state.tasks[index] = task;
    else state.tasks.push(task);
  }
}

export function createTask(state: AppState, input: TaskInput, allocations?: Record<string, number>): Task {
  const account = state.accounts.find(item => item.id === input.accountId);
  if (!account) throw new Error('请先选择抖音账号。');
  if (!account.connected) throw new Error('该抖音账号已掉线，请先重新登录后再创建任务。');
  const plan = { ...input, dailyQuota: input.mode === 'find' ? 0 : input.dailyQuota };
  validatePlan(plan);
  if (plan.mode === 'contact' && !plan.authorized) throw new Error('请明确授权本任务按确认的范围自动私信触达。');
  const task: Task = {
    id: uid('task'), accountId: input.accountId, conversationId: input.conversationId,
    name: plan.name.trim(), target: plan.target.trim(), region: plan.region.trim(), signals: plan.signals.trim(),
    source: plan.source.trim(), schedule: plan.schedule.trim(), dailyQuota: plan.dailyQuota, mode: plan.mode,
    enabled: true, status: 'running', createdAt: new Date().toISOString(), revision: 1,
    ...(plan.communicationStrategy !== undefined ? { communicationStrategy: plan.communicationStrategy.trim() } : {}),
  };
  const tasks = [...plannedTasks(state, input.accountId, allocations), task];
  validateTotal(state, input.accountId, tasks);
  commitPlans(state, tasks);
  return task;
}

export function updateTask(state: AppState, id: string, patch: Partial<Plan>, allocations?: Record<string, number>): Task {
  const original = state.tasks.find(task => task.id === id);
  if (!original) throw new Error('任务不存在，请返回任务列表重试。');
  const tasks = plannedTasks(state, original.accountId, allocations);
  const task = tasks.find(item => item.id === id)!;
  for (const key of ['name', 'target', 'region', 'signals', 'source', 'schedule', 'dailyQuota', 'mode', 'communicationStrategy'] as const) {
    if (patch[key] !== undefined) Object.assign(task, { [key]: patch[key] });
  }
  if (task.mode === 'find') task.dailyQuota = 0;
  validatePlan(task);
  if (task.mode === 'contact' && (patch.authorized === false || (original.mode === 'find' && !patch.authorized))) throw new Error('请先授权该任务的自动私信触达。');
  validateTotal(state, original.accountId, tasks);
  task.revision = Math.max(task.revision, original.revision) + 1;
  commitPlans(state, tasks);
  return task;
}

export function setTaskEnabled(state: AppState, id: string, enabled: boolean): void {
  const task = state.tasks.find(item => item.id === id);
  if (!task) throw new Error('任务不存在。');
  const account = state.accounts.find(item => item.id === task.accountId);
  if (!account) throw new Error('所属抖音账号不存在。');
  if (enabled && !account.connected) throw new Error('抖音账号已掉线，请先重新登录后再恢复任务。');
  if (enabled) validateTotal(state, account.id, state.tasks.filter(item => item.accountId === account.id));
  task.enabled = enabled;
  task.status = enabled ? 'running' : 'paused';
  task.revision += 1;
}

export function setAccountConnected(state: AppState, id: string, connected: boolean): void {
  const account = state.accounts.find(item => item.id === id);
  if (!account) throw new Error('抖音账号不存在。');
  if (connected) validateTotal(state, id, state.tasks.filter(task => task.accountId === id));
  account.connected = connected;
  for (const task of state.tasks.filter(item => item.accountId === id)) {
    task.status = task.enabled ? (connected ? 'running' : 'error') : 'paused';
    task.revision += 1;
  }
}

const shanghaiFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });

export function shanghaiDay(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return shanghaiFormatter.format(date);
}

export function todayContacts(state: AppState, accountId?: string, taskId?: string): number {
  const today = shanghaiDay(new Date());
  return selectCustomers(state, { accountId, taskId }).filter(customer => {
    if (!customerFacts(customer).contacted) return false;
    if ((customer.messages ?? []).some(message => message.direction === 'outbound' && message.status === 'success' && message.text.trim() && (!taskId || message.taskId === taskId) && shanghaiDay(message.at) === today)) return true;
    return (customer.legacyRecords ?? []).some(record => record.target && record.contactedAt && (!taskId || record.taskIds.includes(taskId)) && shanghaiDay(record.contactedAt) === today);
  }).length;
}

export function metrics(state: AppState, accountId?: string, from?: string, to?: string, taskId?: string): Metrics {
  const result = { analyzed: 0, targeted: 0, contacted: 0, leads: 0 };
  for (const customer of selectCustomers(state, { accountId, from, to, taskId })) {
    const facts = customerFacts(customer);
    result.analyzed += 1;
    if (facts.targeted) result.targeted += 1;
    if (facts.contacted) result.contacted += 1;
    if (facts.lead) result.leads += 1;
  }
  return result;
}
