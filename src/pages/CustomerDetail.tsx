import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, MessageSquareText, UserRound, X } from 'lucide-react';
import { customerFacts } from '../lib/customers';
import type { CustomerSelection } from '../lib/customers';
import type { AppState, Customer } from '../lib/types';
import './CustomerDetails.css';

export function displayTime(value?: string) {
  if (!value || Number.isNaN(new Date(value).getTime())) return '暂无数据';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
}

function validPlatformUrl(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com')) ? url.href : undefined;
  } catch { return undefined; }
}

export function CustomerAvatar({ customer }: { customer: Customer }) {
  const [failed, setFailed] = useAvatarFailure(customer.avatarUrl);
  return customer.avatarUrl && !failed ? <img className="nc-avatar" src={customer.avatarUrl} alt="" onError={() => setFailed(true)} /> : <span className="nc-avatar nc-avatar-placeholder" aria-label="暂无头像"><UserRound size={20} strokeWidth={1.5} /></span>;
}

function useAvatarFailure(url?: string) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return [failed, setFailed] as const;
}

export default function CustomerDetail({ customer, state, onClose }: { customer: CustomerSelection; state: AppState; onClose: () => void }) {
  const panel = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    close.current?.focus({ preventScroll: true });
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); }
      if (event.key !== 'Tab') return;
      const elements = Array.from(panel.current?.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex="0"]') || []).filter(element => !element.hasAttribute('disabled'));
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', handleKey); active?.focus({ preventScroll: true }); };
  }, []);
  const facts = customerFacts({ ...customer, factScope: undefined });
  const sources = [...(customer.sources || [])].sort((a, b) => a.discoveredAt.localeCompare(b.discoveredAt));
  const validDate = (value?: string) => !!value && !Number.isNaN(new Date(value).getTime());
  const messages = [...(customer.messages || [])].filter(message => message.direction !== 'inbound' || (message.status === 'received' && message.text.trim() && validDate(message.at))).sort((a, b) => a.at.localeCompare(b.at));
  const profile = validPlatformUrl(customer.profileUrl);
  const taskName = (id: string) => state.tasks.find(task => task.id === id)?.name || '任务暂无数据';
  const accountName = (id?: string) => state.accounts.find(item => item.id === id)?.name || '账号暂无数据';
  const accountIds = [...new Set([customer.accountId, ...sources.map(source => source.accountId || customer.accountId), ...messages.map(message => message.accountId || customer.accountId), ...(customer.legacyRecords || []).map(record => record.accountId)])];
  const lead = [...(customer.leadEvidenceRecords || (customer.leadEvidence ? [customer.leadEvidence] : []))].filter(evidence => evidence.text?.trim() && validDate(evidence.at) && (!evidence.messageId || messages.some(message => message.id === evidence.messageId && message.direction === 'inbound' && (!evidence.accountId || message.accountId === evidence.accountId)))).sort((a, b) => a.at.localeCompare(b.at))[0];
  const leadMessage = lead?.messageId ? messages.find(message => message.id === lead.messageId && message.direction === 'inbound' && (!lead.accountId || message.accountId === lead.accountId)) : undefined;
  const verifiedLead = facts.lead && !!lead;
  const legacyRecords = customer.legacyRecords || (customer.messages === undefined ? [customer] : []);
  const legacyLead = facts.lead ? legacyRecords.find(record => record.target && validDate(record.contactedAt) && validDate(record.leadAt) && record.evidence?.trim()) : undefined;
  const legacyContacts = legacyRecords.filter(record => record.target && validDate(record.contactedAt));
  const hasReply = messages.some(message => message.direction === 'inbound');
  return createPortal(<div className="nc-drawer-backdrop" onClick={onClose}>
    <aside ref={panel} className="nc-drawer" role="dialog" aria-modal="true" aria-labelledby="customer-detail-title" onClick={event => event.stopPropagation()}>
      <header className="nc-drawer-header"><div><span className="nc-eyebrow">CUSTOMER DETAIL</span><h2 id="customer-detail-title">潜客详情</h2></div><button ref={close} className="icon-button" aria-label="关闭潜客详情" onClick={onClose}><X size={20} /></button></header>
      <div className="nc-drawer-body">
        <p className="nc-demo-notice">演示数据 · 客户、来源和沟通记录均为原型示例，未连接真实抖音。详情保留完整历史，列表状态按当前筛选范围计算。</p>
        <section className="nc-detail-section"><h3>客户信息</h3><div className="nc-identity"><CustomerAvatar customer={customer} /><div><strong>{customer.nickname || '昵称暂无数据'}</strong><span>{customer.platformId ? `抖音标识：${customer.platformId}` : '抖音标识：暂无数据'}</span></div><span className="nc-status">{facts.status}</span></div>
          <dl className="nc-info-grid"><div><dt>所属抖音账号</dt><dd>{accountIds.map(id => accountName(id)).join('、')}</dd></div><div><dt>个人主页</dt><dd>{profile ? <a className="nc-link" href={profile} target="_blank" rel="noopener noreferrer">查看公开主页 <ExternalLink size={12} /></a> : '暂无数据'}</dd></div><div><dt>首次发现</dt><dd>{displayTime(customer.discoveredAt)}</dd></div><div><dt>最近发现</dt><dd>{displayTime(sources.at(-1)?.discoveredAt || customer.discoveredAt)}</dd></div><div className="nc-full-width"><dt>关联任务</dt><dd>{customer.taskIds.length ? customer.taskIds.map(id => taskName(id)).join('、') : '暂无数据'}</dd></div></dl>
          {customer.exclusionReason && <p className="nc-missing">排除原因：{customer.exclusionReason}</p>}
        </section>
        <section className="nc-detail-section"><h3>发现来源与匹配依据 <small>{sources.length} 条来源</small></h3>{sources.length === 0 ? <p className="nc-missing">暂无来源数据，暂未找到充分依据。</p> : sources.map((source, index) => {
          const sourceUrl = validPlatformUrl(source.url);
          return <article className="nc-evidence" key={source.id}><div className="nc-evidence-top"><strong>{index + 1 < 10 ? `0${index + 1}` : index + 1} · {source.type || '来源暂无数据'}</strong>{(source.demo || customer.demo) && <span className="nc-demo-badge">演示数据</span>}</div><p className="nc-meta">{accountName(source.accountId || customer.accountId)} · {taskName(source.taskId)} · {displayTime(source.discoveredAt)}</p><dl className="nc-source-meta"><dt>来源作品</dt><dd>{source.title || '暂无数据'}</dd><dt>作品标识</dt><dd>{source.platformId || '暂无数据'}</dd></dl>{sourceUrl && <a className="nc-link" href={sourceUrl} target="_blank" rel="noopener noreferrer">查看来源 <ExternalLink size={12} /></a>}<div className="nc-raw-evidence"><span>原始证据{source.demo || customer.demo ? ' · 演示数据' : ''}</span><blockquote>{source.text || source.evidenceText || '暂无采集文本，暂未找到充分依据'}</blockquote></div><div className="nc-analysis"><span>AI 分析 · 匹配判断</span><p>{source.matchReason || '暂未找到充分依据'}</p><dl><dt>目标条件</dt><dd>{source.condition || '暂无数据'}</dd><dt>对应证据</dt><dd>{source.evidenceText || source.text || '暂未找到充分依据'}</dd></dl></div></article>;
        })}</section>
        <section className="nc-detail-section"><h3>私信与回复记录 <small>{messages.length} 条记录</small></h3><p className="nc-section-note">保留该客户在当前账号筛选范围内的完整历史，并逐条标明所属账号和任务。计划话术与发送结果分开展示；模拟回执不代表真实平台发送。</p>{messages.length === 0 ? <div className="nc-no-messages"><MessageSquareText size={23} /><p>暂无私信发送记录</p></div> : <ol className="nc-message-timeline">{messages.map(message => {
          const inbound = message.direction === 'inbound';
          const statusText = inbound ? '已记录回复' : message.status === 'success' ? '发送成功' : message.status === 'failed' ? '发送失败' : message.status === 'queued' ? '待发送' : '状态待确认';
          const contentLabel = inbound ? '对方回复原文' : message.status === 'queued' ? '计划话术 · 尚未发送' : message.status === 'success' ? '实际发送内容' : message.status === 'failed' ? '发送尝试内容 · 未成功' : '发送尝试内容 · 未取得平台确认';
          return <li className={`nc-message ${inbound ? 'inbound' : 'outbound'}`} key={message.id}><div className="nc-message-top"><strong>{inbound ? '对方回复' : '我方发送'}</strong><span className={`nc-send-status ${message.status}`}>{statusText}</span></div><p className="nc-meta">{displayTime(message.at)} · {accountName(message.accountId || customer.accountId)} · {taskName(message.taskId)}</p><span className="nc-demo-badge">演示数据 · {inbound ? '模拟回复' : message.status === 'queued' ? '模拟待发送' : '模拟发送'}</span><div className="nc-message-content"><span>{contentLabel}</span><p>{message.text || '暂无完整消息文本'}</p></div>{!inbound && message.status !== 'queued' && message.plannedText && <details className="nc-planned"><summary>查看发送前计划话术{message.plannedText !== message.text ? '（与最终内容不同）' : ''}</summary><p>{message.plannedText}</p></details>}{!inbound && message.status === 'unknown' && <p className="nc-missing">未取得平台确认，不计入成功触达。</p>}{message.reason && <p className="nc-missing">{message.status === 'failed' ? '失败原因' : '执行说明'}：{message.reason}</p>}{message.receiptId && <p className="nc-meta">模拟执行标识：{message.receiptId}</p>}{message.executionId && <p className="nc-meta">执行批次：{message.executionId}</p>}</li>;
        })}</ol>}{legacyContacts.length > 0 && <div className="nc-legacy-records"><p className="nc-missing">历史汇总记录 · 演示数据。完整发送文本、原始回执与消息明细尚未完整，不会补写历史消息。</p>{legacyContacts.map(record => <p className="nc-meta" key={`${record.accountId}:${record.id}`}>{accountName(record.accountId)} · 历史触达时间：{displayTime(record.contactedAt)}</p>)}</div>}{!hasReply && <p className="nc-missing">暂无回复记录</p>}</section>
        <section className="nc-detail-section"><h3>留资信息与依据</h3>{verifiedLead && lead ? <div className="nc-lead-evidence"><div className="nc-evidence-top"><strong>已留资</strong><span className="nc-demo-badge">演示数据 · 模拟留资</span></div><dl className="nc-info-grid"><div className="nc-full-width"><dt>所属账号 / 首次识别时间</dt><dd>{accountName(lead.accountId || customer.accountId)} · {displayTime(lead.at)}</dd></div>{lead.contact && <div className="nc-full-width"><dt>虚构演示联系方式</dt><dd>{lead.demo ? lead.contact : '联系方式未获展示授权'}</dd></div>}<div className="nc-full-width"><dt>留资依据</dt><dd>{lead.text}</dd></div>{leadMessage && <div className="nc-full-width"><dt>关联回复原文</dt><dd>「{leadMessage.text}」<span className="nc-meta"> · {displayTime(leadMessage.at)}</span></dd></div>}</dl></div> : legacyLead ? <div className="nc-lead-evidence"><div className="nc-evidence-top"><strong>已留资 · 历史汇总记录</strong><span className="nc-demo-badge">演示数据</span></div><dl className="nc-info-grid"><div><dt>首次识别时间</dt><dd>{displayTime(legacyLead.leadAt)}</dd></div><div><dt>所属账号</dt><dd>{accountName(legacyLead.accountId)}</dd></div><div className="nc-full-width"><dt>已保存的留资依据</dt><dd>{legacyLead.evidence}</dd></div></dl><p className="nc-missing">原始消息与详细依据尚未完整，暂无可展示的联系方式。</p></div> : <p className="nc-missing">尚未识别到有效留资。仅有回复或询价不视为留资。</p>}</section>
      </div>
    </aside>
  </div>, document.body);
}
