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
type Host = { modelContext?: ModelContext; registerTool?: (tool: unknown) => unknown };

/**
 * Finds wherever this browser put the tool registry.
 *
 * The current proposal uses document.modelContext. Earlier experiments used
 * navigator.modelContext, and some builds exposed registerTool directly on
 * either host. All four are accepted so older bridges keep working, while the
 * standards-shaped document entry point wins when both are present.
 */
export function modelContext(): ModelContext | null {
  const scope = globalThis as unknown as { navigator?: Host; document?: Host };

  for (const host of [scope.document, scope.navigator]) {
    if (!host) continue;
    if (host.modelContext && typeof host.modelContext.registerTool === 'function') return host.modelContext;
    if (typeof host.registerTool === 'function') return host as ModelContext;
  }
  return null;
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

/** Wraps a tool so a thrown error reaches the caller as something readable. */
function wrap(tool: McpTool): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    execute: async (input: Record<string, unknown> = {}) => {
      try {
        return await tool.execute(input ?? {});
      } catch (error) {
        // A thrown error would be opaque. A described one is actionable.
        return errorResult(error instanceof Error ? error.message : 'That did not work.');
      }
    },
  };
}

/** Registers into a context that is known to exist. Failures are per tool. */
function registerInto(context: ModelContext, tools: McpTool[]): number {
  let registered = 0;
  for (const tool of tools) {
    try {
      context.registerTool?.(wrap(tool));
      registered += 1;
    } catch {
      // Already registered, or unsupported. Either way, carry on.
    }
  }
  return registered;
}

/** How long to keep watching for a context that has not appeared yet. */
const WAIT_MS = 10_000;
const POLL_MS = 250;

/**
 * Registers a set of tools.
 *
 * The registry usually exists before any page script runs, in which case this
 * is immediate. But an agent runtime injected by an extension can arrive a
 * moment after the page has loaded, and a site that only looked once would
 * offer that agent nothing at all, silently. So when the registry is missing,
 * this watches briefly for it to appear rather than giving up.
 *
 * A browser that never provides one is the normal case, and costs a handful of
 * checks over ten seconds before the watch stops.
 */
export function registerTools(tools: McpTool[]): number {
  const context = modelContext();
  if (context) return registerInto(context, tools);

  if (typeof setInterval !== 'function') return 0;

  const started = Date.now();
  const timer = setInterval(() => {
    const found = modelContext();
    if (found) {
      clearInterval(timer);
      registerInto(found, tools);
      return;
    }
    if (Date.now() - started > WAIT_MS) clearInterval(timer);
  }, POLL_MS);

  return 0;
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
