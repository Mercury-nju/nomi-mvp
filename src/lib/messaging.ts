import type { Knowledge, Plan } from './types';

export function messagePreview(knowledge: Knowledge, plan: Plan): string {
  if (!knowledge.identity.trim() || !knowledge.service.trim()) return '业务资料不足，请先补充身份与服务内容，再预览话术。';
  const product = knowledge.products.find(item => plan.name.includes(item.name) || plan.target.includes(item.name));
  const introduction = product?.description.trim() ? `关于${product.name}，${product.description}` : `我们提供${knowledge.service}。`;
  return `你好，我是${knowledge.identity}。${introduction}如果你愿意，可以告诉我目前最关注的问题；不方便交流也没关系。`;
}
