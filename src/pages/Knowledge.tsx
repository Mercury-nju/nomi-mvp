import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, BookOpen, Building2, Check, ChevronDown, FileText, MessageSquareText, Pencil, Plus, Sparkles, X } from 'lucide-react';
import { useStore } from '../lib/store';
import { emptyKnowledge, uid } from '../lib/domain';
import type { Knowledge, Product } from '../lib/types';
import './Management.css';

const profileFields = [
  ['identity', '账号身份', '例如：产品顾问、门店主理人'],
  ['brand', '所属机构 / 品牌', '填写已确认的机构或品牌名称'],
  ['region', '服务地区', '例如：杭州及周边地区'],
  ['service', '服务内容', '介绍你实际提供的产品或服务'],
  ['advantage', '核心优势', '填写有事实依据的优势'],
  ['audience', '目标客户概要', '描述适合你的产品或服务的人群'],
  ['purpose', '触达目的', '例如：了解需求，在用户愿意时提供咨询'],
] as const;
const communicationFields = [
  ['style', '沟通风格', '例如：专业、亲切、简洁，先回应用户的问题'],
  ['goal', '沟通目标', '例如：了解需求，在对方愿意时获得联系方式'],
  ['cautions', '注意事项', '填写沟通边界、不能承诺的内容和其他要求'],
] as const;
const productFields = [
  ['name', '产品名称', '产品或服务的真实名称'],
  ['description', '简要介绍', '介绍产品或服务的主要内容'],
  ['benefits', '核心卖点', '填写已确认、有依据的卖点'],
  ['audience', '适合人群', '描述适用条件和人群'],
  ['price', '价格信息', '未确认可留空，不会自动生成价格'],
  ['faq', '常见问题', '可直接粘贴已确认的常见问答'],
] as const;
type Editor = 'profile' | 'communication' | 'product' | null;
const blankProduct = (): Product => ({ id: '', name: '', description: '', benefits: '', audience: '', price: '', faq: '' });

