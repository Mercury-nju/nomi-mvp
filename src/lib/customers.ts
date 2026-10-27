import type { AppState, Customer, CustomerLeadEvidence, CustomerMessage, CustomerSource } from './types';

export interface CustomerFilters { accountId?: string; from?: string; to?: string; taskId?: string; executionId?: string }
export type CustomerStatus = '待触达' | '已触达' | '有回复' | '已留资' | '已排除';
export type ContactStatus = '未安排' | '待发送' | '发送成功' | '发送失败' | '不适用' | '状态待确认';
export interface CustomerSelection extends Customer {
  factScope?: Pick<CustomerFilters, 'taskId' | 'executionId'>;
  leadEvidenceRecords?: CustomerLeadEvidence[];
  legacyRecords?: Customer[];
}

const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
function day(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : dayFormatter.format(date);
}

function inScope(record: { taskId?: string; executionId?: string }, scope?: CustomerSelection['factScope']): boolean {
  return (!scope?.taskId || record.taskId === scope.taskId) && (!scope?.executionId || record.executionId === scope.executionId);
}

function unique<T extends { id: string; accountId?: string }>(records: T[]): T[] {
  return [...new Map(records.map(record => [`${record.accountId ?? ''}:${record.id}`, record])).values()];
}

/** Filter ownership before merging, so a scoped account never inherits another account's evidence. */
export function selectCustomers(state: AppState, filters: CustomerFilters = {}): CustomerSelection[] {
  const groups = new Map<string, Customer[]>();
  for (const customer of state.customers) {
    if (filters.accountId && filters.accountId !== 'all' && customer.accountId !== filters.accountId) continue;
    // An internal record ID is not proof of cross-account platform identity.
    const key = customer.platformId?.trim() ? `platform:${customer.platformId.trim()}` : `record:${customer.accountId}:${customer.id}`;
    const group = groups.get(key) ?? [];
    group.push(customer);
    groups.set(key, group);
  }
  const selected: CustomerSelection[] = [];
  for (const records of groups.values()) {
    const first = records.reduce((earliest, record) => record.discoveredAt < earliest.discoveredAt ? record : earliest);
    const sources = unique(records.flatMap(record => (record.sources ?? []).map(source => ({ ...source, accountId: source.accountId ?? record.accountId }))));
    const messages = unique(records.flatMap(record => (record.messages ?? []).map(message => ({ ...message, accountId: message.accountId ?? record.accountId })))).sort((a, b) => a.at.localeCompare(b.at));
    const taskIds = [...new Set(records.flatMap(record => [...record.taskIds, ...(record.sources ?? []).map(source => source.taskId)]))];
    const leadEvidenceRecords = records.flatMap(record => record.leadEvidence ? [{ ...record.leadEvidence, accountId: record.leadEvidence.accountId ?? record.accountId }] : []);
    const scope = { taskId: filters.taskId, executionId: filters.executionId };
    if (filters.taskId && !taskIds.includes(filters.taskId)) continue;
    if (filters.executionId && !sources.some(source => inScope(source, scope))) continue;
    const discoveredDay = day(first.discoveredAt);
    if ((filters.from && discoveredDay < filters.from.slice(0, 10)) || (filters.to && discoveredDay > filters.to.slice(0, 10))) continue;
    const legacyRecords = records.filter(record => record.messages === undefined);
    const scopedEvidence = leadEvidenceRecords.find(evidence => inScope(evidence, scope) || Boolean(evidence.messageId && messages.some(message => message.id === evidence.messageId && inScope(message, scope))));
    const merged: CustomerSelection = {
      ...first, taskIds, target: records.some(record => record.target),
      discoveredAt: first.discoveredAt,
      nickname: records.find(record => record.nickname)?.nickname,
      avatarUrl: records.find(record => record.avatarUrl)?.avatarUrl,
      profileUrl: records.find(record => record.profileUrl)?.profileUrl,
      exclusionReason: records.every(record => !record.target || record.exclusionReason) ? records.find(record => record.exclusionReason)?.exclusionReason : undefined,
      demo: records.every(record => record.demo === true),
      ...(records.some(record => record.sources !== undefined) ? { sources } : {}),
      ...(records.some(record => record.messages !== undefined) ? { messages } : {}),
      leadEvidence: scopedEvidence, leadEvidenceRecords, legacyRecords, factScope: scope,
    };
    selected.push(merged);
  }
  return selected;
}

/** Facts come from recorded events; generated/queued/unknown messages are never successful sends. */
export function customerFacts(customer: CustomerSelection) {
  const scope = customer.factScope;
  const sources: CustomerSource[] = (customer.sources ?? []).filter(source => inScope(source, scope));
  const messages: CustomerMessage[] = (customer.messages ?? []).filter(message => inScope(message, scope));
  const legacy = (customer.legacyRecords ?? (customer.messages === undefined ? [customer] : [])).filter(record => !scope?.executionId && (!scope?.taskId || record.taskIds.includes(scope.taskId)));
  const targeted = sources.length ? sources.some(source => source.targeted ?? customer.target) : (scope?.taskId || scope?.executionId) && legacy.length ? legacy.some(record => record.target) : customer.target;
  const successful = messages.filter(message => message.direction === 'outbound' && message.status === 'success' && message.text.trim() && day(message.at));
  const legacyContacts = legacy.filter(record => record.target && record.contactedAt && day(record.contactedAt));
  const contacted = targeted && (successful.length > 0 || legacyContacts.length > 0);
  const incoming = messages.filter(message => message.direction === 'inbound' && message.status === 'received' && message.text.trim() && day(message.at));
  const replied = incoming.length > 0;
  const evidenceRecords = customer.leadEvidenceRecords ?? (customer.leadEvidence ? [customer.leadEvidence] : []);
  const hasEvidence = evidenceRecords.some(evidence => {
    if (!evidence.text.trim() || !day(evidence.at)) return false;
    if (evidence.messageId) return incoming.some(message => message.id === evidence.messageId && (!evidence.accountId || message.accountId === evidence.accountId));
    return inScope(evidence, scope);
  });
  const lead = contacted && (hasEvidence || legacy.some(record => record.target && record.contactedAt && record.leadAt && day(record.leadAt) && record.evidence?.trim()));
  const attempted = messages.filter(message => message.direction === 'outbound' && message.status !== 'queued' && message.text.trim() && day(message.at));
  const lastContactAt = [...attempted.map(message => message.at), ...legacyContacts.map(record => record.contactedAt!)].sort().at(-1);
  const latest = messages.filter(message => message.direction === 'outbound').at(-1);
  const contactApplicable = targeted && !customer.exclusionReason && (!sources.length || sources.some(source => source.contactApplicable !== false));
  const contactStatus: ContactStatus = contacted ? '发送成功' : !targeted || !contactApplicable ? '不适用' : latest?.status === 'failed' ? '发送失败' : latest?.status === 'unknown' ? '状态待确认' : latest?.status === 'queued' ? '待发送' : '未安排';
  const status: CustomerStatus = customer.exclusionReason || !targeted ? '已排除' : lead ? '已留资' : replied ? '有回复' : contacted ? '已触达' : '待触达';
  return { targeted, contacted, lead, replied, status, contactStatus, lastContactAt };
}
