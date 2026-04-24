import React, { useEffect, useRef, useState } from 'react';
import ResultCard from '../ResultCard';
import { streamChat } from '@/api/glm';
import { buildAskPrompt } from '@/api/prompts';
import './style.css';

export type TextSelectionMenuAction =
  | 'explain'
  | 'translate'
  | 'interview'
  | 'highlight'
  | 'followup';
type ActionHandlers = {
  onChunk: (chunk: string) => void;
  onDone: () => void;
  onError: (error: unknown) => void;
};

export type TextSelectionMenuPosition = {
  x: number;
  y: number;
};

export type TextSelectionMenuProps = {
  selectedText: string;
  position: TextSelectionMenuPosition;
  fullPageText?: string;
  onAction: (
    action: TextSelectionMenuAction,
    selectedText: string,
    handlers?: ActionHandlers,
    payload?: unknown,
  ) => void;
  onClose: () => void;
  highlightTarget?: { id: string; color: HighlightColor } | null;
};

type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink' | 'orange';
const HIGHLIGHT_COLORS: Array<{ id: HighlightColor; label: string }> = [
  { id: 'yellow', label: '黄' },
  { id: 'green', label: '绿' },
  { id: 'blue', label: '蓝' },
  { id: 'pink', label: '粉' },
  { id: 'orange', label: '橙' },
];

export default function TextSelectionMenu({
  selectedText,
  position,
  fullPageText,
  onAction,
  onClose,
  highlightTarget,
}: TextSelectionMenuProps) {
  const [clamped, setClamped] = useState<TextSelectionMenuPosition>(position);
  const [activeAction, setActiveAction] = useState<'explain' | 'translate' | 'interview' | null>(null);
  const [resultContent, setResultContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [showHighlightPicker, setShowHighlightPicker] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const clamp = () => {
      const margin = 12;
      const x = Number.isFinite(position.x) ? position.x : 0;
      const y = Number.isFinite(position.y) ? position.y : 0;
      setClamped({
        x: Math.min(Math.max(x, margin), window.innerWidth - margin),
        y: Math.min(Math.max(y, margin), window.innerHeight - margin),
      });
    };

    clamp();
    window.addEventListener('resize', clamp, { passive: true });
    return () => window.removeEventListener('resize', clamp);
  }, [position.x, position.y]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const resetCardState = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setActiveAction(null);
    setResultContent('');
    setLoading(false);
  };

  const closeAll = () => {
    resetCardState();
    onClose();
  };

  const runAction = (action: 'explain' | 'translate' | 'interview', text: string) => {
    setActiveAction(action);
    setLoading(true);
    setResultContent('');

    onAction(action, text, {
      onChunk: (chunk) => setResultContent((prev) => prev + chunk),
      onDone: () => setLoading(false),
      onError: (err) => {
        setLoading(false);
        const msg = err instanceof Error ? err.message : String(err);
        setResultContent(`**请求失败**\n\n\`${msg}\``);
      },
    });
  };

  const handleExplain = () => runAction('explain', selectedText);
  const handleTranslate = () => runAction('translate', selectedText);
  const handleInterview = () => runAction('interview', selectedText);

  const handleHighlight = () => {
    setShowHighlightPicker((v) => !v);
  };

  const applyHighlight = (color: HighlightColor) => {
    onAction('highlight', selectedText, undefined, {
      op: highlightTarget ? 'update' : 'create',
      id: highlightTarget?.id,
      color,
    });
    setShowHighlightPicker(false);
  };

  const cancelHighlight = () => {
    onAction('highlight', selectedText, undefined, {
      op: 'remove',
      id: highlightTarget?.id,
    });
    setShowHighlightPicker(false);
  };

  const handleFollowup = (question: string, handlers: { onChunk: (c: string) => void; onDone: () => void; onError: (e: unknown) => void }) => {
    const context = `${fullPageText ?? ''}\n\n【已生成的结果】\n${resultContent}`.trim();
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const messages = buildAskPrompt(question.trim(), context);
    void streamChat({
      messages,
      onChunk: handlers.onChunk,
      onDone: handlers.onDone,
      onError: handlers.onError,
      signal: controller.signal,
    });
  };

  return (
    <div
      className="tsr-text-selection-menu-anchor"
      style={{ left: `${clamped.x}px`, top: `${clamped.y}px` }}
      role="presentation"
    >
      <div className="tsr-text-selection-menu" role="menu" aria-label="Text selection menu">
        <button
          className="tsr-tsm-btn"
          type="button"
          onClick={handleExplain}
          role="menuitem"
        >
          📖解释
        </button>
        <button
          className="tsr-tsm-btn"
          type="button"
          onClick={handleTranslate}
          role="menuitem"
        >
          🌐翻译
        </button>
        <button
          className="tsr-tsm-btn tsr-tsm-interview"
          type="button"
          onClick={handleInterview}
          role="menuitem"
        >
          🎯面试
        </button>
        <button className="tsr-tsm-btn" type="button" onClick={handleHighlight} role="menuitem">
          🖍️高亮
        </button>

        {showHighlightPicker ? (
          <div className="tsr-tsm-highlight">
            <div className="tsr-tsm-highlight-row">
              {HIGHLIGHT_COLORS.map((c) => (
                <button
                  key={c.id}
                  className={`tsr-tsm-color-dot ${c.id}${highlightTarget?.color === c.id ? ' active' : ''}`}
                  type="button"
                  aria-label={`高亮颜色：${c.label}`}
                  onClick={() => applyHighlight(c.id)}
                />
              ))}
            </div>
            <button className="tsr-tsm-cancel-highlight" type="button" onClick={cancelHighlight}>
              取消高亮
            </button>
          </div>
        ) : null}

        {activeAction !== null ? (
          <div className="tsr-tsm-result">
            <ResultCard
              content={resultContent}
              loading={loading}
              mode={activeAction === 'interview' ? 'interview' : 'default'}
              onFollowup={handleFollowup}
              onClose={resetCardState}
            />
          </div>
        ) : null}

        <span className="tsr-tsm-close-wrap" aria-hidden="true">
          <button className="tsr-tsm-btn tsr-tsm-close" type="button" onClick={closeAll}>
            ✕
          </button>
        </span>
      </div>
    </div>
  );
}

