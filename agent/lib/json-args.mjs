/**
 * Recovery for structured tool arguments that arrive as JSON strings.
 *
 * Some model/server combinations (notably Qwen-style XML tool calls behind an
 * OpenAI-compatible server) send a nested array/object parameter as a string
 * when the model's JSON for it does not parse. The usual culprit on long
 * payloads is a dropped closing bracket at the very end (e.g. a plan of 13
 * goals ending in `"]}` instead of `"]}]`). The schema validator then reports
 * `goals.0: must be object`, which tells the model nothing useful, and the
 * model tends to burn turns "testing the encoding".
 *
 * `prepareArguments` runs before validation (pi-agent-core). For every
 * top-level parameter whose schema is an array or object but whose value is a
 * string, we JSON.parse it; if that fails, we try to close unbalanced brackets
 * at the end; if that fails too, we throw an error that says exactly what is
 * wrong so the model can fix it in one retry.
 */

/** @param {unknown} schema */
function structuredType(schema) {
  const t = /** @type {any} */ (schema)?.type;
  return t === "array" || t === "object" ? t : null;
}

/**
 * Close brackets left open at the end of `text`. Returns null when the text is
 * not a plain truncation (mismatched closer, unterminated string, or nothing
 * to close).
 * @param {string} text
 */
export function closeUnbalancedJson(text) {
  const stack = [];
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[") stack.push("]");
    else if (ch === "{") stack.push("}");
    else if (ch === "]" || ch === "}") {
      if (stack.pop() !== ch) return null;
    }
  }
  if (inString || stack.length === 0) return null;
  return text.trimEnd() + stack.reverse().join("");
}

/**
 * Parse a string that should hold JSON of the given type.
 * @param {string} value
 * @param {"array"|"object"} type
 * @returns {{ ok: true, value: unknown, repaired: boolean } | { ok: false, error: string }}
 */
export function parseStructuredString(value, type) {
  const matches = (v) => (type === "array" ? Array.isArray(v) : v !== null && typeof v === "object" && !Array.isArray(v));
  const text = value.trim();
  let firstError;
  try {
    const parsed = JSON.parse(text);
    if (matches(parsed)) return { ok: true, value: parsed, repaired: false };
    return { ok: false, error: `it holds JSON of the wrong type (expected ${type})` };
  } catch (e) {
    firstError = /** @type {Error} */ (e).message;
  }
  const closed = closeUnbalancedJson(text);
  if (closed) {
    try {
      const parsed = JSON.parse(closed);
      if (matches(parsed)) return { ok: true, value: parsed, repaired: true };
    } catch {
      // fall through to the original error
    }
  }
  return { ok: false, error: `it is not valid JSON (${firstError})` };
}

/**
 * Build a `prepareArguments` hook for a tool's parameter schema, or null when
 * the tool has no structured top-level parameters.
 * @param {any} parameters
 * @param {string} toolName
 * @param {(msg: string) => void} [log]
 */
export function makeJsonArgPreparer(parameters, toolName, log) {
  const props = parameters?.properties || {};
  const structured = Object.entries(props)
    .map(([key, schema]) => [key, structuredType(schema)])
    .filter(([, type]) => type);
  if (structured.length === 0) return null;
  return (args) => {
    if (!args || typeof args !== "object") return args;
    let next = args;
    for (const [key, type] of structured) {
      const value = args[key];
      if (typeof value !== "string") continue;
      const result = parseStructuredString(value, /** @type {any} */ (type));
      if (!result.ok) {
        throw new Error(
          `Parameter "${key}" of ${toolName} must be a JSON ${type}, but it arrived as a string and ${result.error}. ` +
            `This is an encoding problem in your tool call, not a size limit: resend the same content with "${key}" ` +
            `as a proper ${type} and check that every bracket is closed (especially the final "${type === "array" ? "]" : "}"}").`,
        );
      }
      if (result.repaired) log?.(`[json-args] ${toolName}.${key}: closed unbalanced brackets in a stringified ${type}`);
      if (next === args) next = { ...args };
      next[key] = result.value;
    }
    return next;
  };
}

/**
 * Attach JSON-string recovery to a tool, unless it already prepares its own
 * arguments or has no structured parameters.
 * @template T
 * @param {T & { name: string, parameters?: any, prepareArguments?: Function }} tool
 * @param {(msg: string) => void} [log]
 * @returns {T}
 */
export function withJsonArgRecovery(tool, log) {
  if (tool.prepareArguments) return tool;
  const prepare = makeJsonArgPreparer(tool.parameters, tool.name, log);
  return prepare ? { ...tool, prepareArguments: prepare } : tool;
}
