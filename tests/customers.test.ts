import { describe, expect, it } from 'vitest';
import { customerFacts, selectCustomers } from '../src/lib/customers';
import { metrics, updateTask } from '../src/lib/domain';
import { createSeed } from '../src/lib/seed';
import { restoreState } from '../src/lib/store';
import type { Customer, CustomerMessage } from '../src/lib/types';

const at = '2026-10-23T02:00:00Z';
const source = { id: 'source-1', taskId: 'T1', executionId: 'E1', type: '作品评论', discoveredAt: at, targeted: true, contactApplicable: true };
const send: CustomerMessage = { id: 'M1', taskId: 'T1', executionId: 'E1', direction: 'outbound', text: '完整实际消息', at, status: 'success', demo: true };
const base: Customer = { id: 'C1', accountId: 'A1', platformId: 'P1', taskIds: ['T1'], target: true, discoveredAt: at, sources: [source], messages: [], demo: true };

describe('customer fact semantics', () => {
  it('never counts planned, failed, empty, or unconfirmed sends as a successful contact', () => {
    for (const status of ['queued', 'failed', 'unknown'] as const) {
      const customer = { ...base, contactedAt: at, messages: [{ ...send, status }] };
      expect(customerFacts(customer).contacted).toBe(false);
      expect(customerFacts(customer).contactStatus).toBe(({ queued: '待发送', failed: '发送失败', unknown: '状态待确认' })[status]);
      expect(customerFacts(customer).lastContactAt).toBe(status === 'queued' ? undefined : at);
    }
    expect(customerFacts({ ...base, messages: [{ ...send, text: '' }] }).contacted).toBe(false);
    expect(customerFacts({ ...base, messages: [{ ...send, at: 'invalid' }] }).contacted).toBe(false);
    expect(customerFacts({ ...base, sources: [{ ...source, contactApplicable: false }] }).contactStatus).toBe('不适用');
  });

  it('requires an actual reply and traceable evidence, rather than interest or a lead timestamp', () => {
    const reply: CustomerMessage = { ...send, id: 'R1', direction: 'inbound', status: 'received', text: '可以介绍一下吗？' };
    const customer: Customer = { ...base, messages: [send, reply], leadAt: at };
    expect(customerFacts(customer)).toMatchObject({ contacted: true, replied: true, lead: false, status: '有回复' });
    expect(customerFacts({ ...customer, leadEvidence: { text: '联系方式明确提供', at, messageId: 'unknown', demo: true } }).lead).toBe(false);
    expect(customerFacts({ ...customer, leadEvidence: { text: '用户主动提供演示联系方式并同意联系', at, messageId: reply.id, demo: true } })).toMatchObject({ lead: true, status: '已留资' });
    expect(customerFacts({ ...base, messages: [{ ...reply, text: '' }] }).replied).toBe(false);
    expect(customerFacts({ ...base, messages: [{ ...reply, at: 'invalid' }] }).replied).toBe(false);
  });

  it('preserves historic successful facts when the customer later declines further contact', () => {
    const customer = { ...base, messages: [send], exclusionReason: '用户明确拒绝后续联系' };
    expect(customerFacts(customer)).toMatchObject({ targeted: true, contacted: true, status: '已排除', contactStatus: '发送成功' });
  });

  it('retains legacy aggregate facts while leaving missing history empty', () => {
    const legacy: Customer = { id: 'legacy', accountId: 'A1', taskIds: ['T1'], target: true, discoveredAt: at, contactedAt: at, leadAt: at, evidence: '历史有效依据' };
    const state = createSeed();
    state.customers = [legacy];
    const selected = selectCustomers(state)[0];
    expect(customerFacts(selected)).toMatchObject({ contacted: true, lead: true, replied: false });
    expect(selected.messages).toBeUndefined();
    expect(selected.sources).toBeUndefined();
    expect(selectCustomers(state, { executionId: 'E1' })).toEqual([]);
    expect(customerFacts({ ...legacy, leadAt: 'invalid' }).lead).toBe(false);
  });
});

