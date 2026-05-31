/**
 * Minimal structured logger.
 *
 * The MCP stdio transport owns stdout — any output there would corrupt the
 * JSON-RPC stream. So this logger writes exclusively to stderr. It keeps the
 * same `log.info / log.warn / log.fail` shape the agent adapter calls, but
 * drops the durable-file / telemetry machinery the original bridge carried.
 */

export type LogFields = Record<string, unknown>;

type Level = 'info' | 'warn' | 'error';

/** Set MCP_BRIDGE_DEBUG=1 to surface info lines on stderr. */
const DEBUG =
  process.env.MCP_BRIDGE_DEBUG === '1' || process.env.MCP_BRIDGE_DEBUG === 'true';

function emit(level: Level, phase: string, event: string, fields: LogFields = {}): void {
  if (level === 'info' && !DEBUG) return;
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    phase,
    event,
    ...fields,
  };
  try {
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  } catch {
    /* logging must never crash the server */
  }
}

export const log = {
  info(phase: string, event: string, fields?: LogFields): void {
    emit('info', phase, event, fields);
  },
  warn(phase: string, event: string, fields?: LogFields): void {
    emit('warn', phase, event, fields);
  },
  fail(phase: string, err: unknown, fields?: LogFields): void {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    emit('error', phase, 'fail', { ...fields, err: message, stack });
  },
};
