import { emptyKnowledge, shanghaiDay } from './domain';
import type { AppState, Customer, CustomerMessage, Execution, Knowledge, Task } from './types';

function dayAtOffset(now: Date, offset: number): string {
  const date = new Date(`${shanghaiDay(now)}T02:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString();
}

export function createSeed(now: Date = new Date()): AppState {
  const today = dayAtOffset(now, 0);
  const recent = dayAtOffset(now, -3);
  const older = dayAtOffset(now, -18);
  const createdAt = dayAtOffset(now, -28);
  const accounts = [
    { id: 'A1', name: '杭州医美顾问小林', handle: 'xiaolin_hz', connected: true, limit: 50, color: '#e8b99c', initials: '林' },
    { id: 'A2', name: '医美咨询师安安', handle: 'anan_beauty', connected: true, limit: 40, color: '#b4c4df', initials: '安' },
    { id: 'A3', name: '本地装修小陈', handle: 'xiaochen_home', connected: false, limit: 30, color: '#c3cdb6', initials: '陈' },
  ];
  const a1: Knowledge = {
    identity: '杭州医美咨询顾问', brand: '杭州悦己美学', region: '杭州', service: '热玛吉、超声炮等抗衰项目的咨询与需求评估',
    advantage: '先了解需求，再提供项目资料；咨询过程透明，不做效果承诺。', audience: '在杭州关注面部抗衰、希望了解项目价格或效果的人', purpose: '回答项目问题，并在对方愿意时建立进一步咨询联系',
    style: '专业、亲切、简洁，先回应对方的具体问题', goal: '了解需求，邀请有意愿的用户进一步咨询', cautions: '不夸大效果、不保证疗效；未经确认不承诺价格；尊重拒绝联系的意愿。',
    products: [
      { id: 'P1', name: '热玛吉', description: '面部抗衰项目咨询，具体方案需经专业面诊评估。', benefits: '提供项目原理、适用情况与注意事项的清晰说明', audience: '关注面部紧致与抗衰，有真实咨询需求的成年人', price: '需面诊评估后确认，不在私信中承诺具体价格', faq: '效果和适用性因人而异；是否适合需由专业人员评估。' },
      { id: 'P2', name: '超声炮', description: '提供超声炮项目相关的需求咨询与基础信息。', benefits: '根据个人关注点整理可供进一步咨询的问题', audience: '关注面部松弛，希望了解抗衰项目的人', price: '具体价格以机构确认的方案为准', faq: '不替代专业面诊，不作效果保证。' },
    ],
  };
  const a2: Knowledge = {
    identity: '皮肤管理咨询师', brand: '安安皮肤管理工作室', region: '杭州', service: '皮肤管理方案咨询与日常护理建议', advantage: '耐心了解护理习惯，清楚说明服务内容。',
    audience: '关注肤质、日常护理与皮肤管理服务的本地用户', purpose: '解答服务问题，并邀请有需要的用户预约咨询', style: '温和、耐心，不使用催促或焦虑式表达', goal: '了解护理需求，在用户愿意时获得咨询联系方式', cautions: '不诊断疾病、不保证效果、不索取不必要的个人信息。',
    products: [{ id: 'P3', name: '皮肤管理咨询', description: '了解用户护理习惯与服务需求，介绍可选皮肤管理服务。', benefits: '清楚说明服务步骤与注意事项', audience: '希望了解日常皮肤管理的成年人', price: '咨询后确认具体服务与费用', faq: '涉及疾病或不适时建议前往正规医疗机构。' }],
  };
  const taskSpecs = [
    { id: 'T1', accountId: 'A1', name: '热玛吉潜客挖掘', product: '热玛吉', dailyQuota: 30, status: 'running', analyzed: 1560, targeted: 210, contacted: 140, leads: 21, today: 18 },
    { id: 'T2', accountId: 'A1', name: '超声炮潜客挖掘', product: '超声炮', dailyQuota: 20, status: 'running', analyzed: 980, targeted: 135, contacted: 90, leads: 12, today: 12 },
    { id: 'T3', accountId: 'A2', name: '皮肤管理潜客挖掘', product: '皮肤管理', dailyQuota: 15, status: 'running', analyzed: 620, targeted: 110, contacted: 75, leads: 9, today: 7 },
    { id: 'T4', accountId: 'A2', name: '医美咨询潜客挖掘', product: '医美项目', dailyQuota: 10, status: 'paused', analyzed: 400, targeted: 50, contacted: 30, leads: 3, today: 0 },
    { id: 'T5', accountId: 'A3', name: '装修需求潜客挖掘', product: '装修', dailyQuota: 10, status: 'error', analyzed: 300, targeted: 45, contacted: 20, leads: 2, today: 0 },
  ] as const;
  const tasks: Task[] = taskSpecs.map(spec => ({
    id: spec.id, accountId: spec.accountId, name: spec.name, target: spec.id === 'T5' ? '寻找杭州近期咨询新房装修、设计或装修报价的用户' : `寻找杭州近期咨询${spec.product}价格、效果或服务的高意向用户`,
    region: '杭州', signals: spec.id === 'T5' ? '新房装修、设计方案、装修报价' : `${spec.product}价格、项目效果、服务咨询`,
    source: '抖音公开作品与评论', schedule: '每天 10:00', dailyQuota: spec.dailyQuota, mode: 'contact', status: spec.status,
    enabled: spec.status !== 'paused', createdAt, conversationId: `C-${spec.accountId}`, revision: 1,
  }));
  const customers: Customer[] = [];
  const executions: Execution[] = [];
  for (const spec of taskSpecs) {
    const rounds = new Map([today, recent, older].map(date => [date, { analyzed: 0, targeted: 0, contacted: 0, leads: 0 }]));
    for (let i = 0; i < spec.analyzed; i++) {
      const target = i < spec.targeted;
      const contacted = i < spec.contacted;
      const lead = contacted && Math.floor((i + 1) * spec.leads / spec.contacted) > Math.floor(i * spec.leads / spec.contacted);
      let discoveredAt: string;
      if (contacted) discoveredAt = i < spec.today ? today : (i % 5 < 2 ? recent : older);
      else discoveredAt = spec.today > 0 && i % 5 === 0 ? today : (i % 5 < 3 ? recent : older);
      const round = rounds.get(discoveredAt)!;
      round.analyzed += 1;
      if (target) round.targeted += 1;
      if (contacted) round.contacted += 1;
      if (lead) round.leads += 1;
      const serial = String(i + 1).padStart(4, '0');
      const id = `demo-douyin-${spec.id}-${serial}`;
      const executionDates = spec.today > 0 ? [today, recent, older] : [recent, older];
      const executionId = `E-${spec.id}-${executionDates.indexOf(discoveredAt) + 1}`;
      const sentAt = discoveredAt.replace('02:00', '02:12');
      const replyAt = discoveredAt.replace('02:00', '02:40');
      const topic = spec.product;
      const plannedText = `你好，我是${spec.accountId === 'A3' ? '本地装修顾问' : '项目咨询顾问'}。看到你关注${topic}，想了解你最关心的问题；如果方便，我可以先整理一些基础资料。`;
      const actualText = `你好，看到你在公开评论中询问${topic}${spec.id === 'T5' ? '的方案和报价' : '的价格或服务'}。我是${spec.accountId === 'A3' ? '本地装修顾问' : '项目咨询顾问'}，可以先了解你的具体需求，再说明资料与咨询方式。不方便的话不用回复，我们会尊重你的意愿。`;
      const messages: CustomerMessage[] = [];
      const messageBase = { taskId: spec.id, executionId, accountId: spec.accountId, direction: 'outbound' as const, demo: true };
      if (contacted) {
        if (i === 0) messages.push({ ...messageBase, id: `${id}-failed-attempt`, text: plannedText, at: discoveredAt.replace('02:00', '02:10'), status: 'failed', reason: '演示：首次请求超时；此记录未计为成功。' });
        messages.push({ ...messageBase, id: `${id}-sent`, text: actualText, plannedText, at: sentAt, status: 'success', receiptId: `DEMO-RECEIPT-${spec.id}-${serial}`, reason: '演示数据：模拟执行成功，不是真实平台回执。' });
        if (lead || i % 4 === 0) messages.push({ ...messageBase, id: `${id}-reply`, direction: 'inbound', text: lead ? `我愿意进一步咨询，演示联系方式是 DEMO_WX_${spec.id}_${serial}，可以通过这个方式联系我。（虚构演示，无效联系方式）` : `我主要想了解${topic}的服务内容，可以先发基础说明吗？（演示回复）`, at: replyAt, status: 'received' });
        if (i === 0) messages.push({ ...messageBase, id: `${id}-followup`, text: '好的，我先整理与你提问相关的基础信息。具体方案与费用需要进一步确认；如果不想继续沟通，请随时告诉我。', at: discoveredAt.replace('02:00', '02:50'), status: 'success', receiptId: `DEMO-RECEIPT-${spec.id}-${serial}-2`, reason: '演示数据：模拟执行成功，不是真实平台回执。' });
      } else if (target) {
        const status = (['failed', 'unknown', 'queued'] as const)[(i - spec.contacted) % 4];
        if (status) messages.push({ ...messageBase, id: `${id}-${status}`, text: plannedText, plannedText, at: sentAt, status,
          reason: status === 'failed' ? '演示：对方账号设置不允许接收当前账号的私信。' : status === 'unknown' ? '演示：未取得平台确认，发送结果待确认。' : '演示：已生成计划话术并进入队列，尚未发送。' });
      }
      const missingEvidence = i === spec.targeted - 1;
      const source = {
        id: `${spec.id}-${serial}-S1`, taskId: spec.id, executionId, type: i % 3 === 0 ? '关键词搜索' : '作品评论',
        ...(target ? { title: `演示作品 · ${topic}基础咨询 ${i % 12 + 1}`, platformId: `DEMO-WORK-${spec.id}-${i % 12 + 1}` } : {}), discoveredAt,
        ...(!missingEvidence ? { text: target ? `演示评论：在杭州，想了解${topic}${spec.id === 'T5' ? '的方案和报价' : '的价格及服务内容'}，可以先咨询吗？` : '演示评论：路过看看，暂时没有咨询需求。',
          ...(target ? { matchReason: `公开文本中明确询问${topic}相关信息，并提及杭州，符合当前任务的咨询意向条件。`,
          condition: tasks.find(task => task.id === spec.id)!.signals,
          evidenceText: `${topic}咨询意向 → 询问价格或服务；地域 → 提及杭州。` } : {}) } : {}),
        targeted: target, contactApplicable: true, demo: true,
      };
      customers.push({
        id, platformId: `DEMO-USER-${spec.id}-${serial}`, ...(i !== spec.targeted - 2 ? { nickname: `演示用户·${spec.id}-${serial}` } : {}),
        accountId: spec.accountId, taskIds: [spec.id], discoveredAt, target, demo: true, sources: [source], messages,
        ...(!target ? { exclusionReason: '演示：未见本任务咨询意向。' } : {}),
        ...(contacted ? { contactedAt: discoveredAt.replace('02:00', '02:12') } : {}),
        ...(lead ? { leadAt: discoveredAt.replace('02:00', '03:05'), evidence: '演示对话记录：用户主动提供虚构演示联系方式。', leadEvidence: {
          text: `演示回复中主动提供 DEMO_WX_${spec.id}_${serial} 并明确同意进一步联系；这不是单纯询价或点赞。`,
          at: discoveredAt.replace('02:00', '03:05'), messageId: `${id}-reply`, contact: `DEMO_WX_${spec.id}_${serial}（虚构、不可用）`, taskId: spec.id, executionId, accountId: spec.accountId, demo: true,
        } } : {}),
      });
    }
    let roundIndex = 0;
    for (const [startedAt, counts] of rounds) {
      if (!counts.analyzed) continue;
      roundIndex += 1;
      const partial = (spec.id === 'T2' && startedAt === today) || (spec.id === 'T5' && startedAt === recent);
      const reason = spec.id === 'T5' ? '本轮部分完成后账号连接失效，已停止后续执行；已有结果保留。' : '部分作品评论暂不可见，已跳过；成功触达未达到当日计划。';
      executions.push({
        id: `E-${spec.id}-${roundIndex}`, taskId: spec.id, startedAt, status: partial ? 'partial' : 'completed', ...counts,
        ...(partial ? { reason } : {}),
        steps: [
          { name: '寻找作品与评论', status: 'completed', time: '10:00' },
          { name: '分析用户', status: 'completed', time: '10:03' },
          { name: '筛选目标客户', status: 'completed', time: '10:06' },
          { name: '生成触达内容', status: 'completed', time: '10:09' },
          { name: '执行私信', status: partial ? 'failed' : 'completed', time: '10:12', ...(partial ? { reason } : {}) },
        ],
      });
    }
  }
  // A repeated observation is a second piece of evidence, never a second person.
  const repeated = customers[0];
  customers.push({ ...repeated, id: `${repeated.id}-observation-2`, sources: [{ ...repeated.sources![0], id: `${repeated.id}-source-2`, type: '指定作品', title: '演示作品 · 另一条相关公开讨论', platformId: 'DEMO-WORK-REPEATED-1', text: '演示评论：我还想了解这个项目有哪些注意事项。' }] });
  return {
    version: 1, accounts, tasks, customers, executions, knowledge: { A1: a1, A2: a2, A3: emptyKnowledge() },
    conversations: accounts.map(account => ({ id: `C-${account.id}`, accountId: account.id, title: '开始找客户', messages: [], createdAt })),
    activeConversation: Object.fromEntries(accounts.map(account => [account.id, `C-${account.id}`])), selectedAccountId: 'A1', loggedIn: true,
  };
}
