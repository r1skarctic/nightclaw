import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { processFile } from "../../scripts/strip-thinking-signature.js";
import { stripThinkingSignatureForPersistence } from "./persist-strip-thinking.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AppendMessage = Parameters<SessionManager["appendMessage"]>[0];
const asMsg = (m: unknown) => m as AppendMessage;

function getPersistedMessages(sm: SessionManager): AgentMessage[] {
  return sm
    .getEntries()
    .filter((e) => e.type === "message")
    .map((e) => (e as { message: AgentMessage }).message);
}

function makeAssistantWithThinking(opts?: {
  thinkingText?: string;
  thinkingSignature?: string;
}): AgentMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "thinking",
        thinking: opts?.thinkingText ?? "I need to reason through this.",
        ...(opts?.thinkingSignature !== undefined
          ? { thinkingSignature: opts.thinkingSignature }
          : {}),
      },
      { type: "text", text: "Here is my answer." },
    ],
    // oxlint-disable-next-line typescript/no-explicit-any
  } as any;
}

// ---------------------------------------------------------------------------
// Unit tests: stripThinkingSignatureForPersistence
// ---------------------------------------------------------------------------

describe("stripThinkingSignatureForPersistence", () => {
  it("strips thinkingSignature from a thinking block that has plaintext thinking", () => {
    const msg = makeAssistantWithThinking({ thinkingSignature: "encrypted-sig" });
    const result = stripThinkingSignatureForPersistence(msg);
    const content = (result as { content: Array<Record<string, unknown>> }).content;
    const block = content.find((b) => b["type"] === "thinking");
    expect(block).toBeDefined();
    expect(block?.["thinking"]).toBe("I need to reason through this.");
    expect("thinkingSignature" in (block ?? {})).toBe(false);
  });

  it("preserves thinking block when no thinkingSignature is present", () => {
    const msg = makeAssistantWithThinking({ thinkingSignature: undefined });
    const result = stripThinkingSignatureForPersistence(msg);
    expect(result).toBe(msg); // same reference — no allocation
  });

  it("does NOT strip thinkingSignature when thinking text is absent", () => {
    const msg: AgentMessage = {
      role: "assistant",
      content: [
        // encrypted-only block: no plaintext thinking field
        { thinkingSignature: "encrypted-sig" } as unknown,
      ],
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;
    const result = stripThinkingSignatureForPersistence(msg);
    const content = (result as { content: Array<Record<string, unknown>> }).content;
    const block = content[0];
    expect(block?.["thinkingSignature"]).toBe("encrypted-sig");
  });

  it("does NOT strip thinkingSignature when thinking text is an empty string", () => {
    const msg: AgentMessage = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "", thinkingSignature: "sig" }],
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;
    const result = stripThinkingSignatureForPersistence(msg);
    const content = (result as { content: Array<Record<string, unknown>> }).content;
    expect(content[0]?.["thinkingSignature"]).toBe("sig");
  });

  it("passes through non-assistant messages unchanged", () => {
    const user: AgentMessage = {
      role: "user",
      content: "hello",
      timestamp: Date.now(),
    };
    expect(stripThinkingSignatureForPersistence(user)).toBe(user);
  });

  it("passes through text blocks in assistant messages unchanged", () => {
    const msg: AgentMessage = {
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;
    const result = stripThinkingSignatureForPersistence(msg);
    expect(result).toBe(msg);
  });
});

// ---------------------------------------------------------------------------
// Integration: thinkingSignature is stripped when persisted via the guard
// ---------------------------------------------------------------------------

