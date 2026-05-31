// Public exports — lets external code embed the MCP server or reuse the
// async task scheduler / Claude adapter directly.
export { startMcpServer } from './transports/mcp/server';
export type { McpServerOptions } from './transports/mcp/server';
export { TaskRegistry } from './transports/mcp/task-registry';
export type {
  TaskStatus,
  TaskSnapshot,
  TaskEventRecord,
} from './transports/mcp/task-registry';
export { ClaudeAdapter } from './agent/claude/adapter';
export type {
  AgentAdapter,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from './agent/types';
