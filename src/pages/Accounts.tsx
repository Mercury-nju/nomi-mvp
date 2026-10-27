import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, ArrowUpRight, Check, CircleHelp, LogOut, RefreshCw, ShieldCheck, UserRound, X } from 'lucide-react';
import { useStore } from '../lib/store';
import { allocation, emptyKnowledge, setAccountConnected, todayContacts, uid } from '../lib/domain';
import './Management.css';

type ConnectionDialog = { type: 'add' } | { type: 'reconnect' | 'disconnect'; id: string };

export default function Accounts() {
  const { state, transact, selectAccount, notify } = useStore();
  const [dialog, setDialog] = useState<ConnectionDialog | null>(null);
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [authorized, setAuthorized] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const dialogOrigin = useRef<HTMLElement | null>(null);
  const maxAccounts = 5;
  const connected = state.accounts.filter(account => account.connected).length;
  const target = dialog && dialog.type !== 'add' ? state.accounts.find(account => account.id === dialog.id) : undefined;

  useEffect(() => {
    if (!dialog) return;
    const modal = document.querySelector<HTMLElement>('.connection-modal');
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

  function open(next: ConnectionDialog) {
    if (next.type === 'add' && state.accounts.length >= maxAccounts) {
      notify('已达到当前演示套餐可添加账号数量上限（5 个）');
      return;
    }
    dialogOrigin.current = document.activeElement as HTMLElement;
    setDialog(next);
    setName('');
    setHandle('');
    setAuthorized(false);
    setError('');
  }

  function connect() {
    if (!dialog || busy) return;
    if (!authorized) { setError('请确认使用模拟连接流程。'); return; }
    if (dialog.type === 'add') {
      const cleanName = name.trim();
      const cleanHandle = handle.trim().replace(/^@+/, '');
      if (cleanName.length < 2 || cleanHandle.length < 2) { setError('请填写至少 2 个字符的昵称和抖音号。'); return; }
      if (state.accounts.some(account => account.handle.replace(/^@+/, '').toLowerCase() === cleanHandle.toLowerCase())) {
        setError('这个抖音号已经添加，请使用另一个账号标识。'); return;
      }
      if (state.accounts.length >= maxAccounts) { setError('已达到当前套餐的 5 个账号上限。'); return; }
      setBusy(true);
      const id = uid('A');
      const saved = transact(draft => {
        if (draft.accounts.length >= maxAccounts || draft.accounts.some(account => account.handle.replace(/^@+/, '').toLowerCase() === cleanHandle.toLowerCase())) throw new Error('账号已存在或数量已达上限');
        draft.accounts.push({ id, name: cleanName, handle: cleanHandle, connected: true, limit: 30, color: '#292824', initials: cleanName.slice(-2) });
        draft.knowledge[id] = emptyKnowledge();
      });
      setBusy(false);
      if (saved) { selectAccount(id); setDialog(null); notify('模拟账号已添加，可以补充知识库或开始对话'); }
    } else if (dialog.type === 'reconnect') {
      setBusy(true);
      const saved = transact(draft => { setAccountConnected(draft, dialog.id, true); });
      setBusy(false);
      if (saved) { setDialog(null); notify('模拟连接已恢复，原先启用的任务可继续执行，未补发历史消息'); }
    }
  }

  function disconnect() {
    if (!dialog || dialog.type !== 'disconnect' || busy) return;
    setBusy(true);
    const saved = transact(draft => { setAccountConnected(draft, dialog.id, false); });
    setBusy(false);
    if (saved) { setDialog(null); notify('账号已登出，相关任务已停止，历史记录保留'); }
  }

  return <div className="page management-page accounts-page">
    <header className="page-header">
      <div><div className="eyebrow">ACCOUNT CONNECTIONS</div><h1 className="page-title">抖音账号</h1><p className="page-description">管理你的业务身份，让每个账号的工作各自有序。</p></div>
      <button className="button primary" onClick={() => open({ type: 'add' })} disabled={state.accounts.length >= maxAccounts}><Plus size={17} />添加抖音账号</button>
    </header>

    <div className="account-overview panel">
      <div className="account-overview-item"><span className="overview-label">已添加账号</span><strong>{state.accounts.length}<small> / {maxAccounts}</small></strong></div>
      <div className="account-overview-item"><span className="overview-label">正常连接</span><strong>{connected}<small> 个</small></strong></div>
      <div className="account-overview-item"><span className="overview-label">今日成功触达</span><strong>{todayContacts(state)}<small> 人</small></strong></div>
      <div className="account-overview-note"><ShieldCheck size={21} /><div><b>账号之间，数据独立</b><span>对话、业务知识和任务分别管理</span></div></div>
    </div>

    <div className="management-section-heading"><h2 className="section-title">已添加的账号 <span>{state.accounts.length}</span></h2><span className="muted">模拟连接 · 演示数据</span></div>
    {state.accounts.length === 0 ? <div className="panel empty-state"><UserRound size={32} /><h3>添加你的第一个抖音账号</h3><p>连接后，即可为这个账号建立知识库并创建找客任务。</p><button className="button primary" onClick={() => open({ type: 'add' })}>添加抖音账号</button></div> : <div className="account-grid">
      {state.accounts.map(account => {
        const tasks = state.tasks.filter(task => task.accountId === account.id);
        const running = tasks.filter(task => task.status === 'running').length;
        const sent = todayContacts(state, account.id);
        const reserved = allocation(state, account.id);
        return <article className={`panel account-card ${!account.connected ? 'account-card-offline' : ''}`} key={account.id}>
          <div className="account-card-top"><div className="account-avatar" style={{ background: `${account.color}15`, color: account.color }}>{account.initials}</div><span className={`badge ${account.connected ? 'green' : 'orange'}`}><span className="status-dot" />{account.connected ? '正常连接' : '已掉线'}</span></div>
          <h3>{account.name}</h3><p className="account-handle">抖音号：{account.handle}</p>
          <div className="account-task-count"><span>已创建任务 <b>{tasks.length}</b></span><span>运行中 <b>{running}</b></span></div>
          <div className="account-quota"><div><span>今日实际成功触达</span><strong>{sent}<small> / {account.limit} 人</small></strong></div><div className="quota-track"><span style={{ width: `${Math.min(100, sent / Math.max(1, account.limit) * 100)}%` }} /></div><p>每日安全执行上限 {account.limit} 人<span>剩余 {Math.max(0, account.limit - sent)} 人</span></p></div>
          <div className="account-allocation"><span>任务计划已分配</span><b>{reserved} / {account.limit} 人/天</b></div>
          {!account.connected && <div className="account-offline-note">连接已中断，原有任务与历史结果保留。</div>}
          <div className="account-card-actions"><Link className="button ghost" to={`/work?account=${account.id}`} onClick={() => selectAccount(account.id)}>查看任务<ArrowUpRight size={15} /></Link>{account.connected ? <button className="button ghost muted" onClick={() => open({ type: 'disconnect', id: account.id })}><LogOut size={15} />登出</button> : <button className="button secondary" onClick={() => open({ type: 'reconnect', id: account.id })}><RefreshCw size={15} />重新登录</button>}</div>
        </article>;
      })}
    </div>}
    <p className="management-footnote"><CircleHelp size={15} />计划分配与实际发送分别统计。暂停或掉线任务仍保留额度；演示上限不代表真实平台规则。</p>
    {state.accounts.length >= maxAccounts && <p className="inline-note">已达到当前演示套餐可添加账号数量上限（5 个）。掉线账号仍占用名额。</p>}

    {dialog && <div className="modal-backdrop" onClick={() => !busy && setDialog(null)} onKeyDown={event => { if (event.key === 'Escape' && !busy) setDialog(null); }}><section className="modal connection-modal" role="dialog" aria-modal="true" aria-labelledby="connection-title" onClick={event => event.stopPropagation()}>
      <div className="modal-header"><div><div className="eyebrow">SIMULATED CONNECTION</div><h2 id="connection-title">{dialog.type === 'add' ? '添加抖音账号' : dialog.type === 'reconnect' ? '重新连接账号' : '确认登出抖音账号？'}</h2></div><button className="icon-button" aria-label="关闭弹窗" onClick={() => setDialog(null)} disabled={busy}><X size={20} /></button></div>
      {dialog.type === 'disconnect' ? <><p className="dialog-description">登出「{target?.name}」后，该账号的任务将停止执行。历史任务、已分配额度和结果会保留，重新登录后可继续。</p><div className="modal-actions"><button className="button secondary" onClick={() => setDialog(null)}>取消</button><button className="button danger" onClick={disconnect} disabled={busy}>确认登出</button></div></> : <form onSubmit={event => { event.preventDefault(); connect(); }}>
        <div className="demo-connection-note"><ShieldCheck size={19} /><div><b>这是原型模拟连接</b><p>无需扫码或提供密码，不会访问真实抖音账号，也不会发送私信。</p></div></div>
        {dialog.type === 'add' ? <div className="form-grid"><label className="form-field">账号昵称<input autoFocus value={name} onChange={event => setName(event.target.value)} placeholder="例如：杭州咨询顾问" maxLength={30} required /></label><label className="form-field">抖音号 / 账号标识<input value={handle} onChange={event => setHandle(event.target.value)} placeholder="输入一个唯一的演示账号标识" maxLength={50} required /></label><p className="form-help">新增账号使用演示上限 30 人/天，可在知识库补充独立业务资料。</p></div> : <div className="reconnect-account"><div className="avatar" style={{ background: `${target?.color}15`, color: target?.color }}>{target?.initials}</div><div><b>{target?.name}</b><span>抖音号：{target?.handle}</span></div></div>}
        <label className="management-checkbox"><input type="checkbox" checked={authorized} onChange={event => setAuthorized(event.target.checked)} /><span>我了解本次为模拟连接，仅用于原型演示。</span></label>
        {dialog.type === 'reconnect' && <p className="form-help">仅恢复原先启用的任务，不会补发掉线期间的消息；主动暂停的任务保持暂停。</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="modal-actions"><button type="button" className="button secondary" onClick={() => setDialog(null)}>取消</button><button type="submit" className="button primary" disabled={busy}><Check size={16} />{busy ? '正在保存…' : '确认模拟连接'}</button></div>
      </form>}
    </section></div>}
  </div>;
}
