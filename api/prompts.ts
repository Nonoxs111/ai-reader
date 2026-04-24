type GlmMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export function buildExplainPrompt(selectedText: string, fullPageText?: string): GlmMessage[] {
  const system: GlmMessage = {
    role: 'system',
    content:
      '你是技术解读专家。用通俗语言解释用户选中的文本，善用生活类比，控制在200字以内。如果提供了全文，结合上下文理解。',
  };

  const user: GlmMessage = {
    role: 'user',
    content:
      (fullPageText?.trim()
        ? `【全文上下文】\n${fullPageText}\n\n`
        : '') + `【用户选中文本】\n${selectedText}`,
  };

  return [system, user];
}

export function buildTranslatePrompt(selectedText: string): GlmMessage[] {
  return [
    {
      role: 'system',
      content:
        '你是专业翻译。将用户输入翻译为中文，保留所有代码、变量名、URL、专有名词不作改动。输出只包含译文。',
    },
    { role: 'user', content: selectedText },
  ];
}

export function buildAskPrompt(question: string, contextText: string): GlmMessage[] {
  return [
    {
      role: 'system',
      content:
        '你是阅读助手。基于提供的全文内容回答用户问题，如果全文不包含答案就说不知道，不编造。',
    },
    {
      role: 'user',
      content: `【全文】\n${contextText}\n\n【问题】\n${question}`,
    },
  ];
}

export function buildSummaryPrompt(fullPageText: string): GlmMessage[] {
  return [
    {
      role: 'system',
      content: '你是文章摘要专家。用三句话总结核心内容，然后列出3-5个关键要点。',
    },
    { role: 'user', content: fullPageText },
  ];
}