export default function KnowledgePage() {
  const { state, transact, selectAccount, notify } = useStore();
  const [editor, setEditor] = useState<Editor>(null);
  const [draft, setDraft] = useState<Knowledge>(emptyKnowledge());
  const [productDraft, setProductDraft] = useState<Product>(blankProduct());
  const [editingAccountId, setEditingAccountId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const dialogOrigin = useRef<HTMLElement | null>(null);
  const account = state.accounts.find(item => item.id === state.selectedAccountId);
  const knowledge = account ? state.knowledge[account.id] ?? emptyKnowledge() : emptyKnowledge();
  const filled = profileFields.filter(([key]) => knowledge[key].trim()).length;

  useEffect(() => {
    if (!editor) return;
    const modal = document.querySelector<HTMLElement>('.knowledge-editor');
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
  }, [editor]);

  function edit(next: Editor, product?: Product) {
    if (!account) return;
    dialogOrigin.current = document.activeElement as HTMLElement;
    setEditingAccountId(account.id);
    setDraft(structuredClone(knowledge));
    setProductDraft(product ? { ...product } : blankProduct());
    setError('');
    setEditor(next);
  }

  function save() {
    if (!editor || busy) return;
    if (state.selectedAccountId !== editingAccountId) { setError('当前账号已切换，请关闭弹窗后重新编辑。'); return; }
    if (editor === 'product' && (productDraft.name.trim().length < 2 || productDraft.description.trim().length < 2)) { setError('请至少填写清楚的产品名称和简要介绍（各不少于 2 个字符）。'); return; }
    const fields = editor === 'profile' ? profileFields : communicationFields;
    if (editor !== 'product' && !fields.some(([key]) => draft[key].trim().length >= 2)) { setError('请至少填写一项有效业务信息（不少于 2 个字符）。'); return; }
    setBusy(true);
    const saved = transact(next => {
      if (!next.accounts.some(item => item.id === editingAccountId)) throw new Error('账号不存在，请重新选择账号');
      const existing = next.knowledge[editingAccountId] ?? emptyKnowledge();
      if (editor === 'product') {
        const product = { ...productDraft, id: productDraft.id || uid('product') };
        for (const [key] of productFields) product[key] = product[key].trim();
        const index = existing.products.findIndex(item => item.id === product.id);
        if (index >= 0) existing.products[index] = product;
        else existing.products.push(product);
      } else {
        for (const [key] of fields) existing[key] = draft[key].trim();
      }
      next.knowledge[editingAccountId] = existing;
    });
    setBusy(false);
    if (saved) { setEditor(null); notify('知识库已保存，仅影响该账号后续生成的建议与话术'); }
  }

  return <div className="page management-page knowledge-page">
    <header className="page-header"><div><div className="eyebrow">BUSINESS CONTEXT</div><h1 className="page-title">知识库</h1><p className="page-description">让每次沟通，都基于你真实的业务。</p></div>{state.accounts.length > 0 && <label className="knowledge-account-select"><span>当前抖音账号</span><div><select aria-label="知识库所属抖音账号" className="select" value={account?.id ?? ''} onChange={event => { setEditor(null); selectAccount(event.target.value); }}>{state.accounts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><ChevronDown size={15} /></div></label>}</header>
    {!account ? <div className="empty-state panel"><BookOpen size={32} /><h3>先添加一个抖音账号</h3><p>每个账号都有独立的业务档案、产品资料和沟通要求。</p><Link className="button primary" to="/douyin-accounts">添加抖音账号<ArrowUpRight size={16} /></Link></div> : <>
      <div className="knowledge-context"><div className="avatar" style={{ background: `${account.color}15`, color: account.color }}>{account.initials}</div><div><b>{account.name}</b><span>抖音号：{account.handle}</span></div><span className="badge gray">账号独立知识库</span><span className="knowledge-demo-label">演示数据</span></div>
      <section className="panel knowledge-section">
        <div className="knowledge-section-header"><div className="knowledge-section-title"><div className="module-icon"><Building2 size={19} /></div><div><h2>账号档案</h2><p>我是谁，为谁提供什么服务</p></div></div><button className="button secondary" onClick={() => edit('profile')}><Pencil size={14} />编辑</button></div>
        {filled === 0 ? <div className="knowledge-inline-empty"><p>还没有业务档案。先告诉智能体你的身份和服务，避免沟通时缺少依据。</p><button className="button ghost" onClick={() => edit('profile')}>完善业务信息<ArrowUpRight size={15} /></button></div> : <dl className="knowledge-profile-grid">{profileFields.map(([key, label]) => <div key={key}><dt>{label}</dt><dd className={!knowledge[key] ? 'not-filled' : ''}>{knowledge[key] || '尚未填写'}</dd></div>)}</dl>}
      </section>

      <section className="panel knowledge-section">
        <div className="knowledge-section-header"><div className="knowledge-section-title"><div className="module-icon"><FileText size={19} /></div><div><h2>产品资料 <span className="module-count">{knowledge.products.length}</span></h2><p>让建议与话术，有清晰的产品依据</p></div></div><button className="button secondary" onClick={() => edit('product')}><Plus size={15} />添加产品</button></div>
        {knowledge.products.length === 0 ? <div className="knowledge-inline-empty"><p>添加你真实提供的产品或服务。未确认的价格、资质和效果可以留空。</p><button className="button ghost" onClick={() => edit('product')}>添加第一份产品资料<ArrowUpRight size={15} /></button></div> : <div className="knowledge-products">{knowledge.products.map(product => <article className="knowledge-product" key={product.id}>
          <div className="product-card-heading"><div className="product-file-icon"><FileText size={19} /></div><h3>{product.name}</h3><button className="icon-button" aria-label={`编辑产品：${product.name}`} onClick={() => edit('product', product)}><Pencil size={15} /></button></div>
          <p className="product-description">{product.description || '尚未填写介绍'}</p>
          <dl>{productFields.slice(2).map(([key, label]) => <div key={key}><dt>{label}</dt><dd className={!product[key] ? 'not-filled' : ''}>{product[key] || '尚未填写'}</dd></div>)}</dl>
        </article>)}</div>}
      </section>

      <section className="panel knowledge-section">
        <div className="knowledge-section-header"><div className="knowledge-section-title"><div className="module-icon"><MessageSquareText size={19} /></div><div><h2>沟通要求</h2><p>明确语气、目标和不能越过的边界</p></div></div><button className="button secondary" onClick={() => edit('communication')}><Pencil size={14} />编辑</button></div>
        <dl className="communication-grid">{communicationFields.map(([key, label]) => <div key={key}><dt>{label}</dt><dd className={!knowledge[key] ? 'not-filled' : ''}>{knowledge[key] || '尚未填写，后续不会推测你的沟通要求。'}</dd></div>)}</dl>
      </section>
      <div className="knowledge-bottom-note"><Sparkles size={16} /><p>保存后，同一账号的新建议与话术会使用这些资料。历史消息与已有任务配置保留。</p><Link to="/chat">去对话<ArrowUpRight size={15} /></Link></div>
    </>}

    {editor && <div className="modal-backdrop" onClick={() => !busy && setEditor(null)} onKeyDown={event => { if (event.key === 'Escape' && !busy) setEditor(null); }}><section className="modal knowledge-editor" role="dialog" aria-modal="true" aria-labelledby="knowledge-editor-title" onClick={event => event.stopPropagation()}><div className="modal-header"><div><div className="eyebrow">{account?.name}</div><h2 id="knowledge-editor-title">{editor === 'profile' ? '编辑账号档案' : editor === 'communication' ? '编辑沟通要求' : productDraft.id ? '编辑产品资料' : '添加产品资料'}</h2></div><button className="icon-button" aria-label="关闭编辑弹窗" onClick={() => setEditor(null)} disabled={busy}><X size={20} /></button></div>
      <form onSubmit={event => { event.preventDefault(); save(); }}><p className="editor-intro">只填写已确认的信息。暂不明确的内容可以留空，智能体不会补写价格或效果承诺。</p><div className={`form-grid knowledge-editor-fields ${editor === 'communication' ? 'single-column' : ''}`}>
        {editor === 'product' ? productFields.map(([key, label, placeholder], index) => <label className={`form-field ${key === 'faq' ? 'full-width' : ''}`} key={key}>{label}{(key === 'name' || key === 'description') && <span className="required-marker"> *</span>}{key === 'name' ? <input autoFocus value={productDraft[key]} placeholder={placeholder} required maxLength={100} onChange={event => setProductDraft({ ...productDraft, [key]: event.target.value })} /> : <textarea autoFocus={index === 0} value={productDraft[key]} placeholder={placeholder} rows={key === 'faq' ? 3 : 2} maxLength={3000} onChange={event => setProductDraft({ ...productDraft, [key]: event.target.value })} required={key === 'description'} />}</label>) : (editor === 'profile' ? profileFields : communicationFields).map(([key, label, placeholder], index) => <label className={`form-field ${editor === 'profile' && key === 'purpose' ? 'full-width' : ''}`} key={key}>{label}<textarea autoFocus={index === 0} rows={editor === 'communication' ? 3 : 2} maxLength={3000} value={draft[key]} placeholder={placeholder} onChange={event => setDraft({ ...draft, [key]: event.target.value })} /></label>)}
      </div>{error && <p className="form-error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="button secondary" onClick={() => setEditor(null)}>取消</button><button type="submit" className="button primary" disabled={busy}><Check size={16} />{busy ? '正在保存…' : '保存资料'}</button></div></form>
    </section></div>}
  </div>;
}
