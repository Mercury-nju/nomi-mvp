import type { Customer } from './types';

/** Scope judgments without discarding the customer's traceable complete history. */
export function customerInTask(customer: Customer, taskId: string): Customer {
  if (!taskId) return customer;
  const match = customer.matches?.[taskId] ?? { status: 'uncertain', reasons: [], missing: ['当前任务尚未保存可核对的匹配判断。'] };
  return { ...customer, match, target: match.status === 'matched' };
}
export function taskSources(customer: Customer, taskId: string) {
  return (customer.sources || []).filter(source => !taskId || source.taskId === taskId);
}
export function taskMessages(customer: Customer, taskId: string) {
  return (customer.messages || []).filter(message => !taskId || message.taskId === taskId);
}
export function filterCustomers(customers: Customer[], taskId: string, matchStatus: string, search: string): Customer[] {
  const term = search.toLowerCase();
  return customers.filter(customer => !taskId || customer.taskIds?.includes(taskId)).map(customer => customerInTask(customer, taskId)).filter(customer =>
    (matchStatus === 'all' || customer.match?.status === matchStatus) && (!term || `${customer.nickname || ''} ${customer.platformId || ''} ${taskSources(customer,taskId).map(source => source.text || '').join(' ')}`.toLowerCase().includes(term)));
}
