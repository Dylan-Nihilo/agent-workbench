import codex from './assets/agents/codex-color.svg';
import claude from './assets/agents/claudecode-color.svg';
import opencode from './assets/agents/opencode.svg';
import gemini from './assets/agents/geminicli-color.svg';
import type { AgentId } from '../shared/types';

const marks: Record<AgentId, string> = { codex, claude, opencode, gemini };

export function AgentIcon({ agent, size = 20 }: { agent: AgentId; size?: number }) {
  return (
    <img
      className="agent-icon"
      data-agent={agent}
      src={marks[agent]}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
    />
  );
}
