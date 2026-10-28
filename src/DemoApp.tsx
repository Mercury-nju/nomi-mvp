import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { MessageSquare, Activity, ChartNoAxesCombined, BookOpen, AudioLines, ArrowUpRight, ChevronRight, CircleHelp } from 'lucide-react';
import { useStore } from './lib/store';
import Chat from './pages/Chat';
import Work from './pages/Work';
import Results from './pages/Results';
import Accounts from './pages/Accounts';
import Knowledge from './pages/Knowledge';
import Me from './pages/Me';
import { useState } from 'react';

const navItems = [
  { path: '/chat', label: '提需求', icon: MessageSquare },
  { path: '/work', label: '定时任务中心', icon: Activity },
  { path: '/results', label: '结果中心', icon: ChartNoAxesCombined },
  { path: '/douyin-accounts', label: '账号管理', icon: AudioLines },
  { path: '/knowledge', label: '知识库', icon: BookOpen },
];

export default function App() {
  const { state, transact } = useStore();
  const [help, setHelp] = useState(false);
  const location = useLocation();
  if (!state.loggedIn) return <div className="login-screen"><img className="brand-mark login-mark" src="/logo-transparent.png" alt="产品标志"/><h1>销售个人智能体</h1><p>已退出演示账号。你的本地任务和资料仍然保留。</p><button className="button primary" onClick={() => transact(d => { d.loggedIn = true; })}>进入演示工作台 <ArrowUpRight size={16}/></button><span className="muted">演示交互 · 未接入真实账号认证</span></div>;
  const running = state.tasks.filter(t => t.status === 'running').length;
  const pageName = navItems.find(n => location.pathname.startsWith(n.path))?.label || '个人中心';
  return <div className="app-shell">
    <aside className="sidebar">
      <NavLink to="/chat" className="brand" aria-label="Nomi 首页"><img className="brand-mark" src="/logo-transparent.png" alt=""/><div>Nomi<small>你的专属获客智能体！</small></div></NavLink>
      <nav aria-label="主导航">{navItems.map(({ path, label, icon: Icon }) => <NavLink key={path} to={path} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><Icon size={19} strokeWidth={1.7}/><span>{label}</span>{path === '/work' && running > 0 && <span className="nav-count">{running}</span>}</NavLink>)}</nav>
      <div className="sidebar-bottom">
        <div className="workspace-status"><span className="status-dot"/><div>工作台已就绪<small>{running} 个任务正在按计划运行</small></div></div>
        <button className="help-link" onClick={() => setHelp(true)}><CircleHelp size={17}/> 使用指南 <ArrowUpRight size={14}/></button>
        <NavLink to="/me" className="profile-link"><div className="profile-avatar">演</div><div><strong>演示用户</strong><small>个人工作空间 · 演示套餐</small></div><ChevronRight size={16}/></NavLink>
      </div>
    </aside>
    <main className={`main-workspace ${pageName === '提需求' ? 'chat-workspace' : ''}`}>
      <Routes>
        <Route path="/chat" element={<Chat />}/><Route path="/work" element={<Work />}/><Route path="/work/:taskId" element={<Work />}/><Route path="/results" element={<Results />}/><Route path="/douyin-accounts" element={<Accounts />}/><Route path="/knowledge" element={<Knowledge />}/><Route path="/me" element={<Me />}/><Route path="*" element={<Navigate to="/chat" replace/>}/>
      </Routes>
    </main>
    {help && <div className="modal-backdrop" onClick={() => setHelp(false)}><section className="modal" role="dialog" aria-modal="true" aria-label="使用指南" onClick={e => e.stopPropagation()}><div className="modal-header"><h2>从一句需求开始</h2><button className="icon-button" aria-label="关闭使用指南" onClick={() => setHelp(false)}>×</button></div><ol className="guide-list"><li>在对话页选择抖音账号，说出要找的客户。</li><li>补全业务信息，确认目标、执行时间与触达授权。</li><li>在定时任务中心查看计划，在结果中心查看获客与留资。</li></ol><p className="muted">当前为本地原型，连接、对话与执行记录均为模拟。不会向抖音发送任何私信，也不会产生真实交易。</p><button className="button primary" onClick={() => setHelp(false)}>开始体验</button></section></div>}
  </div>;
}
