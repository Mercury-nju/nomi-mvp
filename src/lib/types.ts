export type TaskStatus = 'running' | 'paused' | 'error';
export type CardStatus = 'pending' | 'confirmed' | 'cancelled' | 'expired';
export interface Account { id: string; name: string; handle: string; connected: boolean; limit: number; color: string; initials: string }
export interface Product { id: string; name: string; description: string; benefits: string; audience: string; price: string; faq: string }
export interface Knowledge { identity: string; brand: string; region: string; service: string; advantage: string; audience: string; purpose: string; style: string; goal: string; cautions: string; products: Product[] }
export interface Task { id: string; accountId: string; name: string; target: string; region: string; signals: string; source: string; schedule: string; dailyQuota: number; mode: 'find' | 'contact'; status: TaskStatus; enabled: boolean; createdAt: string; conversationId: string; revision: number; communicationStrategy?: string }
export interface CustomerSource {
  id: string; taskId: string; executionId?: string; accountId?: string; type: string;
  title?: string; url?: string; platformId?: string; text?: string; discoveredAt: string;
  matchReason?: string; condition?: string; evidenceText?: string; targeted?: boolean; contactApplicable?: boolean; demo?: boolean;
}
export interface CustomerMessage {
  id: string; taskId: string; executionId?: string; accountId?: string; direction: 'outbound' | 'inbound';
  text: string; at: string; status: 'success' | 'failed' | 'unknown' | 'queued' | 'received';
  plannedText?: string; reason?: string; receiptId?: string; demo: boolean;
}
export interface CustomerLeadEvidence {
  text: string; at: string; messageId?: string; contact?: string; taskId?: string; executionId?: string; accountId?: string; demo: boolean;
}
export interface Customer {
  id: string; accountId: string; taskIds: string[]; discoveredAt: string; target: boolean;
  contactedAt?: string; leadAt?: string; evidence?: string;
  platformId?: string; nickname?: string; avatarUrl?: string; profileUrl?: string;
  sources?: CustomerSource[]; messages?: CustomerMessage[]; leadEvidence?: CustomerLeadEvidence;
  exclusionReason?: string; demo?: boolean;
}
export interface Execution { id: string; taskId: string; startedAt: string; status: 'pending' | 'running' | 'completed' | 'partial' | 'failed'; analyzed: number; targeted: number; contacted: number; leads: number; steps: { name: string; status: 'completed' | 'failed' | 'pending'; time: string; reason?: string }[]; reason?: string }
export interface Plan { name: string; target: string; region: string; signals: string; source: string; schedule: string; dailyQuota: number; mode: 'find' | 'contact'; authorized: boolean; communicationStrategy?: string }
export interface ChatCard { id: string; type: 'business' | 'requirements' | 'plan' | 'conflict' | 'success' | 'adjust'; status: CardStatus; plan?: Plan; taskId?: string; taskRevision?: number; knowledge?: Knowledge; allocations?: Record<string, number>; resultTaskId?: string; accountRevision?: string; desiredEnabled?: boolean }
export interface Message { id: string; role: 'user' | 'assistant'; text: string; card?: ChatCard }
export interface Conversation { id: string; accountId: string; title: string; messages: Message[]; createdAt: string }
export interface AppState { version: number; accounts: Account[]; knowledge: Record<string, Knowledge>; tasks: Task[]; customers: Customer[]; executions: Execution[]; conversations: Conversation[]; activeConversation: Record<string, string>; selectedAccountId: string; loggedIn: boolean }
export interface TaskInput extends Plan { accountId: string; conversationId: string }
export interface Metrics { analyzed: number; targeted: number; contacted: number; leads: number }
