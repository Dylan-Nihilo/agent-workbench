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
  tabId?: string;
  frameId?: string;
  documentId?: string;
  nodeId?: string;
  tag: string;
  role?: string;
  name: string;
  selector?: string;
  text?: string;
  value?: string;
  shadowPath?: string[];
  bounds?: { x: number; y: number; width: number; height: number };
}

export const ELEMENT_STYLE_PROPERTIES = [
  'color',
  'background-color',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'text-align',
  'text-decoration',
  'white-space',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border',
  'border-color',
  'border-width',
  'border-style',
  'border-radius',
  'width',
  'height',
  'min-width',
  'min-height',
  'max-width',
  'max-height',
  'display',
  'opacity',
  'gap',
  'row-gap',
  'column-gap',
  'flex-direction',
  'justify-content',
  'align-items',
  'background',
  'background-image',
  'background-size',
  'background-position',
  'background-repeat',
  'box-shadow',
  'text-shadow',
  'transform',
  'transform-origin',
  'filter',
] as const;
export const ELEMENT_ANIMATION_PROPERTIES = [
  'transform',
  'opacity',
  'box-shadow',
  'filter',
  'color',
  'background-color',
] as const;
export const ELEMENT_BACKGROUND_FUNCTIONS = [
  'linear-gradient',
  'radial-gradient',
  'conic-gradient',
  'repeating-linear-gradient',
  'repeating-radial-gradient',
  'repeating-conic-gradient',
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'hwb',
  'lab',
  'lch',
  'oklab',
  'oklch',
  'color',
  'color-mix',
  'light-dark',
  'calc',
  'min',
  'max',
  'clamp',
] as const;
export const ELEMENT_PREVIEW_LIMITS = {
  styleCount: 30,
  styleValueLength: 500,
  keyframesMin: 2,
  keyframesMax: 12,
  durationMin: 100,
  durationMax: 60_000,
  iterationsMax: 100,
  easingLength: 200,
  stepsMax: 1000,
} as const;
export const ELEMENT_UNSAFE_CSS_PATTERN = String.raw`(?:url|image-set|-webkit-image-set|var|attr|paint|expression)\s*\(|javascript\s*:|!\s*important|\/\*|\*\/|@|[;{}<>\\]`;

export interface ElementAnimation {
  keyframes: Array<{ offset?: number; styles: Record<string, string> }>;
  duration: number;
  iterations?: number | 'infinite';
  easing?: string;
  direction?: 'normal' | 'reverse' | 'alternate' | 'alternate-reverse';
}
export interface ElementDetails extends ElementRef {
  documentId: string;
  textContent: string;
  editableText: boolean;
  editReason?: string;
  attributes: Record<string, string>;
  computed: Record<string, string>;
  ancestors: ElementRef[];
  shadowPath: string[];
  animation?: ElementAnimation | null;
  animationState?: 'running' | 'paused' | 'finished' | 'idle' | 'reduced-motion';
}
export interface ElementQuery {
  selector?: string;
  text?: string;
  role?: string;
  exact?: boolean;
  limit?: number;
}
export interface ElementQueryResult {
  documentId: string;
  elements: ElementRef[];
  truncated: boolean;
}
export interface ElementEdit {
  text?: string;
  styles?: Record<string, string>;
  animation?: ElementAnimation | null;
}
export interface ElementEditResult {
  editId: string;
  element: ElementDetails;
}
export interface ElementPreview {
  editId: string;
  tabId: string;
  frameId: string;
  documentId: string;
  nodeId: string;
  changes: ElementEdit;
}
export interface RecordedStep {
  id: string;
  kind: 'navigate' | 'click' | 'fill' | 'select' | 'key' | 'scroll' | 'edit' | 'undo';
  description: string;
  timestamp: number;
  url: string;
  source: 'human' | 'agent';
  target?: Partial<ElementRef>;
  value?: string;
  tabId?: string;
  frameId?: string;
  editId?: string;
}
export interface Recording {
  id: string;
  title: string;
  startedAt: number;
  endedAt?: number;
  steps: RecordedStep[];
  summary?: string;
}
export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}
export interface BrowserState {
  status: 'missing' | 'starting' | 'ready' | 'error' | 'stopped';
  engine: 'browseros';
  tabs: BrowserTab[];
  activeTabId?: string;
  binaryPath?: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  recording: boolean;
  inspecting: boolean;
  selectedElement?: ElementRef;
  previewEdits?: ElementPreview[];
  error?: string;
}
export interface BrowserFrame {
  data: string;
  width: number;
  height: number;
  tabId?: string;
}
export type BrowserInput = (
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
  | { type: 'resize'; width: number; height: number }
) & { tabId?: string };
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
export interface UserInputRequest {
  id: string;
  questions: Array<{
    id: string;
    header: string;
    question: string;
    isSecret: boolean;
    isOther?: boolean;
    options?: Array<{ label: string; description: string }>;
  }>;
}
export type PendingAgentRequest =
  | { conversationId: string; messageId: string; kind: 'approval'; request: ApprovalRequest }
  | { conversationId: string; messageId: string; kind: 'input'; request: UserInputRequest };
export type AgentEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool'; call: ToolCall }
  | {
      type: 'status';
      status: 'starting' | 'thinking' | 'working' | 'waiting' | 'idle';
      label?: string;
    }
  | { type: 'approval'; request: ApprovalRequest }
  | { type: 'user-input'; request: UserInputRequest }
  | { type: 'request-resolved'; id: string }
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
  agentToolsFingerprint?: string;
  previousAgentSessionIds?: string[];
  workspace?: string;
  remoteChatId?: string;
}
export interface FeishuState {
  status: 'restoring' | 'disconnected' | 'configuring' | 'connecting' | 'connected' | 'error';
  hasSavedCredentials?: boolean;
  restoreFailed?: boolean;
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
  pendingRequests?: PendingAgentRequest[];
}
export type AppEvent =
  | { type: 'browser:state'; state: BrowserState }
  | { type: 'browser:frame'; frame: BrowserFrame }
  | { type: 'browser:step'; step: RecordedStep }
  | { type: 'browser:selected'; element: ElementRef }
  | { type: 'recording:saved'; recording: Recording }
  | { type: 'agent:event'; conversationId: string; messageId: string; event: AgentEvent }
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
