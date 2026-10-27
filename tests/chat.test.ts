import { describe, expect, it } from 'vitest';
import { needsBusiness, needsRequirements, parsePlan, taskPlan } from '../src/lib/chat';
import { emptyKnowledge } from '../src/lib/domain';
import { createSeed } from '../src/lib/seed';
import type { Plan } from '../src/lib/types';

const state = createSeed();
const knowledge = state.knowledge.A1;
const previous: Plan = { ...taskPlan(state.tasks[0]), name: '热玛吉潜客挖掘' };

describe('request completeness', () => {
  it('sends a vague intent to requirements and complete demand directly to a plan', () => {
    expect(needsRequirements(parsePlan('帮我找客户', knowledge))).toBe(true);
    const plan = parsePlan('帮我找杭州近期在抖音咨询热玛吉价格或效果的人，每天联系 20 个高意向客户。', knowledge);
    expect(needsRequirements(plan)).toBe(false);
    expect(plan.region).toBe('杭州');
    expect(plan.dailyQuota).toBe(20);
    expect(plan.mode).toBe('contact');
    expect(plan.authorized).toBe(false);
  });

  it('asks for business details on a fresh account, and for the source on a monitored-account request', () => {
    expect(needsBusiness(emptyKnowledge())).toBe(true);
    expect(needsBusiness(knowledge)).toBe(false);
    expect(needsRequirements(parsePlan('监控指定账号中咨询热玛吉价格的杭州用户', knowledge))).toBe(true);
  });
});

describe('modifying an existing plan', () => {
  it('changes only the quota for a quota-only instruction', () => {
    const plan = parsePlan('把热玛吉任务每天触达人数改成 10 人', knowledge, previous);
    expect(plan.dailyQuota).toBe(10);
    expect(plan.target).toBe(previous.target);
    expect(plan.region).toBe(previous.region);
    expect(plan.signals).toBe(previous.signals);
    expect(plan.source).toBe(previous.source);
    expect(plan.schedule).toBe(previous.schedule);
  });

  it('does not mistake execution time for an explicit daily contact count', () => {
    const plan = parsePlan('把任务改为每天 14:30 执行', knowledge, previous);
    expect(plan.schedule).toBe('每天 14:30');
    expect(plan.dailyQuota).toBe(previous.dailyQuota);
    const both = parsePlan('每天 14:30 执行，每天联系 12 人', knowledge, previous);
    expect(both.schedule).toBe('每天 14:30');
    expect(both.dailyQuota).toBe(12);
  });

  it('preserves find-only zero quota when editing an unrelated condition', () => {
    const plan = parsePlan('只联系杭州客户', knowledge, previous);
    expect(plan.target).toContain('杭州');
    const findOnly = parsePlan('仅找客，不安排私信', knowledge, previous);
    expect(findOnly.mode).toBe('find');
    expect(findOnly.dailyQuota).toBe(0);
    const updated = parsePlan('只找上海的客户', knowledge, findOnly);
    expect(updated.mode).toBe('find');
    expect(updated.dailyQuota).toBe(0);
    expect(updated.region).toBe('上海');
    expect(updated.target).toContain('上海');
  });

  it('requires new explicit authorization when upgrading a find-only task to contact', () => {
    const findTask = { ...state.tasks[0], mode: 'find' as const, dailyQuota: 0 };
    const plan = parsePlan('改为每天联系 10 人', knowledge, taskPlan(findTask));
    expect(plan.mode).toBe('contact');
    expect(plan.dailyQuota).toBe(10);
    expect(plan.authorized).toBe(false);
  });

  it('updates the target when the requested product actually changes', () => {
    const plan = parsePlan('目标改为杭州咨询超声炮价格的人', knowledge, previous);
    expect(plan.name).toContain('超声炮');
    expect(plan.target).toContain('超声炮');
    expect(plan.target).not.toContain('热玛吉');
  });

  it('keeps a customized task name and zero quota on an unrelated edit', () => {
    const custom = { ...previous, name: '杭州热玛吉高意向客户', dailyQuota: 0 };
    const plan = parsePlan('热玛吉任务改为每天 11:30 执行', knowledge, custom);
    expect(plan.name).toBe(custom.name);
    expect(plan.target).toBe(custom.target);
    expect(plan.dailyQuota).toBe(0);
  });

  it('keeps invalid explicit counts for validation instead of silently changing their values', () => {
    expect(parsePlan('每天私信 -5 人', knowledge, previous).dailyQuota).toBe(-5);
    expect(parsePlan('每天联系 1.5 人', knowledge, previous).dailyQuota).toBe(1.5);
    expect(parsePlan('每天联系 0 人', knowledge, previous).dailyQuota).toBe(0);
    expect(parsePlan('每天联系 10000 人', knowledge, previous).dailyQuota).toBe(10000);
  });
});
