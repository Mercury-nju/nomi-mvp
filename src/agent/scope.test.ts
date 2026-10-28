import { describe, expect, it } from 'vitest';
import { customerInTask, filterCustomers, taskMessages, taskSources } from './scope';
import type { Customer } from './types';

const customer: Customer = { id: 'person', taskIds: ['sales','music'], match: {status:'matched', reasons:['喜欢音乐']}, matches: {sales:{status:'uncertain',missing:['地域不足']},music:{status:'matched',reasons:['喜欢音乐']}}, sources: [{taskId:'sales',text:'希望找客户'},{taskId:'music',text:'好听'}], messages: [{taskId:'music',text:'你好',status:'success',direction:'outbound'}] };
describe('task-scoped customer evidence', () => {
  it('uses the selected task judgment rather than the most recent judgment', () => {
    expect(customerInTask(customer,'sales').match?.status).toBe('uncertain');
    expect(filterCustomers([customer],'sales','matched','')).toHaveLength(0);
    expect(filterCustomers([customer],'music','matched','')).toHaveLength(1);
    expect(customer.match?.status).toBe('matched');
  });
  it('keeps sources and sends from another task out of scoped summaries and search', () => {
    expect(taskSources(customer,'sales').map(source => source.text)).toEqual(['希望找客户']);
    expect(taskMessages(customer,'sales')).toHaveLength(0);
    expect(filterCustomers([customer],'sales','all','好听')).toHaveLength(0);
    expect(customerInTask(customer,'sales').sources).toHaveLength(2);
  });
  it('does not borrow an aggregate judgment when a scoped judgment is absent', () => {
    expect(customerInTask({...customer,matches:{}},'sales').match?.status).toBe('uncertain');
    expect(customerInTask(customer,'')).toBe(customer);
  });
});
