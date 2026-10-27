import type { Knowledge, Plan, Task } from './types';

export function parsePlan(text: string, knowledge: Knowledge, previous?: Plan): Plan {
  const topic = ['热玛吉', '超声炮', '玻尿酸', '皮肤管理', '医美咨询', '装修', '留学', '保险', '摄影', '健身'].find(p => text.includes(p));
  const product = knowledge.products.find(p => text.includes(p.name))?.name;
  const region = text.match(/(杭州|上海|北京|深圳|广州|成都|南京|苏州|宁波|重庆|武汉|全国)/)?.[1];
  const count = text.match(/(?:每天|每日|日均)[^\d+\-]{0,12}([+\-]?\d+(?:\.\d+)?)(?![\d.:：点])\s*(?:个|人|位|名|$|[，。,])/)?.[1]
    || text.match(/(?:改成|改为|调整到|调整为)\s*([+\-]?\d+(?:\.\d+)?)(?![\d.:：点])\s*(?:个|人|位|名|$|[，。,])/)?.[1]
    || text.match(/(?:私信|联系|触达)(?:人数)?\s*([+\-]?\d+(?:\.\d+)?)\s*(?:个|人|位|名)/)?.[1];
  const findOnly = /仅找客|只找客|只找人|不(?:要)?(?:安排)?(?:触达|私信|联系)|仅寻找|不要发/.test(text);
  const signals = ['价格', '效果', '咨询', '预算', '报价', '需求', '推荐'].filter(s => text.includes(s));
  const time = text.match(/(\d{1,2})[:：](\d{2})/) || text.match(/(?:每天|每日)\s*(\d{1,2})\s*点(?:\s*(\d{1,2})\s*分)?/);
  const subject = product || topic;
  const subjectChanged = Boolean(subject && previous && !previous.target.includes(subject) && !previous.name.includes(subject));
  const oldSubject = previous && [...knowledge.products.map(item => item.name), '热玛吉', '超声炮', '玻尿酸', '皮肤管理', '医美咨询', '装修', '留学', '保险', '摄影', '健身'].find(item => previous.target.includes(item));
  let target = previous?.target || (subject ? `寻找${region || knowledge.region || '指定地区'}近期对${subject}有明确咨询需求的用户` : '');
  if (subject && previous && subjectChanged) target = oldSubject ? target.replaceAll(oldSubject, subject) : `寻找${region || previous.region || knowledge.region}近期对${subject}有明确咨询需求的用户`;
  const mode = findOnly ? 'find' : count || /私信|联系|触达/.test(text) ? 'contact' : previous?.mode || 'contact';
  if (previous && /话术|沟通|语气|策略/.test(text) && !count && !time && !/执行方式|任务模式|找客目标|目标客户改/.test(text)) {
    return { ...previous, communicationStrategy: text.trim() };
  }
  return {
    communicationStrategy: /话术|沟通|语气|策略/.test(text) ? text.trim() : previous?.communicationStrategy,
    name: previous && !subjectChanged ? previous.name : subject ? `${subject}潜客挖掘` : '新客群挖掘',
    target: previous && region ? target.replace(/杭州|上海|北京|深圳|广州|成都|南京|苏州|宁波|重庆|武汉|全国/g, region) : target,
    region: region || previous?.region || knowledge.region,
    signals: signals.length ? signals.map(s => `${s}相关咨询`).join('、') : previous?.signals || '',
    source: /监控|指定账号/.test(text) ? '指定抖音账号的作品与评论（需补充账号）' : previous?.source || '抖音公开作品与评论',
    schedule: time ? `每天 ${time[1].padStart(2, '0')}:${(time[2] || '00').padStart(2, '0')}` : previous?.schedule || '每天 10:00',
    dailyQuota: mode === 'find' ? 0 : count ? Number(count) : previous?.dailyQuota ?? 20,
    mode,
    authorized: mode === 'contact' && previous?.mode === 'contact' ? previous.authorized : false,
  };
}

export function taskPlan(task: Task): Plan {
  return { communicationStrategy: task.communicationStrategy, name: task.name, target: task.target, region: task.region, signals: task.signals, source: task.source, schedule: task.schedule, dailyQuota: task.dailyQuota, mode: task.mode, authorized: task.mode === 'contact' };
}

export function needsBusiness(k: Knowledge) { return !k.identity.trim() || !k.service.trim() || !k.region.trim(); }
export function needsRequirements(p: Plan) { return !p.target.trim() || !p.region.trim() || !p.signals.trim() || p.source.includes('需补充'); }
