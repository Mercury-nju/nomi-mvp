import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AppState } from './types';
import { createSeed } from './seed';

const STORAGE_KEY = 'sales-agent-demo-v1';
type Store = {
  state: AppState;
  transact: (recipe: (draft: AppState) => void) => boolean;
  selectAccount: (id: string) => void;
  notify: (message: string) => void;
};
const StoreContext = createContext<Store | null>(null);

export function restoreState(saved: string): AppState {
  const state = JSON.parse(saved) as AppState;
  if (state.version !== 1 || !Array.isArray(state.accounts) || !Array.isArray(state.tasks) || !Array.isArray(state.customers) || !Array.isArray(state.conversations) || !Array.isArray(state.executions) || typeof state.knowledge !== 'object' || !state.activeConversation) throw new Error('Invalid demo state');
  // V1.1 fields are optional: preserve saved history and user edits without inventing missing evidence.
  return state;
}

function loadState(): { state: AppState; error?: string } {
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get('reset') === 'demo') {
      localStorage.removeItem(STORAGE_KEY);
      url.searchParams.delete('reset');
      window.history.replaceState(null, '', url);
      return { state: createSeed() };
    }
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return { state: createSeed() };
    return { state: restoreState(saved) };
  } catch {
    return { state: createSeed(), error: '无法读取已保存的演示数据，已载入基准数据；请检查浏览器存储权限。' };
  }
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [initial] = useState(loadState);
  const [state, setState] = useState(initial.state);
  const stateRef = useRef(state);
  const [toast, setToast] = useState<{ message: string; tone: 'success' | 'error' } | null>(initial.error ? { message: initial.error, tone: 'error' } : null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((message: string, tone: 'success' | 'error' = 'success') => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setToast({ message, tone });
    timerRef.current = setTimeout(() => setToast(null), 5000);
  }, []);
  const notify = useCallback((message: string) => showToast(message), [showToast]);
  const transact = useCallback((recipe: (draft: AppState) => void): boolean => {
    try {
      const draft = structuredClone(stateRef.current);
      recipe(draft);
      // Persist before commit: a storage failure must not look like a saved operation.
      localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
      stateRef.current = draft;
      setState(draft);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : '操作失败，请重试。';
      showToast(error instanceof DOMException ? '保存失败：浏览器本地存储不可用或空间不足。输入内容已保留，请重试。' : message, 'error');
      return false;
    }
  }, [showToast]);
  const selectAccount = useCallback((id: string) => {
    transact(draft => {
      if (!draft.accounts.some(account => account.id === id)) throw new Error('所选抖音账号不存在。');
      draft.selectedAccountId = id;
    });
  }, [transact]);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
  return <StoreContext.Provider value={{ state, transact, selectAccount, notify }}>
    {children}
    {toast && <div className="global-toast" data-tone={toast.tone} role={toast.tone === 'error' ? 'alert' : 'status'} style={{ position: 'fixed', zIndex: 1000, bottom: 28, left: '50%', transform: 'translateX(-50%)', padding: '13px 20px', maxWidth: 'min(620px, 90vw)', borderRadius: 10, color: toast.tone === 'error' ? '#9c3030' : '#fff', background: toast.tone === 'error' ? '#fff2f1' : '#172b4d', border: toast.tone === 'error' ? '1px solid #f1c8c4' : '1px solid #172b4d', boxShadow: '0 8px 28px #172b4d20', fontSize: 14 }}>{toast.message}</div>}
  </StoreContext.Provider>;
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore must be used within StoreProvider.');
  return store;
}
