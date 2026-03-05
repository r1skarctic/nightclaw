import type { AgentMessage } from "@mariozechner/pi-agent-core";

/**
 * Strip `thinkingSignature` from thinking content blocks in an assistant message
 * before it is persisted to the session transcript.
 *
 * Only removes the signature when the block carries human-readable plaintext
 * (`thinking` is a non-empty string). Blocks without plaintext (e.g. encrypted /
 * binary-only blobs) are left untouched so providers that rely on the opaque
 * signature can still replay them correctly.
 */
export function stripThinkingSignatureForPersistence(message: AgentMessage): AgentMessage {
  if ((message as { role?: unknown }).role !== "assistant") {
    return message;
  }
  const assistant = message as Extract<AgentMessage, { role: "assistant" }>;
  if (!Array.isArray(assistant.content)) {
    return message;
  }

  let changed = false;
  const nextContent = assistant.content.map((block) => {
    const b = block as Record<string, unknown>;
    if (
      b["type"] !== "thinking" ||
      typeof b["thinking"] !== "string" ||
      b["thinking"].length === 0
    ) {
      return block;
    }
    if (!("thinkingSignature" in b)) {
      return block;
    }
    changed = true;
    const { thinkingSignature: _dropped, ...rest } = b;
    return rest as typeof block;
  });

  if (!changed) {
    return message;
  }
  // Spread-replace content; double assertion is required because TypeScript cannot
  // verify the spread satisfies the discriminated-union shape without widening first.
  return { ...assistant, content: nextContent } as unknown as AgentMessage;
}
