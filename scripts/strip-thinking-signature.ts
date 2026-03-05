#!/usr/bin/env bun
/**
 * One-shot disk scrubber: strip `thinkingSignature` from session .jsonl files.
 *
 * Usage:
 *   bun scripts/strip-thinking-signature.ts <file.jsonl> [file2.jsonl ...]
 *   bun scripts/strip-thinking-signature.ts ~/.openclaw/agents/main/sessions/*.jsonl
 *
 * For every line in each file, any assistant message content block of type "thinking"
 * that carries human-readable plaintext (`thinking` is a non-empty string) has its
 * `thinkingSignature` field removed.  Blocks without plaintext are left untouched.
 * Files are overwritten in place only when changes are found.
 *
 * Output example:
 *   2 file(s) processed, 1 updated
 *   blocks stripped: 4  bytes saved: 12,345
 */

import fs from "node:fs";
import { pathToFileURL } from "node:url";

function stripThinkingSignatureFromBlock(block: unknown): { block: unknown; changed: boolean } {
  if (!block || typeof block !== "object") {
    return { block, changed: false };
  }
  const b = block as Record<string, unknown>;
  if (b["type"] !== "thinking" || typeof b["thinking"] !== "string" || b["thinking"].length === 0) {
    return { block, changed: false };
  }
  if (!("thinkingSignature" in b)) {
    return { block, changed: false };
  }
  const { thinkingSignature: _dropped, ...rest } = b;
  return { block: rest, changed: true };
}

function stripThinkingSignatureFromLine(raw: string): {
  line: string;
  blocksStripped: number;
  bytesSaved: number;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { line: raw, blocksStripped: 0, bytesSaved: 0 };
  }

  if (!parsed || typeof parsed !== "object") {
    return { line: raw, blocksStripped: 0, bytesSaved: 0 };
  }

  const entry = parsed as Record<string, unknown>;

  // Session JSONL wraps messages in { type: "message", message: { ... } }
  // or stores them directly as { role: "assistant", ... }.
  // Handle both shapes.
  const messageObj =
    entry["type"] === "message" && entry["message"] && typeof entry["message"] === "object"
      ? (entry["message"] as Record<string, unknown>)
      : entry;

  if (messageObj["role"] !== "assistant") {
    return { line: raw, blocksStripped: 0, bytesSaved: 0 };
  }

  if (!Array.isArray(messageObj["content"])) {
    return { line: raw, blocksStripped: 0, bytesSaved: 0 };
  }

  let blocksStripped = 0;
  const nextContent = messageObj["content"].map((block: unknown) => {
    const res = stripThinkingSignatureFromBlock(block);
    if (res.changed) {
      blocksStripped++;
    }
    return res.block;
  });

  if (blocksStripped === 0) {
    return { line: raw, blocksStripped: 0, bytesSaved: 0 };
  }

  const nextMessage = { ...messageObj, content: nextContent };
  const nextEntry =
    entry["type"] === "message" && entry["message"]
      ? { ...entry, message: nextMessage }
      : nextMessage;

  const newLine = JSON.stringify(nextEntry);
  const bytesSaved = Buffer.byteLength(raw, "utf8") - Buffer.byteLength(newLine, "utf8");
  return { line: newLine, blocksStripped, bytesSaved };
}

/**
 * Process a single .jsonl file in place.
 * Returns stats about what was changed.
 */
export function processFile(filePath: string): {
  updated: boolean;
  blocksStripped: number;
  bytesSaved: number;
} {
  const content = fs.readFileSync(filePath, "utf-8");
  const rawLines = content.split("\n");

  let totalBlocksStripped = 0;
  let totalBytesSaved = 0;
  const newLines: string[] = [];
  let changed = false;

  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      newLines.push(rawLine);
      continue;
    }
    const res = stripThinkingSignatureFromLine(trimmed);
    if (res.blocksStripped > 0) {
      changed = true;
      totalBlocksStripped += res.blocksStripped;
      totalBytesSaved += res.bytesSaved;
      // Preserve original trailing whitespace context: replace the trimmed payload
      newLines.push(res.line);
    } else {
      newLines.push(rawLine);
    }
  }

  if (changed) {
    fs.writeFileSync(filePath, newLines.join("\n"), "utf-8");
  }

  return {
    updated: changed,
    blocksStripped: totalBlocksStripped,
    bytesSaved: totalBytesSaved,
  };
}

function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    process.stderr.write(
      "Usage: strip-thinking-signature.ts <file.jsonl> [file2.jsonl ...]\n" +
        "Example: bun scripts/strip-thinking-signature.ts ~/.openclaw/agents/main/sessions/*.jsonl\n",
    );
    process.exit(1);
  }

  let totalUpdated = 0;
  let totalBlocksStripped = 0;
  let totalBytesSaved = 0;
  let totalErrors = 0;

  for (const file of files) {
    try {
      const result = processFile(file);
      if (result.updated) {
        totalUpdated++;
        totalBlocksStripped += result.blocksStripped;
        totalBytesSaved += result.bytesSaved;
        process.stdout.write(
          `  updated: ${file}  (${result.blocksStripped} block(s), ${result.bytesSaved.toLocaleString()} bytes)\n`,
        );
      }
    } catch (err) {
      totalErrors++;
      process.stderr.write(
        `  error: ${file}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  process.stdout.write(
    `\n${files.length} file(s) processed, ${totalUpdated} updated\n` +
      `blocks stripped: ${totalBlocksStripped}  bytes saved: ${totalBytesSaved.toLocaleString()}\n`,
  );

  if (totalErrors > 0) {
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
