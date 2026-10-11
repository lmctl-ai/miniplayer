import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const DEFAULT_FALLBACK_THRESHOLD_TOKENS = 100_000;
export const DEFAULT_THRESHOLD_RATIO = 0.7;

export function estimateContextTokens(messages, lastUsage) {
  if (lastUsage && typeof lastUsage.inputTokens === 'number' && Number.isFinite(lastUsage.inputTokens) && lastUsage.inputTokens > 0) {
    return lastUsage.inputTokens;
  }
  const serialized = JSON.stringify(messages || []);
  return Math.ceil(serialized.length / 4);
}

export function resolveCompactionThreshold({ record, config = {} } = {}) {
  if (config.compact?.thresholdTokens !== undefined) {
    return config.compact.thresholdTokens;
  }
  const totalTokens = record?.context_window?.total_tokens ?? record?.context_window?.input_tokens;
  if (typeof totalTokens === 'number' && totalTokens > 0) {
    const ratio = config.compact?.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO;
    return Math.floor(totalTokens * ratio);
  }
  return DEFAULT_FALLBACK_THRESHOLD_TOKENS;
}

export function findUserTurnIndices(messages = []) {
  const indices = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === 'user') indices.push(i);
  }
  return indices;
}

export function shouldCompact({ messages = [], record, config = {}, lastUsage } = {}) {
  const userIndices = findUserTurnIndices(messages);
  if (userIndices.length <= 2) return false;
  const currentTokens = estimateContextTokens(messages, lastUsage);
  const threshold = resolveCompactionThreshold({ record, config });
  return currentTokens > threshold;
}

export function buildCompactionPrompt(messagesToSummarize) {
  const formatted = messagesToSummarize.map(m => {
    const role = m.role || 'unknown';
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return `[${role}]: ${content}`;
  }).join('\n\n');

  return (
    `You are an expert AI assistant performing session context compaction.\n` +
    `Analyze the conversation history provided below.\n\n` +
    `Extract and return ONLY a valid JSON object with the following schema:\n` +
    `{\n` +
    `  "summary": "Faithful carry-over of goals, decisions, state, open items, and file paths touched so work can continue seamlessly",\n` +
    `  "notes": "Durable knowledge worth keeping across future launches (architecture decisions, conventions, pitfalls, findings) in markdown format"\n` +
    `}\n\n` +
    `Conversation history to summarize:\n${formatted}`
  );
}

function parseCompactionJson(text) {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  }
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON object found in compaction response');
  const parsed = JSON.parse(match[0]);
  if (!parsed || typeof parsed.summary !== 'string' || typeof parsed.notes !== 'string') {
    throw new Error('Compaction JSON response must contain "summary" and "notes" string fields');
  }
  return parsed;
}

export async function compactSessionContext({
  messages = [],
  record,
  config = {},
  cwd = process.cwd(),
  env = process.env,
  generate,
  signal,
  warn,
  stderr = process.stderr,
  lastUsage,
} = {}) {
  const userIndices = findUserTurnIndices(messages);
  if (userIndices.length <= 2) {
    return { compacted: false, messages };
  }

  const currentTokens = estimateContextTokens(messages, lastUsage);
  const threshold = resolveCompactionThreshold({ record, config });
  if (currentTokens <= threshold) {
    return { compacted: false, messages };
  }

  // Preserve the last 2 user turns verbatim
  const splitIndex = userIndices[userIndices.length - 2];
  const toSummarize = messages.slice(0, splitIndex);
  const toKeep = messages.slice(splitIndex);

  try {
    const prompt = buildCompactionPrompt(toSummarize);
    const reply = await generate({
      record,
      prompt,
      config,
      env,
      signal,
      cwd,
      timeoutMs: 0,
      tools: undefined, // no tools for compaction
    });

    const parsed = parseCompactionJson(reply);

    // Format UTC timestamp: yyyy-mm-dd-hhmm
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const hh = String(now.getUTCHours()).padStart(2, '0');
    const min = String(now.getUTCMinutes()).padStart(2, '0');
    const filename = `${yyyy}-${mm}-${dd}-${hh}${min}-session-notes.md`;

    const durableDir = join(cwd, 'durable-memory');
    await mkdir(durableDir, { recursive: true });

    const notesPath = join(durableDir, filename);
    await writeFile(notesPath, parsed.notes.trim() + '\n', 'utf8');

    // Make sure index.md exists and append one-line pointer to it
    const indexPath = join(durableDir, 'index.md');
    const pointer = `- [${filename}](./${filename}): Session notes from ${yyyy}-${mm}-${dd} ${hh}:${min} UTC\n`;
    await appendFile(indexPath, pointer, 'utf8');

    const compactedMessages = [
      { role: 'user', content: `Context summary: ${parsed.summary.trim()}` },
      ...toKeep,
    ];

    const newTokens = estimateContextTokens(compactedMessages, null);
    const notesRelPath = `durable-memory/${filename}`;

    try {
      stderr?.write(`[compacted: ${currentTokens} -> ${newTokens} tokens, notes: ${notesRelPath}]\n`);
    } catch {}

    return {
      compacted: true,
      messages: compactedMessages,
      notesFile: notesRelPath,
      oldTokens: currentTokens,
      newTokens,
    };
  } catch (error) {
    warn?.(`Compaction failed: ${error.message}; keeping original context`);
    return {
      compacted: false,
      messages,
      error,
    };
  }
}
