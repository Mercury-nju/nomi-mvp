export type Section = 'chat' | 'work' | 'results' | 'accounts' | 'knowledge' | 'conversations';
export type Channel = 'dm' | 'live_mention' | 'video_comment';
export interface Plan {
  name: string; target: string; region: string; signals: string; sourceType: 'keyword_comments' | 'account_comments' | 'live_chat';
  keywords: string[]; sourceUrl: string; scheduleMode: 'once' | 'daily'; scheduleTime: string; limit: number; observeSeconds: number;
  mode: 'find' | 'contact'; channel: Channel; authorized: boolean; communicationStrategy: string;
  workKeywords: string[]; maxWorks: number; maxComments: number; scanLimit: number;
}
export interface Task { id: string; plan: Plan; status: string; createdAt: string; updatedAt?: string; lastRunAt?: string; nextRunAt?: string; executions?: Execution[] }
export interface Execution { id: string; taskId: string; status: string; startedAt: string; finishedAt?: string; steps: { name: string; status: string; time?: string; reason?: string }[]; analyzed: number; targeted: number; contacted: number; leads: number; reason?: string; error?: string }
export interface Source { id?: string; taskId?: string; type?: string; title?: string; url?: string; platformId?: string; text?: string; evidenceText?: string; discoveredAt?: string; matchReason?: string; evidencePath?: string }
export interface CustomerMessage { id?: string; taskId?: string; channel?: Channel; text: string; at?: string; status: string; direction?: string; reason?: string; evidencePath?: string; evidence?: string; receiptId?: string; confirmationLevel?: string; verification?: { at?: string; status?: string; identityVerified?: boolean; complete?: boolean; outgoingTextCount?: number; evidencePath?: string } }
export interface Match {status: string; reasons?: string[]; missing?: string[]}
export interface Customer { id: string; taskIds?: string[]; platformId?: string; nickname?: string; profileUrl?: string; avatarUrl?: string; sources?: Source[]; messages?: CustomerMessage[]; match?: Match; matches?: Record<string,Match>; target?: boolean; discoveredAt?: string }
export interface Account { connected?: boolean; status?: string; nickname?: string; name?: string; handle?: string; reason?: string; message?: string; browserOpen?: boolean; profileUrl?: string }
export interface AgentEvent { id?: number; type?: string; kind?: string; taskId?: string; executionId?: string; at?: string; time?: string; message?: string; data?: Record<string, unknown> }
export type Knowledge = Record<string, string>;
