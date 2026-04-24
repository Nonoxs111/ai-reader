import React, { useEffect, useMemo, useRef, useState } from 'react';
import LoadingDots from '@/components/LoadingDots';
import './style.css';

export type FollowupHandlers = {
  onChunk: (chunk: string) => void;
  onDone: () => void;
  onError: (error: unknown) => void;
};

export type ResultCardProps = {
  content: string;
  loading: boolean;
  mode?: 'default' | 'interview';
  onClose: () => void;
  onFollowup?: (question: string, handlers: FollowupHandlers) => void;
};

type InterviewQuestionItem = {
  question: string;
  points: string[];
};

type InterviewCardData = {
  conclusion: string;
  difficulty: string;
  isHighFrequency: boolean;
  questions: InterviewQuestionItem[];
};

function escapeHtml(input: string) {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderInlineMarkdownToHtml(line: string) {
  // 先转义，确保不会注入任意 HTML；后续只生成我们允许的标签
  let s = escapeHtml(line);
  // `code`
  s = s.replace(/`([^`]+?)`/g, (_m, code) => `<code>${code}</code>`);
  // **strong**
  s = s.replace(/\*\*([^*]+?)\*\*/g, (_m, strong) => `<strong>${strong}</strong>`);
  return s;
}

function markdownToSafeHtml(markdown: string) {
  const raw = markdown.replace(/\r\n/g, '\n').trim();
  if (!raw) return '';

  const lines = raw.split('\n');
  const out: string[] = [];
  let i = 0;

  const isUl = (l: string) => /^\s*[-*]\s+/.test(l);
  const isOl = (l: string) => /^\s*\d+\.\s+/.test(l);

  while (i < lines.length) {
    const line = lines[i] ?? '';

    if (!line.trim()) {
      i += 1;
      continue;
    }

    if (isUl(line)) {
      const items: string[] = [];
      while (i < lines.length && isUl(lines[i] ?? '')) {
        const itemText = (lines[i] ?? '').replace(/^\s*[-*]\s+/, '');
        items.push(`<li>${renderInlineMarkdownToHtml(itemText)}</li>`);
        i += 1;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    if (isOl(line)) {
      const items: string[] = [];
      while (i < lines.length && isOl(lines[i] ?? '')) {
        const itemText = (lines[i] ?? '').replace(/^\s*\d+\.\s+/, '');
        items.push(`<li>${renderInlineMarkdownToHtml(itemText)}</li>`);
        i += 1;
      }
      out.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    // paragraph：连续非空行合并为一个段落
    const para: string[] = [];
    while (i < lines.length && (lines[i] ?? '').trim() && !isUl(lines[i] ?? '') && !isOl(lines[i] ?? '')) {
      para.push(renderInlineMarkdownToHtml(lines[i] ?? ''));
      i += 1;
    }
    out.push(`<p>${para.join('<br/>')}</p>`);
  }

  return out.join('');
}

function parseInterviewCard(content: string): InterviewCardData | null {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  if (!normalized) return null;

  const lines = normalized.split('\n').map((l) => l.trim()).filter(Boolean);
  const conclusionLine = lines.find((l) => /结论|高频|非高频/.test(l)) ?? '';
  const difficultyLine = lines.find((l) => /难度|⭐|★/.test(l)) ?? '';
  const isHighFrequency = /高频/.test(conclusionLine) && !/非高频|不高频/.test(conclusionLine);
  if (!conclusionLine) return null;

  const questions: InterviewQuestionItem[] = [];
  let current: InterviewQuestionItem | null = null;
  for (const line of lines) {
    if (/^\d+[\.\、]\s*/.test(line) || /^Q[:：]/i.test(line) || /面试题/.test(line)) {
      if (current) questions.push(current);
      current = { question: line.replace(/^\d+[\.\、]\s*/, ''), points: [] };
      continue;
    }
    if (!current) continue;
    if (/^[-*]\s*/.test(line) || /^要点[:：]?/.test(line)) {
      current.points.push(line.replace(/^[-*]\s*/, '').replace(/^要点[:：]?\s*/, ''));
    }
  }
  if (current) questions.push(current);

  if (questions.length === 0) return null;
  return {
    conclusion: conclusionLine,
    difficulty: difficultyLine || '难度：★★★',
    isHighFrequency,
    questions,
  };
}

export default function ResultCard({ content, loading, mode = 'default', onClose, onFollowup }: ResultCardProps) {
  const [copied, setCopied] = useState(false);
  const [followupOpen, setFollowupOpen] = useState(false);
  const [followupText, setFollowupText] = useState('');
  const [followupLoading, setFollowupLoading] = useState(false);
  const [followupQa, setFollowupQa] = useState<Array<{ q: string; a: string }>>([]);
  const [streamingAnswer, setStreamingAnswer] = useState('');

  const html = useMemo(() => markdownToSafeHtml(content), [content]);
  const followupHtml = useMemo(() => markdownToSafeHtml(streamingAnswer), [streamingAnswer]);
  const interviewCard = useMemo(() => (mode === 'interview' ? parseInterviewCard(content) : null), [content, mode]);

  const canCopy = !loading && content.trim().length > 0;

  const onCopy = async () => {
    if (!canCopy) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore
    }
  };

  const toggleFollowup = () => {
    if (loading) return;
    setFollowupOpen((v) => !v);
  };

  const submitFollowup = () => {
    const q = followupText.trim();
    if (!q || loading || followupLoading) return;

    setFollowupLoading(true);
    setStreamingAnswer('');

    const done = () => {
      setFollowupLoading(false);
      setFollowupQa((prev) => [...prev, { q, a: streamingAnswerRef.current }]);
      setStreamingAnswer('');
      setFollowupText('');
    };

    const error = (err: unknown) => {
      setFollowupLoading(false);
      const msg = err instanceof Error ? err.message : String(err);
      setFollowupQa((prev) => [...prev, { q, a: `**请求失败**\n\n\`${msg}\`` }]);
      setStreamingAnswer('');
    };

    onFollowup?.(q, {
      onChunk: (chunk) => setStreamingAnswer((prev) => prev + chunk),
      onDone: done,
      onError: error,
    });
  };

  // 用 ref 捕获最新 streamingAnswer 给 done() 用
  const streamingAnswerRef = useRef('');
  useEffect(() => {
    streamingAnswerRef.current = streamingAnswer;
  }, [streamingAnswer]);

  return (
    <div className="ai-result-card" role="dialog" aria-label="AI result">
      <button className="ai-result-card-close" type="button" onClick={onClose} aria-label="Close">
        ✕
      </button>

      <div className="ai-result-card-body">
        <>
          {content.trim() ? (
            interviewCard ? (
              <div className="ai-interview-card">
                <div className="ai-interview-header">
                  <span
                    className={`ai-interview-badge ${interviewCard.isHighFrequency ? 'high' : 'low'}`}
                  >
                    {interviewCard.isHighFrequency ? '高频考点' : '非高频考点'}
                  </span>
                  <span className="ai-interview-difficulty">{interviewCard.difficulty}</span>
                </div>
                <div className="ai-interview-conclusion">{interviewCard.conclusion}</div>
                <div className="ai-interview-list">
                  {interviewCard.questions.map((q, idx) => (
                    <div key={`${idx}-${q.question}`} className="ai-interview-item">
                      <div className="ai-interview-question">{idx + 1}. {q.question}</div>
                      {q.points.length > 0 ? (
                        <ul className="ai-interview-points">
                          {q.points.map((p, pIdx) => (
                            <li key={`${idx}-${pIdx}`}>{p}</li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div dangerouslySetInnerHTML={{ __html: html }} />
            )
          ) : null}

          {/** loading 时不额外显示第二个 dots，避免重复 */}

          {followupQa.length > 0 ? (
            <div className="ai-result-card-followups">
              {followupQa.map((item, idx) => (
                <div key={`${idx}-${item.q}`} className="ai-result-card-followup-item">
                  <div className="ai-result-card-followup-q">追问：{item.q}</div>
                  <div
                    className="ai-result-card-followup-a"
                    dangerouslySetInnerHTML={{ __html: markdownToSafeHtml(item.a) }}
                  />
                </div>
              ))}
            </div>
          ) : null}

          {followupLoading ? (
            <div className="ai-result-card-followup-item">
              <div className="ai-result-card-followup-q">追问：{followupText.trim() || '…'}</div>
              <div className="ai-result-card-followup-a">
                {streamingAnswer ? <div dangerouslySetInnerHTML={{ __html: followupHtml }} /> : <LoadingDots />}
              </div>
            </div>
          ) : null}

          {!loading ? (
            <div className="ai-result-card-followup-toggle-row">
              <button className="ai-result-card-followup-toggle" type="button" onClick={toggleFollowup}>
                💬 继续追问
              </button>
            </div>
          ) : null}

          {!loading && followupOpen ? (
            <div className="ai-result-card-followup-panel">
              <input
                className="ai-result-card-followup-input"
                value={followupText}
                onChange={(e) => setFollowupText(e.target.value)}
                placeholder="基于以上内容继续提问..."
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    submitFollowup();
                  }
                }}
              />
              <button
                className="ai-result-card-followup-send"
                type="button"
                onClick={submitFollowup}
                disabled={!followupText.trim() || followupLoading}
              >
                {followupLoading ? '发送中...' : '发送'}
              </button>
            </div>
          ) : null}

          {loading && !content.trim() ? (
            <div className="ai-result-card-loading">
              <LoadingDots />
            </div>
          ) : null}
        </>
      </div>

      {!loading ? (
        <div className="ai-result-card-footer">
          <button
            className="ai-result-card-mini-btn"
            type="button"
            onClick={onCopy}
            disabled={!canCopy}
          >
            {copied ? '已复制' : '复制结果'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

