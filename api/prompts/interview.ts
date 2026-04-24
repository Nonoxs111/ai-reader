type GlmMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export function buildInterviewPrompt(selectedText: string): GlmMessage[] {
  return [
    {
      role: 'system',
      content:
        '你是资深前端面试官，精通大厂面试题库。请判断用户选中的知识点是否属于前端高频考点。' +
        '如果是高频：列出3-5道常见面试题，并给出回答要点。' +
        '如果是低频：诚实说明不算高频，但可提示相关联的高频考点。' +
        '输出格式必须为：先给结论（高频/非高频 + 难度星级），再给面试题+要点。' +
        '语言口语化，像一位资深面试官在分享经验。',
    },
    {
      role: 'user',
      content: `请分析下面这个知识点是否属于前端面试高频考点，并给出对应面试题：\n\n${selectedText}`,
    },
  ];
}