describe('deduplication and filter provenance', () => {
  it('merges repeated platform identities and keeps distinct evidence, tasks, and message history', () => {
    const state = createSeed();
    state.customers = [
      { ...base, messages: [send] },
      { ...base, id: 'second-observation', taskIds: ['T2'], sources: [{ ...source, id: 'source-2', taskId: 'T2', executionId: 'E2', discoveredAt: '2026-10-24T02:00:00Z' }], messages: [{ ...send, id: 'M2', taskId: 'T2', executionId: 'E2', status: 'failed' }] },
    ];
    const all = selectCustomers(state);
    expect(all).toHaveLength(1);
    expect(all[0].sources).toHaveLength(2);
    expect(all[0].messages).toHaveLength(2);
    expect(all[0].taskIds).toEqual(['T1', 'T2']);
    expect(customerFacts(all[0]).contacted).toBe(true);
    const round = selectCustomers(state, { taskId: 'T2', executionId: 'E2' });
    expect(round).toHaveLength(1);
    expect(customerFacts(round[0])).toMatchObject({ contacted: false, contactStatus: '发送失败' });
    expect(round[0].messages).toHaveLength(2);
    expect(selectCustomers(state, { from: '2026-10-24', to: '2026-10-24' })).toEqual([]);
    expect(selectCustomers(state, { executionId: 'E2' })).toHaveLength(1);
    expect(selectCustomers(state, { taskId: 'T1', executionId: 'E2' })).toEqual([]);
  });

  it('deduplicates reliable global identity but filters account ownership before merging evidence', () => {
    const state = createSeed();
    state.customers = [
      { ...base, messages: [] },
      { ...base, id: 'A2-record', accountId: 'A2', taskIds: ['T3'], sources: [{ ...source, id: 'A2-source', taskId: 'T3' }], messages: [{ ...send, id: 'A2-message', taskId: 'T3' }] },
    ];
    expect(metrics(state)).toEqual({ analyzed: 1, targeted: 1, contacted: 1, leads: 0 });
    const own = selectCustomers(state, { accountId: 'A1' });
    expect(own).toHaveLength(1);
    expect(own[0].sources?.every(item => item.accountId === 'A1')).toBe(true);
    expect(own[0].messages).toEqual([]);
    expect(metrics(state, 'A1').contacted).toBe(0);
    expect(selectCustomers(state)[0].messages?.[0].accountId).toBe('A2');
    state.customers = state.customers.map(customer => ({ ...customer, id: 'same-internal-id', platformId: undefined }));
    expect(selectCustomers(state)).toHaveLength(2);
  });
});

describe('demonstration consistency and compatible storage', () => {
  it('reconciles all seeded execution rounds with the same scoped customer facts and fixed baseline', () => {
    const state = createSeed();
    expect(metrics(state)).toEqual({ analyzed: 3860, targeted: 550, contacted: 355, leads: 47 });
    // Leave space below the common 5 MiB localStorage limit for new conversations and edits.
    expect(JSON.stringify(state).length * 2).toBeLessThan(4.5 * 1024 * 1024);
    expect(state.customers.length).toBeGreaterThan(selectCustomers(state).length);
    for (const run of state.executions) {
      const customers = selectCustomers(state, { taskId: run.taskId, executionId: run.id });
      const facts = customers.map(customerFacts);
      expect({ analyzed: customers.length, targeted: facts.filter(item => item.targeted).length, contacted: facts.filter(item => item.contacted).length, leads: facts.filter(item => item.lead).length }).toEqual({ analyzed: run.analyzed, targeted: run.targeted, contacted: run.contacted, leads: run.leads });
    }
    const customers = selectCustomers(state);
    for (const status of ['发送失败', '状态待确认', '待发送', '未安排', '发送成功', '不适用']) expect(customers.some(customer => customerFacts(customer).contactStatus === status)).toBe(true);
    expect(customers.every(customer => customer.demo && customer.messages?.every(message => message.demo))).toBe(true);
    expect(customers.every(customer => !customer.profileUrl && customer.sources?.every(item => !item.url))).toBe(true);
  });

  it('restores existing user changes without resetting or synthesizing unknown history', () => {
    const state = createSeed();
    state.tasks[0].name = '用户修改后的任务';
    state.knowledge.A1.identity = '用户保存的身份';
    state.customers = [{ id: 'saved-legacy', accountId: 'A1', taskIds: ['T1'], target: true, discoveredAt: at, contactedAt: at }];
    const restored = restoreState(JSON.stringify(state));
    expect(restored).toEqual(state);
    expect(restored.customers[0].messages).toBeUndefined();
    expect(restored.customers[0].sources).toBeUndefined();
  });

  it('never rewrites factual messages or evidence when knowledge and communication strategy change', () => {
    const state = createSeed();
    const history = JSON.stringify(state.customers);
    state.knowledge.A1.style = '以后更简洁';
    updateTask(state, 'T1', { communicationStrategy: '先回应问题，再询问是否需要基础资料' });
    expect(state.tasks[0].communicationStrategy).toBe('先回应问题，再询问是否需要基础资料');
    expect(JSON.stringify(state.customers)).toBe(history);
  });
});
