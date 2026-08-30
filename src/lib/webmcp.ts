/**
 * Registering an app's own capabilities with WebMCP.
 *
 * The site-wide component describes the catalogue: what each tool is for and
 * where its data lives. That lets an agent find the right page, and no more.
 * This is the other half. Each app page registers the things it can actually
 * do, so an agent that has arrived at Ordinate can render a chart rather than
 * read a paragraph about charts.
 *
 * Everything runs in the visitor's browser against the visitor's own storage.
 * No tool here reaches the network.
 */

export type JsonSchema = {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
};

export type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

export type McpTool = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  execute: (input: Record<string, unknown>) => Promise<ToolResult> | ToolResult;
};

type ModelContext = { registerTool?: (tool: unknown) => unknown };

/** The proposal has moved between navigator and document; accept either. */
export function modelContext(): ModelContext | null {
  const scope = globalThis as unknown as { navigator?: ModelContext; document?: ModelContext };
  const found = scope.navigator ?? null;
  const candidate = (found && typeof found.registerTool === 'function' ? found : null)
    ?? (scope.document && typeof scope.document.registerTool === 'function' ? scope.document : null);
  return candidate ?? null;
}

export function textResult(value: unknown): ToolResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value, replacer, 2);
  return { content: [{ type: 'text', text: text ?? '' }] };
}

export function errorResult(message: string, detail?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message, ...detail }, replacer, 2) }],
    isError: true,
  };
}

/** BigInt and typed arrays turn up in results and would otherwise throw. */
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return `<${value.length} bytes>`;
  return value;
}

/**
 * Wraps binary output so an agent can use it. A data URI is the only form that
 * survives a text channel, and the size is stated because a caller deciding
 * whether to fetch six megabytes should be told first.
 */
export function fileResult(
  filename: string, bytes: Uint8Array, mime: string, extra: Record<string, unknown> = {},
): ToolResult {
  return textResult({
    filename,
    mime,
    bytes: bytes.length,
    dataUri: `data:${mime};base64,${toBase64(bytes)}`,
    ...extra,
  });
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/**
 * Registers a set of tools, catching failures one at a time.
 *
 * A browser that does not implement the proposal, or one where a name is
 * already taken, must not stop the app from mounting. This is an extra
 * surface, not a requirement.
 */
export function registerTools(tools: McpTool[]): number {
  const context = modelContext();
  if (!context?.registerTool) return 0;

  let registered = 0;
  for (const tool of tools) {
    try {
      context.registerTool({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        execute: async (input: Record<string, unknown> = {}) => {
          try {
            return await tool.execute(input ?? {});
          } catch (error) {
            // A thrown error would be opaque to the caller. A described one is
            // something an agent can act on.
            return errorResult(error instanceof Error ? error.message : 'That did not work.');
          }
        },
      });
      registered += 1;
    } catch {
      // Already registered, or unsupported. Either way, carry on.
    }
  }
  return registered;
}

// --------------------------------------------------------------------- input helpers

export function readString(input: Record<string, unknown>, key: string, fallback = ''): string {
  const value = input[key];
  return typeof value === 'string' ? value : fallback;
}

export function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`"${key}" is required and must be a non-empty string.`);
  }
  return value;
}

export function readNumber(input: Record<string, unknown>, key: string, fallback: number): number {
  const value = input[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

export function readBoolean(input: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = input[key];
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

export function readEnum<T extends string>(
  input: Record<string, unknown>, key: string, allowed: readonly T[], fallback: T,
): T {
  const value = input[key];
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

export function readStringArray(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
  if (typeof value === 'string') return value.split(',').map((entry) => entry.trim()).filter(Boolean);
  return [];
}

/** Trims a long result so a tool cannot flood a context window unannounced. */
export function truncate<T>(items: T[], limit: number): { items: T[]; total: number; truncated: boolean } {
  return {
    items: items.slice(0, limit),
    total: items.length,
    truncated: items.length > limit,
  };
}
