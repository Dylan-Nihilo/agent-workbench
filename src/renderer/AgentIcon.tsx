import codex from './assets/agents/codex.svg';
import claude from './assets/agents/claudecode.svg';
import opencode from './assets/agents/opencode.svg';
import gemini from './assets/agents/geminicli.svg';
import type { AgentId } from '../shared/types';

const marks: Record<AgentId, string> = { codex, claude, opencode, gemini };

export function AgentIcon({ agent, size = 20 }: { agent: AgentId; size?: number }) {
  const mask = `url("${marks[agent]}")`;
  return (
    <span
      className="agent-icon"
      data-agent={agent}
      aria-hidden="true"
      style={{ width: size, height: size, maskImage: mask, WebkitMaskImage: mask }}
    />
  );
}
