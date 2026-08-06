import type { ToolDefinition, ToolResult } from './tools/types.js';
import type { UserContent } from './types.js';

const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;

/** Convert a host screenshot data URL into provider-native ephemeral vision input. */
export function decodeComputerScreenshot(
  output: string,
): Extract<UserContent, { type: 'image' }> | undefined {
  const match = output.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!match) return undefined;
  const data = match[2].replaceAll(/\s/g, '');
  if (data.length === 0 || data.length > Math.ceil((MAX_SCREENSHOT_BYTES * 4) / 3)) return undefined;
  return {
    type: 'image',
    mediaType: match[1] as Extract<UserContent, { type: 'image' }>['mediaType'],
    data,
  };
}

export type ComputerAction =
  | 'screenshot'
  | 'click'
  | 'type'
  | 'press_key'
  | 'scroll';

export type ComputerActionExecutor = (
  action: ComputerAction,
  input: Record<string, unknown>,
) => Promise<string>;

function numeric(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number.`);
  }
  return value;
}

function text(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${key} must be a non-empty string.`);
  }
  return value;
}

function remoteTool(
  name: string,
  description: string,
  kind: ToolDefinition['kind'],
  inputSchema: Record<string, unknown>,
  summarize: (input: Record<string, unknown>) => string,
  execute: (input: Record<string, unknown>) => Promise<string>,
): ToolDefinition {
  return {
    spec: { name, description, inputSchema },
    kind,
    summarize,
    async execute(input): Promise<ToolResult> {
      return { output: await execute(input) };
    },
  };
}

/**
 * Computer tools execute in the native Mac host, never in Node. The sidecar
 * only brokers bounded requests over its authenticated loopback WebSocket.
 */
export function remoteComputerTools(executor: ComputerActionExecutor): ToolDefinition[] {
  return [
    remoteTool(
      'computer_screenshot',
      'Capture the active Mac display. Returns a current image with its point dimensions.',
      'read',
      { type: 'object', properties: {}, additionalProperties: false },
      () => 'Capture the active display',
      (input) => executor('screenshot', input),
    ),
    remoteTool(
      'computer_click',
      'Click display point coordinates while the user-authorized Computer Use session is active.',
      'command',
      {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          double: { type: 'boolean' },
        },
        required: ['x', 'y'],
        additionalProperties: false,
      },
      (input) => `Click at ${String(input.x)}, ${String(input.y)}`,
      (input) => executor('click', {
        x: numeric(input, 'x'),
        y: numeric(input, 'y'),
        double: input.double === true,
      }),
    ),
    remoteTool(
      'computer_type',
      'Type text into the focused Mac control while Computer Use is active.',
      'command',
      {
        type: 'object',
        properties: { text: { type: 'string', minLength: 1, maxLength: 4000 } },
        required: ['text'],
        additionalProperties: false,
      },
      (input) => `Type ${typeof input.text === 'string' ? input.text.length : 0} characters`,
      (input) => executor('type', { text: text(input, 'text').slice(0, 4000) }),
    ),
    remoteTool(
      'computer_press_key',
      'Press one supported named key while Computer Use is active.',
      'command',
      {
        type: 'object',
        properties: { key: { type: 'string', minLength: 1, maxLength: 40 } },
        required: ['key'],
        additionalProperties: false,
      },
      (input) => `Press ${String(input.key ?? 'a key')}`,
      (input) => executor('press_key', { key: text(input, 'key').slice(0, 40) }),
    ),
    remoteTool(
      'computer_scroll',
      'Scroll at display point coordinates while Computer Use is active.',
      'command',
      {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          delta_y: { type: 'number' },
        },
        required: ['x', 'y', 'delta_y'],
        additionalProperties: false,
      },
      () => 'Scroll the active display',
      (input) => executor('scroll', {
        x: numeric(input, 'x'),
        y: numeric(input, 'y'),
        delta_y: numeric(input, 'delta_y'),
      }),
    ),
  ];
}
