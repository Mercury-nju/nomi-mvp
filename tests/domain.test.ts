import { describe, expect, it } from 'vitest';
import { accountRevision, allocation, createTask, metrics, setAccountConnected, setTaskEnabled, shanghaiDay, todayContacts, updateTask } from '../src/lib/domain';
import { createSeed } from '../src/lib/seed';
import type { TaskInput } from '../src/lib/types';

function input(accountId = 'A1'): TaskInput {
  return { accountId, conversationId: `C-${accountId}`, name: '玻尿酸潜客任务', target: '咨询玻尿酸的杭州用户', region: '杭州', signals: '价格、项目咨询', source: '抖音公开评论', schedule: '每天 10:00', dailyQuota: 20, mode: 'contact', authorized: true };
}

describe('consistent demonstration results', () => {
  it('derives the PRD totals and account allocations from one dataset', () => {
    const state = createSeed();
    expect(metrics(state)).toEqual({ analyzed: 3860, targeted: 550, contacted: 355, leads: 47 });
    expect(metrics(state, 'A1')).toEqual({ analyzed: 2540, targeted: 345, contacted: 230, leads: 33 });
    expect(metrics(state, undefined, undefined, undefined, 'T1')).toEqual({ analyzed: 1560, targeted: 210, contacted: 140, leads: 21 });
    expect(todayContacts(state)).toBe(37);
    expect(todayContacts(state, 'A1')).toBe(30);
    expect(todayContacts(state, 'A1', 'T1')).toBe(18);
    expect(todayContacts(state, 'A3')).toBe(0);
    expect(['A1', 'A2', 'A3'].map(id => allocation(state, id))).toEqual([50, 25, 10]);
  });

  it('has coherent execution totals and inclusive Shanghai cohort filters', () => {
    const state = createSeed();
    const sums = state.executions.reduce((sum, run) => ({ analyzed: sum.analyzed + run.analyzed, targeted: sum.targeted + run.targeted, contacted: sum.contacted + run.contacted, leads: sum.leads + run.leads }), { analyzed: 0, targeted: 0, contacted: 0, leads: 0 });
    expect(sums).toEqual(metrics(state));
    const today = shanghaiDay(new Date());
    const todayMetrics = metrics(state, undefined, today, today);
    expect(todayMetrics.analyzed).toBeGreaterThan(37);
    expect(todayMetrics.contacted).toBe(37);
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    const weekMetrics = metrics(state, undefined, shanghaiDay(sevenDaysAgo), today);
    expect(weekMetrics.analyzed).toBeGreaterThan(todayMetrics.analyzed);
    expect(weekMetrics.analyzed).toBeLessThan(sums.analyzed);
    for (const run of state.executions) {
      expect(run.analyzed).toBeGreaterThanOrEqual(run.targeted);
      expect(run.targeted).toBeGreaterThanOrEqual(run.contacted);
      expect(run.contacted).toBeGreaterThanOrEqual(run.leads);
    }
  });

  it('deduplicates reliable platform identities across accounts and requires lead evidence', () => {
    const state = createSeed();
    state.customers = [
      { id: 'same-user', platformId: 'reliable-platform-user', accountId: 'A1', taskIds: ['T1'], discoveredAt: '2026-10-22T16:01:00Z', target: true, contactedAt: '2026-10-23T01:00:00Z' },
      { id: 'same-user', platformId: 'reliable-platform-user', accountId: 'A2', taskIds: ['T3'], discoveredAt: '2026-10-23T01:00:00Z', target: true, contactedAt: '2026-10-23T02:00:00Z', leadAt: '2026-10-23T03:00:00Z', evidence: '演示：用户明确留资' },
      { id: 'no-evidence', accountId: 'A1', taskIds: ['T1'], discoveredAt: '2026-10-23T00:00:00Z', target: true, contactedAt: '2026-10-23T02:00:00Z', leadAt: '2026-10-23T03:00:00Z' },
    ];
    expect(metrics(state, undefined, '2026-10-23', '2026-10-23')).toEqual({ analyzed: 2, targeted: 2, contacted: 2, leads: 1 });
    expect(metrics(state, 'A1').leads).toBe(0);
    expect(metrics(state, undefined, '2026-10-22', '2026-10-22').analyzed).toBe(0);
    expect(metrics(state, undefined, undefined, undefined, 'T1').analyzed).toBe(2);
  });
});

