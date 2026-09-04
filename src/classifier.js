import { MiniplayerError } from './errors.js';

export const CLASSIFICATION_LABELS = new Set([
  'escalation',
  'task-done',
  'all-done',
  'rate-limited',
  'error',
]);

export function buildClassificationPrompt(responseText) {
  return `Classify the team response below for an auto-nudge controller.

Return exactly one compact JSON object with this shape and no other text:
{"label":"escalation|task-done|all-done|rate-limited|error","reason":"short explanation","confidence":0.0}

Label rules:
- escalation: work is blocked specifically on an operator decision, approval, missing authority, or required clarification.
- task-done: the current assigned task is finished, but additional tasks may remain or the team should receive its next task.
- all-done: the response explicitly indicates there is no pending work and the whole team can be parked. Do not use this merely because one task finished.
- rate-limited: progress stopped because an API, provider, quota, or token rate limit requires backing off and retrying later.
- error: another exception or failure occurred that is not a decision block and not rate limiting.

Use only evidence in the response. Keep reason under 160 characters and confidence between 0 and 1.

<team-response>
${responseText}
</team-response>`;
}

function firstJsonObject(text) {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (start === -1) {
      if (character === '{') {
        start = index;
        depth = 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }

  return null;
}

export function parseClassificationOutput(output) {
  const unfenced = output
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  const json = firstJsonObject(unfenced);
  let value;
  try {
    value = json === null ? null : JSON.parse(json);
  } catch {
    value = null;
  }

  const valid = value
    && typeof value === 'object'
    && !Array.isArray(value)
    && CLASSIFICATION_LABELS.has(value.label)
    && typeof value.reason === 'string'
    && value.reason.trim().length > 0
    && value.reason.length <= 500
    && typeof value.confidence === 'number'
    && Number.isFinite(value.confidence)
    && value.confidence >= 0
    && value.confidence <= 1;

  if (!valid) {
    throw new MiniplayerError('Model returned an invalid classification object', 2);
  }

  return {
    label: value.label,
    reason: value.reason.trim(),
    confidence: value.confidence,
  };
}
