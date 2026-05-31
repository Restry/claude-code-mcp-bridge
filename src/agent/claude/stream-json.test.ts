import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../types';
import { translateEvent } from './stream-json';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Translate one raw object into the full list of AgentEvents it produces. */
function translate(raw: unknown): AgentEvent[] {
  return [...translateEvent(raw)];
}

/** Translate a single raw object expecting exactly one event out. */
function translateOne(raw: unknown): AgentEvent {
  const out = translate(raw);
  expect(out).toHaveLength(1);
  return out[0]!;
}

describe('translateEvent — per-type golden assertions', () => {
  it('system/init → system event carrying sessionId, cwd, model', () => {
    const evt = translateOne({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-abc',
      cwd: '/Users/dev/proj',
      model: 'claude-opus-4-8',
      tools: ['Bash', 'Read'],
    });
    expect(evt).toEqual({
      type: 'system',
      sessionId: 'sess-abc',
      cwd: '/Users/dev/proj',
      model: 'claude-opus-4-8',
    });
  });

  it('assistant text block → text delta', () => {
    const evt = translateOne({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello world' }] },
    });
    expect(evt).toEqual({ type: 'text', delta: 'Hello world' });
  });

  it('assistant thinking block → thinking delta', () => {
    const evt = translateOne({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'pondering' }] },
    });
    expect(evt).toEqual({ type: 'thinking', delta: 'pondering' });
  });

  it('assistant tool_use block → tool_use event with id/name/input', () => {
    const evt = translateOne({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'ls -la' } },
        ],
      },
    });
    expect(evt).toEqual({
      type: 'tool_use',
      id: 'toolu_01',
      name: 'Bash',
      input: { command: 'ls -la' },
    });
  });

  it('assistant message with multiple blocks → one event per block, in order', () => {
    const out = translate({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'first' },
          { type: 'tool_use', id: 'toolu_x', name: 'Read', input: { file: 'a.ts' } },
          { type: 'text', text: 'second' },
        ],
      },
    });
    expect(out.map((e) => e.type)).toEqual(['text', 'tool_use', 'text']);
  });

  it('empty text block is dropped (no zero-width delta)', () => {
    const out = translate({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '' }] },
    });
    expect(out).toEqual([]);
  });

  it('user tool_result (success) → tool_result with isError false', () => {
    const evt = translateOne({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'output text' }],
      },
    });
    expect(evt).toEqual({
      type: 'tool_result',
      id: 'toolu_01',
      output: 'output text',
      isError: false,
    });
  });

  it('user tool_result (error) → tool_result with isError true', () => {
    const evt = translateOne({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_02', content: 'boom', is_error: true },
        ],
      },
    });
    expect(evt).toEqual({ type: 'tool_result', id: 'toolu_02', output: 'boom', isError: true });
  });

  it('user tool_result with structured (non-string) content is JSON-stringified', () => {
    const evt = translateOne({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_03', content: [{ type: 'text', text: 'x' }] },
        ],
      },
    }) as Extract<AgentEvent, { type: 'tool_result' }>;
    expect(evt.type).toBe('tool_result');
    expect(evt.output).toBe(JSON.stringify([{ type: 'text', text: 'x' }]));
  });

  it('result with usage → usage event then done event (in that order)', () => {
    const out = translate({
      type: 'result',
      subtype: 'success',
      session_id: 'sess-abc',
      total_cost_usd: 0.0123,
      usage: { input_tokens: 1500, output_tokens: 42 },
    });
    expect(out).toEqual([
      { type: 'usage', inputTokens: 1500, outputTokens: 42, costUsd: 0.0123 },
      { type: 'done', sessionId: 'sess-abc' },
    ]);
  });

  it('result without usage → done only', () => {
    const out = translate({ type: 'result', subtype: 'success', session_id: 'sess-z' });
    expect(out).toEqual([{ type: 'done', sessionId: 'sess-z' }]);
  });

  it('non-object / unknown shapes are ignored', () => {
    expect(translate(null)).toEqual([]);
    expect(translate(undefined)).toEqual([]);
    expect(translate('a string')).toEqual([]);
    expect(translate(42)).toEqual([]);
    expect(translate({ type: 'unknown-future-type' })).toEqual([]);
    expect(translate({ type: 'assistant' })).toEqual([]); // no message
    expect(translate({ type: 'stream_event', event: {} })).toEqual([]);
  });
});

describe('translateEvent — golden NDJSON fixture (full session transcript)', () => {
  const lines = readFileSync(join(__dirname, '__fixtures__', 'claude-stream.ndjson'), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  it('fixture has the expected raw line count', () => {
    expect(lines).toHaveLength(8);
  });

  it('translating the whole transcript yields the expected ordered event stream', () => {
    const events = lines.flatMap((line) => translate(JSON.parse(line)));
    expect(events.map((e) => e.type)).toEqual([
      'system',
      'text',
      'thinking',
      'tool_use',
      'tool_result',
      'tool_result',
      'text',
      'usage',
      'done',
    ]);

    // Spot-check the semantically important fields end to end.
    const system = events[0] as Extract<AgentEvent, { type: 'system' }>;
    expect(system.sessionId).toBe('sess-abc');
    expect(system.model).toBe('claude-opus-4-8');

    const toolUse = events.find((e) => e.type === 'tool_use') as Extract<
      AgentEvent,
      { type: 'tool_use' }
    >;
    expect(toolUse.name).toBe('Bash');
    expect(toolUse.input).toEqual({ command: 'ls -la' });

    const errResult = events.filter((e) => e.type === 'tool_result')[1] as Extract<
      AgentEvent,
      { type: 'tool_result' }
    >;
    expect(errResult.isError).toBe(true);

    const usage = events.find((e) => e.type === 'usage') as Extract<
      AgentEvent,
      { type: 'usage' }
    >;
    expect(usage).toMatchObject({ inputTokens: 1500, outputTokens: 42, costUsd: 0.0123 });

    const done = events.at(-1) as Extract<AgentEvent, { type: 'done' }>;
    expect(done).toEqual({ type: 'done', sessionId: 'sess-abc' });
  });
});