describe('quota and authorization rules', () => {
  it('rejects a conflict atomically, then adjusts both old quotas and creates once', () => {
    const state = createSeed();
    const before = structuredClone(state);
    expect(() => createTask(state, input())).toThrow(/上限/);
    expect(state).toEqual(before);
    const task = createTask(state, input(), { T1: 20, T2: 10 });
    expect(state.tasks).toHaveLength(6);
    expect(state.tasks.find(item => item.id === 'T1')?.dailyQuota).toBe(20);
    expect(state.tasks.find(item => item.id === 'T2')?.dailyQuota).toBe(10);
    expect(allocation(state, 'A1')).toBe(50);
    expect(metrics(state, undefined, undefined, undefined, task.id)).toEqual({ analyzed: 0, targeted: 0, contacted: 0, leads: 0 });
    expect(state.executions).toEqual(before.executions);
  });

  it('reserves paused quotas and blocks cross-account or invalid changes without partial writes', () => {
    const state = createSeed();
    expect(allocation(state, 'A2')).toBe(25);
    const before = structuredClone(state);
    expect(() => createTask(state, input('A2'))).toThrow(/上限/);
    expect(() => createTask(state, input(), { T1: 10, T3: 0 })).toThrow(/其他账号/);
    expect(() => updateTask(state, 'T1', { dailyQuota: 50 }, { T2: 10 })).toThrow(/上限/);
    expect(() => updateTask(state, 'T1', { dailyQuota: -1 })).toThrow(/整数/);
    expect(() => createTask(state, { ...input(), dailyQuota: Number.NaN })).toThrow(/整数/);
    expect(state).toEqual(before);
  });

  it('creates find-only without occupying quota and requires explicit authorization to enable touch', () => {
    const state = createSeed();
    const task = createTask(state, { ...input(), mode: 'find', authorized: false });
    expect(task.dailyQuota).toBe(0);
    expect(allocation(state, 'A1')).toBe(50);
    expect(() => updateTask(state, task.id, { mode: 'contact', dailyQuota: 10 }, { T1: 20 })).toThrow(/授权/);
    expect(state.tasks.find(item => item.id === 'T1')?.dailyQuota).toBe(30);
    expect(() => createTask(state, { ...input('A2'), dailyQuota: 5, authorized: false })).toThrow(/授权/);
    updateTask(state, task.id, { mode: 'contact', dailyQuota: 10, authorized: true }, { T1: 20 });
    expect(allocation(state, 'A1')).toBe(50);
  });

  it('changes future configuration while preserving all factual history', () => {
    const state = createSeed();
    const history = structuredClone({ customers: state.customers, executions: state.executions });
    const revision = accountRevision(state, 'A1');
    updateTask(state, 'T1', { dailyQuota: 10 });
    expect(accountRevision(state, 'A1')).not.toBe(revision);
    expect(state.customers).toEqual(history.customers);
    expect(state.executions).toEqual(history.executions);
  });
});

describe('account connection and enabled task state', () => {
  it('preserves enabled intent and historical facts through disconnection/reconnection', () => {
    const state = createSeed();
    const before = metrics(state);
    setAccountConnected(state, 'A2', false);
    expect(state.tasks.find(task => task.id === 'T3')?.status).toBe('error');
    expect(state.tasks.find(task => task.id === 'T4')?.status).toBe('paused');
    expect(() => setTaskEnabled(state, 'T3', true)).toThrow(/掉线/);
    setAccountConnected(state, 'A2', true);
    expect(state.tasks.find(task => task.id === 'T3')?.status).toBe('running');
    expect(state.tasks.find(task => task.id === 'T4')?.status).toBe('paused');
    setAccountConnected(state, 'A3', true);
    expect(state.tasks.find(task => task.id === 'T5')?.status).toBe('running');
    expect(metrics(state)).toEqual(before);
    expect(todayContacts(state)).toBe(37);
  });

  it('requires connection for creation and keeps reserved quota when paused', () => {
    const state = createSeed();
    expect(() => createTask(state, input('A3'))).toThrow(/掉线/);
    setTaskEnabled(state, 'T1', false);
    expect(state.tasks.find(task => task.id === 'T1')?.enabled).toBe(false);
    expect(allocation(state, 'A1')).toBe(50);
    setTaskEnabled(state, 'T1', true);
    expect(state.tasks.find(task => task.id === 'T1')?.status).toBe('running');
  });
});
