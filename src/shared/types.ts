export type AgentId = 'codex' | 'claude' | 'opencode' | 'gemini';
export interface AgentInfo {
  id: AgentId;
  name: string;
  available: boolean;
  supported: boolean;
  path?: string;
  version?: string;
  authentication?: 'ready' | 'missing' | 'unknown';
  detail?: string;
}
export interface ElementRef {
  ref: string;
  tag: string;
  role?: string;
  name: string;
  selector?: string;
  text?: string;
  value?: string;
  bounds?: { x: number; y: number; width: number; height: number };
}
export interface RecordedStep {
  id: string;
  kind: 'navigate' | 'click' | 'fill' | 'select' | 'key' | 'scroll';
  description: string;
  timestamp: number;
  url: string;
  source: 'human' | 'agent';
  target?: Partial<ElementRef>;
  value?: string;
}
export interface Recording {
  id: string;
  title: string;
  startedAt: number;
  endedAt?: number;
  steps: RecordedStep[];
  summary?: string;
}
export interface BrowserState {
  status: 'missing' | 'starting' | 'ready' | 'error' | 'stopped';
  engine: 'browseros';
  binaryPath?: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  recording: boolean;
  inspecting: boolean;
  selectedElement?: ElementRef;
  error?: string;
}
export interface BrowserFrame {
  data: string;
  width: number;
  height: number;
}
export type BrowserInput =
  | {
      type: 'mouse';
      action: 'move' | 'down' | 'up';
      x: number;
      y: number;
      button?: 'left' | 'middle' | 'right';
      clickCount?: number;
      modifiers?: number;
    }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number; modifiers?: number }
  | {
      type: 'key';
      action: 'down' | 'up';
      key: string;
      code: string;
      keyCode?: number;
      modifiers?: number;
      text?: string;
    }
  | { type: 'text'; text: string }
  | { type: 'resize'; width: number; height: number };
export interface BrowserTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export interface ToolResult {
  text: string;
  image?: string;
  isError?: boolean;
}
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  status: 'running' | 'done' | 'error';
  output?: string;
}
export interface ApprovalRequest {
  id: string;
  title: string;
  detail: string;
  kind: 'command' | 'file' | 'other';
}
export type AgentEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool'; call: ToolCall }
  | {
      type: 'status';
      status: 'starting' | 'thinking' | 'working' | 'waiting' | 'idle';
      label?: string;
    }
  | { type: 'approval'; request: ApprovalRequest }
  | { type: 'complete'; text?: string; sessionId?: string }
  | { type: 'error'; message: string };
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
  status?: 'streaming' | 'done' | 'error';
  source?: 'desktop' | 'feishu';
  tools?: ToolCall[];
  context?: string;
}
export interface Conversation {
  id: string;
  title: string;
  updatedAt: number;
  messages: ChatMessage[];
  agentSessionId?: string;
  workspace?: string;
  remoteChatId?: string;
}
export interface FeishuState {
  status: 'disconnected' | 'configuring' | 'connecting' | 'connected' | 'error';
  appId?: string;
  botName?: string;
  paired: boolean;
  pairingCode?: string;
  setupUrl?: string;
  setupQr?: string;
  error?: string;
  lastMessageAt?: number;
}
export interface FeishuMessage {
  id: string;
  text: string;
  senderId: string;
  chatId: string;
  timestamp: number;
}
export interface Settings {
  workspace: string;
  browserPath?: string;
  agent: AgentId;
}
export interface AppSnapshot {
  settings: Settings;
  agents: AgentInfo[];
  browser: BrowserState;
  feishu: FeishuState;
  conversations: Conversation[];
  recordings: Recording[];
  browserFrame?: BrowserFrame;
}
export type AppEvent =
  | { type: 'browser:state'; state: BrowserState }
  | { type: 'browser:frame'; frame: BrowserFrame }
  | { type: 'browser:step'; step: RecordedStep }
  | { type: 'browser:selected'; element: ElementRef }
  | { type: 'recording:saved'; recording: Recording }
  | { type: 'agent:event'; conversationId: string; event: AgentEvent }
  | { type: 'feishu:state'; state: FeishuState }
  | { type: 'conversation:updated'; conversation: Conversation }
  | { type: 'notice'; message: string; level: 'info' | 'error' };
export interface WorkbenchBridge {
  invoke<T = unknown>(action: string, payload?: unknown): Promise<T>;
  onEvent(callback: (event: AppEvent) => void): () => void;
}
declare global {
  interface Window {
    workbench: WorkbenchBridge;
  }
}