describe("installSessionToolResultGuard – thinkingSignature stripped on persist", () => {
  it("strips thinkingSignature from assistant thinking blocks on appendMessage", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm, {
      transformMessageForPersistence: stripThinkingSignatureForPersistence,
    });

    sm.appendMessage(asMsg(makeAssistantWithThinking({ thinkingSignature: "secret-sig-abc" })));

    const messages = getPersistedMessages(sm);
    expect(messages).toHaveLength(1);
    const content = (messages[0] as { content: Array<Record<string, unknown>> }).content;
    const thinkingBlock = content.find((b) => b["type"] === "thinking");
    expect(thinkingBlock).toBeDefined();
    expect(thinkingBlock?.["thinking"]).toBe("I need to reason through this.");
    expect("thinkingSignature" in (thinkingBlock ?? {})).toBe(false);
  });

  it("preserves encrypted-only thinking blocks without plaintext", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm, {
      transformMessageForPersistence: stripThinkingSignatureForPersistence,
    });

    const encryptedBlock: AgentMessage = {
      role: "assistant",
      content: [
        // No "thinking" text field — should be left alone
        { thinkingSignature: "opaque-blob" } as unknown,
      ],
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;
    sm.appendMessage(asMsg(encryptedBlock));

    const messages = getPersistedMessages(sm);
    const content = (messages[0] as { content: Array<Record<string, unknown>> }).content;
    expect(content[0]?.["thinkingSignature"]).toBe("opaque-blob");
  });
});

// ---------------------------------------------------------------------------
// Disk scrubber: processFile
// ---------------------------------------------------------------------------

describe("processFile (disk scrubber)", () => {
  function writeTempJsonl(lines: unknown[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strip-thinking-test-"));
    const file = path.join(dir, "session.jsonl");
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
    return file;
  }

  function readJsonlLines(file: string): unknown[] {
    return fs
      .readFileSync(file, "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  }

  it("strips thinkingSignature from assistant thinking blocks and reports stats", () => {
    const file = writeTempJsonl([
      { type: "session", id: "sess1" },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "plan", thinkingSignature: "big-base64-blob" },
            { type: "text", text: "answer" },
          ],
        },
      },
    ]);

    const result = processFile(file);
    expect(result.updated).toBe(true);
    expect(result.blocksStripped).toBe(1);
    expect(result.bytesSaved).toBeGreaterThan(0);

    const lines = readJsonlLines(file);
    const msgLine = lines.find((l) => (l as { type?: string }).type === "message") as {
      message: { content: Array<Record<string, unknown>> };
    };
    const block = msgLine.message.content.find((b) => b["type"] === "thinking");
    expect(block?.["thinkingSignature"]).toBeUndefined();
    expect(block?.["thinking"]).toBe("plan");
  });

  it("does not modify files without applicable thinking blocks", () => {
    const originalLines = [
      { type: "session", id: "sess2" },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
        },
      },
    ];
    const file = writeTempJsonl(originalLines);
    const beforeMtime = fs.statSync(file).mtimeMs;

    const result = processFile(file);
    expect(result.updated).toBe(false);
    expect(result.blocksStripped).toBe(0);
    expect(result.bytesSaved).toBe(0);

    // File should not be rewritten
    const afterMtime = fs.statSync(file).mtimeMs;
    expect(afterMtime).toBe(beforeMtime);
  });

  it("skips encrypted-only thinking blocks (no plaintext)", () => {
    const file = writeTempJsonl([
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ thinkingSignature: "opaque" }],
        },
      },
    ]);

    const result = processFile(file);
    expect(result.updated).toBe(false);
    expect(result.blocksStripped).toBe(0);

    const lines = readJsonlLines(file);
    const msg = lines[0] as { message: { content: Array<Record<string, unknown>> } };
    expect(msg.message.content[0]?.["thinkingSignature"]).toBe("opaque");
  });

  it("handles multiple blocks and multiple messages in one file", () => {
    const file = writeTempJsonl([
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "step 1", thinkingSignature: "sig1" },
            { type: "thinking", thinking: "step 2", thinkingSignature: "sig2" },
            { type: "text", text: "result" },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "other", thinkingSignature: "sig3" }],
        },
      },
    ]);

    const result = processFile(file);
    expect(result.updated).toBe(true);
    expect(result.blocksStripped).toBe(3);
  });
});
