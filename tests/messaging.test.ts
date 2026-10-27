import { describe, expect, it } from 'vitest';
import { messagePreview } from '../src/lib/messaging';
import { emptyKnowledge, updateTask } from '../src/lib/domain';
import { parsePlan, taskPlan } from '../src/lib/chat';
import { createSeed } from '../src/lib/seed';

describe('communication preview and history', () => {
  it('does not interpret communication wording as a quota or mode edit', () => {
    const state = createSeed();
    const previous = taskPlan(state.tasks[0]);
    const next = parsePlan('修改话术：不要发价格承诺', state.knowledge.A1, previous);
    expect(next.mode).toBe(previous.mode);
    expect(next.dailyQuota).toBe(previous.dailyQuota);
    expect(next.signals).toBe(previous.signals);
    const find = { ...previous, mode: 'find' as const, dailyQuota: 0 };
    expect(parsePlan('修改话术，先询问是否方便联系', state.knowledge.A1, find).mode).toBe('find');
  });
  it('does not invent business facts when knowledge is missing', () => {
    const state = createSeed();
    expect(messagePreview(emptyKnowledge(), taskPlan(state.tasks[0]))).toContain('业务资料不足');
  });
  it('uses only current account business context in new previews', () => {
    const state = createSeed();
    const plan = taskPlan(state.tasks[0]);
    const original = messagePreview(state.knowledge.A1, plan);
    state.knowledge.A1.identity = 'Updated identity';
    expect(messagePreview(state.knowledge.A1, plan)).toContain('Updated identity');
    expect(original).not.toContain('Updated identity');
    expect(messagePreview(state.knowledge.A2, plan)).not.toContain('Updated identity');
  });
  it('confirms strategy changes through task update without modifying history or quotas', () => {
    const state = createSeed();
    const history = JSON.stringify(state.customers);
    const oldQuota = state.tasks[0].dailyQuota;
    const plan = parsePlan('热玛吉任务的沟通语气改为温和简短', state.knowledge.A1, taskPlan(state.tasks[0]));
    expect(plan.communicationStrategy).toContain('温和简短');
    updateTask(state, 'T1', plan);
    expect(state.tasks[0].communicationStrategy).toBe(plan.communicationStrategy);
    expect(state.tasks[0].dailyQuota).toBe(oldQuota);
    expect(JSON.stringify(state.customers)).toBe(history);
  });
});
