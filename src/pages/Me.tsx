import { useEffect, useRef, useState } from 'react';
import { Activity, ArrowUpRight, Check, CheckCircle2, ChevronRight, CircleHelp, CreditCard, Layers3, LogOut, ShieldCheck, Wallet, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useStore } from '../lib/store';
import { todayContacts } from '../lib/domain';
import './Management.css';

export default function Me() {
  const { state, transact, notify } = useStore();
  const [dialog, setDialog] = useState<'recharge' | 'benefits' | 'logout' | null>(null);
  const [busy, setBusy] = useState(false);
  const dialogOrigin = useRef<HTMLElement | null>(null);
  const recent = [...state.executions].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 5);
  const sent = todayContacts(state);
  const taskCount = state.tasks.length;
  const running = state.tasks.filter(task => task.status === 'running').length;

  function openDialog(next: 'recharge' | 'benefits' | 'logout') {
    dialogOrigin.current = document.activeElement as HTMLElement;
    setDialog(next);
  }

  useEffect(() => {
    if (!dialog) return;
    const modal = document.querySelector<HTMLElement>('.personal-modal');
    const controls = () => [...(modal?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]') ?? [])];
    if (!modal?.contains(document.activeElement)) controls()[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = controls();
      const first = items[0]; const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', trap);
    return () => { document.removeEventListener('keydown', trap); dialogOrigin.current?.focus(); };
  }, [dialog]);

  function logout() {
    if (busy) return;
    setBusy(true);
    const saved = transact(draft => { draft.loggedIn = false; });
    setBusy(false);
    if (saved) { setDialog(null); notify('已退出演示产品账号，本地演示数据保留'); }
  }

  return <div className="page management-page me-page">
    <header className="page-header"><div><div className="eyebrow">YOUR WORKSPACE</div><h1 className="page-title">个人中心</h1><p className="page-description">你的账户、套餐与使用情况。</p></div><span className="badge gray">演示数据</span></header>

    <section className="panel personal-account"><div className="personal-avatar">演</div><div className="personal-identity"><div><h2>演示用户</h2><span className="badge green"><CheckCircle2 size={12} />已登录</span></div><p>产品账号 · demo-user</p></div><button className="button secondary" onClick={() => openDialog('logout')}><LogOut size={15} />退出登录</button></section>

    <div className="personal-cards">
      <section className="panel plan-card"><div className="personal-card-label"><Layers3 size={18} /><span>订阅套餐</span></div><div className="plan-title"><h2>演示套餐</h2><span className="badge gray">原型体验</span></div><p className="personal-card-description">体验从找客计划到留资结果的完整工作流程</p><div className="plan-details"><div><span>套餐有效期</span><strong>2026.12.31 <small>（演示）</small></strong></div><div><span>已绑定抖音账号</span><strong>{state.accounts.length}<small> / 5 个</small></strong></div></div><button className="button secondary" onClick={() => openDialog('benefits')}>查看当前权益<ArrowUpRight size={15} /></button></section>
      <section className="panel wallet-card"><div className="personal-card-label"><Wallet size={18} /><span>充值与用量</span></div><div className="wallet-value">未接入计费</div><p className="personal-card-description">演示环境不产生费用，也不关联真实余额。</p><div className="wallet-notice"><ShieldCheck size={18} /><p>商业定价与正式计费方式待确认。<br />当前所有操作仅用于产品演示。</p></div><button className="button primary" onClick={() => openDialog('recharge')}><CreditCard size={16} />查看充值演示</button></section>
    </div>

    <section className="panel usage-section"><div className="knowledge-section-header"><div className="knowledge-section-title"><div className="module-icon"><Activity size={19} /></div><div><h2>使用情况</h2><p>来自当前演示状态的实际记录</p></div></div><Link className="button ghost" to="/results">查看结果<ArrowUpRight size={15} /></Link></div><div className="personal-usage-grid"><div><span>已绑定抖音账号</span><strong>{state.accounts.length}<small> / 5</small></strong></div><div><span>定时任务</span><strong>{taskCount}<small> 个</small></strong></div><div><span>正常运行的任务</span><strong>{running}<small> 个</small></strong></div><div><span>今日实际成功触达</span><strong>{sent}<small> 人</small></strong></div></div>
      <div className="recent-usage-header"><h3>最近执行记录</h3><span>执行用量，不代表计费账单</span></div>
      {recent.length === 0 ? <div className="knowledge-inline-empty"><p>还没有执行记录。创建任务后，可在定时任务中心中查看每轮执行。</p><Link className="button ghost" to="/chat">开始找客户<ArrowUpRight size={15} /></Link></div> : <div className="recent-usage-list">{recent.map(execution => {
        const task = state.tasks.find(item => item.id === execution.taskId);
        const account = state.accounts.find(item => item.id === task?.accountId);
        const labels = { pending: '待执行', running: '执行中', completed: '已完成', partial: '部分完成', failed: '执行失败' };
        return <Link className="recent-usage-row" to={`/work/${execution.taskId}`} key={execution.id}><div className="usage-record-icon"><Activity size={16} /></div><div className="usage-record-name"><b>{task?.name ?? '历史任务'}</b><span>{account?.name ?? '历史账号'} · {new Date(execution.startedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</span></div><div className="usage-record-data"><span>分析 <b>{execution.analyzed}</b></span><span>成功触达 <b>{execution.contacted}</b></span></div><span className={`badge ${execution.status === 'completed' ? 'green' : execution.status === 'failed' ? 'red' : 'gray'}`}>{labels[execution.status]}</span><ChevronRight size={16} /></Link>;
      })}</div>}
    </section>
    <p className="management-footnote"><CircleHelp size={15} />此处展示产品登录账号。抖音业务身份的连接与登出，请前往<Link to="/douyin-accounts">抖音账号</Link>管理。</p>

    {dialog && <div className="modal-backdrop" onClick={() => !busy && setDialog(null)} onKeyDown={event => { if (event.key === 'Escape' && !busy) setDialog(null); }}><section className="modal personal-modal" role="dialog" aria-modal="true" aria-labelledby="personal-dialog-title" onClick={event => event.stopPropagation()}><div className="modal-header"><div><div className="eyebrow">DEMO WORKSPACE</div><h2 id="personal-dialog-title">{dialog === 'recharge' ? '充值演示' : dialog === 'benefits' ? '当前套餐权益' : '退出产品账号？'}</h2></div><button className="icon-button" aria-label="关闭弹窗" onClick={() => setDialog(null)} disabled={busy}><X size={20} /></button></div>
      {dialog === 'recharge' ? <><div className="recharge-illustration"><CreditCard size={34} /></div><h3 className="recharge-title">演示交互，未接入真实支付</h3><p className="dialog-description">正式充值金额、余额和计费细则尚未确定。这里不会扣款，也不会生成订单或充值成功记录。</p><div className="demo-connection-note"><ShieldCheck size={19} /><div><b>当前可直接体验演示功能</b><p>添加最多 5 个模拟账号，验证任务创建、额度冲突与留资统计。</p></div></div><div className="modal-actions"><button className="button primary" onClick={() => setDialog(null)}>了解，返回</button></div></> : dialog === 'benefits' ? <><p className="dialog-description">以下均为原型演示权益，不代表正式商业套餐。</p><ul className="benefits-list"><li><Check size={17} /><div><b>最多管理 5 个抖音账号</b><span>当前已添加 {state.accounts.length} 个，剩余 {5 - state.accounts.length} 个名额</span></div></li><li><Check size={17} /><div><b>独立对话与业务知识库</b><span>每个账号的业务资料、会话和任务分别管理</span></div></li><li><Check size={17} /><div><b>定时找客与结果追踪</b><span>体验任务计划、执行记录、成功触达与留资漏斗</span></div></li><li><Check size={17} /><div><b>本地保存演示进度</b><span>刷新可继续；没有连接真实抖音服务</span></div></li></ul><div className="modal-actions"><button className="button primary" onClick={() => setDialog(null)}>知道了</button></div></> : <><p className="dialog-description">确认退出当前演示账号？本地的任务、知识库和历史结果会保留，你可以重新进入演示。</p><div className="modal-actions"><button className="button secondary" onClick={() => setDialog(null)}>取消</button><button className="button danger" onClick={logout} disabled={busy}><LogOut size={15} />确认退出</button></div></>}
    </section></div>}
  </div>;
}
