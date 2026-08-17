export type TokenUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
};

export function estimateTokens(
  messages: Array<{ role?: string; content?: unknown }>,
  responseText = '',
  reasoningText = ''
): TokenUsage {
  let promptChars = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') {
      promptChars += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (typeof part === 'string') promptChars += part.length;
        else if (part && typeof part === 'object' && 'text' in part && typeof (part as { text: unknown }).text === 'string') {
          promptChars += ((part as { text: string }).text).length;
        } else if (part) {
          promptChars += JSON.stringify(part).length;
        }
      }
    } else if (m.content) {
      promptChars += JSON.stringify(m.content).length;
    }
  }

  // Token calculation heuristic: 1 token ~ 3.0 characters on average for mixed languages/code
  const promptTokens = Math.max(1, Math.ceil(promptChars / 3.0));
  const completionChars = responseText.length;
  const reasoningChars = reasoningText.length;
  const reasoningTokens = reasoningChars > 0 ? Math.ceil(reasoningChars / 3.0) : 0;
  const answerTokens = completionChars > 0 ? Math.ceil(completionChars / 3.0) : (reasoningTokens > 0 ? 0 : 1);
  const completionTokens = answerTokens + reasoningTokens;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: {
      cached_tokens: 0
    },
    completion_tokens_details: {
      reasoning_tokens: reasoningTokens
    }
  };
}
