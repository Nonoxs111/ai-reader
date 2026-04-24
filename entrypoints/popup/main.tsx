import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { streamChat } from '@/api/glm';
import { buildSummaryPrompt } from '@/api/prompts';
import './style.css';

type ChatRole = 'user' | 'assistant' | 'system';
type ChatMessage = { role: Exclude<ChatRole, 'system'>; content: string };

const STORAGE_KEY = 'ai_reader_popup_history_v1';
const SELECTION_HISTORY_KEY = 'ai_reader_selection_history_v1';

type SelectionHistoryItem = {
  id: string;
  text: string;
  action: 'explain' | 'translate' | 'interview';
  result: string;
  timestamp: number;
};

function clampHistoryTo10Rounds(messages: ChatMessage[]) {
  // 10 轮 = 10 次 user + 10 次 assistant
  const pairs: Array<{ u: ChatMessage; a?: ChatMessage }> = [];
  let pendingUser: ChatMessage | null = null;
  for (const m of messages) {
    if (m.role === 'user') {
      if (pendingUser) pairs.push({ u: pendingUser });
      pendingUser = m;
    } else if (m.role === 'assistant') {
      if (pendingUser) {
        pairs.push({ u: pendingUser, a: m });
        pendingUser = null;
      } else {
        pairs.push({ u: { role: 'user', content: '' }, a: m });
      }
    }
  }
  if (pendingUser) pairs.push({ u: pendingUser });
  const last = pairs.slice(-10);
  const out: ChatMessage[] = [];
  for (const p of last) {
    if (p.u.content) out.push(p.u);
    if (p.a) out.push(p.a);
  }
  return out;
}

async function getActiveTabId(): Promise<number | null> {
  return await new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve(tabs[0]?.id ?? null);
    });
  });
}

async function extractPageText(): Promise<{ text: string; title?: string; url?: string }> {
  const tabId = await getActiveTabId();
  if (!tabId) throw new Error('未找到当前标签页');
  try {
    const resp = await new Promise<any>((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, { type: 'AI_READER_GET_ARTICLE_TEXT' }, (response) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        resolve(response);
      });
    });
    if (!resp?.ok) throw new Error(resp?.error || '提取正文失败');
    return { text: resp.text ?? '', title: resp.title, url: resp.url };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 兜底：如果内容脚本接收端不存在，直接在当前页执行脚本提取文本
    if (!/Receiving end does not exist/i.test(msg)) throw err;

    const injected = await new Promise<Array<{ result?: { text: string; title: string; url: string } }>>(
      (resolve, reject) => {
        chrome.scripting.executeScript(
          {
            target: { tabId },
            func: () => {
              const text = (document.body?.innerText ?? '').trim().slice(0, 8000);
              const title = document.title ?? '';
              const url = location.href;
              return { text, title, url };
            },
          },
          (results) => {
            const e = chrome.runtime.lastError;
            if (e) return reject(new Error(e.message));
            resolve((results ?? []) as Array<{ result?: { text: string; title: string; url: string } }>);
          },
        );
      },
    );

    const value = injected?.[0]?.result as unknown as { text?: string; title?: string; url?: string } | undefined;
    if (!value?.text) throw new Error('提取正文失败：页面未返回可用文本');
    return { text: value.text, title: value.title, url: value.url };
  }
}

function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [view, setView] = useState<'chat' | 'history'>('chat');
  const [selectionHistory, setSelectionHistory] = useState<SelectionHistoryItem[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    chrome.storage.local.get([STORAGE_KEY], (res: Record<string, unknown>) => {
      const err = chrome.runtime.lastError;
      if (err) return;
      const stored = res[STORAGE_KEY];
      if (Array.isArray(stored)) {
        setMessages(
          stored.filter(
            (m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string',
          ),
        );
      }
    });
  }, []);

  const loadSelectionHistory = () => {
    chrome.storage.local.get([SELECTION_HISTORY_KEY], (res: Record<string, unknown>) => {
      const err = chrome.runtime.lastError;
      if (err) return;
      const stored = res[SELECTION_HISTORY_KEY];
      if (Array.isArray(stored)) {
        setSelectionHistory(stored as SelectionHistoryItem[]);
      } else {
        setSelectionHistory([]);
      }
    });
  };

  useEffect(() => {
    loadSelectionHistory();
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== 'local') return;
      if (changes[SELECTION_HISTORY_KEY]) loadSelectionHistory();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  useEffect(() => {
    const trimmed = clampHistoryTo10Rounds(messages);
    chrome.storage.local.set({ [STORAGE_KEY]: trimmed });
  }, [messages]);

  useEffect(() => {
    // 自动滚到底
    const el = listRef.current;
    if (!el) return;
    if (view === 'chat') el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  const startStream = async (nextMessages: { role: 'system' | 'user' | 'assistant'; content: string }[]) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);

    // 先插入一个空的 assistant 消息用于流式追加
    setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);

    await streamChat({
      messages: nextMessages,
      onChunk: (chunk) => {
        setMessages((prev) => {
          const copy = prev.slice();
          for (let i = copy.length - 1; i >= 0; i -= 1) {
            if (copy[i]?.role === 'assistant') {
              copy[i] = { ...copy[i], content: (copy[i]?.content ?? '') + chunk };
              break;
            }
          }
          return copy;
        });
      },
      onDone: () => {
        setStreaming(false);
      },
      onError: (err) => {
        setStreaming(false);
        const msg = err instanceof Error ? err.message : String(err);
        setMessages((prev) => {
          const copy = prev.slice();
          for (let i = copy.length - 1; i >= 0; i -= 1) {
            if (copy[i]?.role === 'assistant') {
              copy[i] = { ...copy[i], content: `请求失败：${msg}` };
              break;
            }
          }
          return copy;
        });
      },
      signal: controller.signal,
    });
  };

  const send = async () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput('');
    setMessages((prev) => clampHistoryTo10Rounds([...prev, { role: 'user', content: text }]));
    const next = [
      { role: 'system' as const, content: '你是AI阅读助手。回答要清晰、准确、简洁；如果不确定就直说不知道，不编造。' },
      ...messages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user' as const, content: text },
    ];
    await startStream(next);
  };

  const clear = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    setMessages([]);
    chrome.storage.local.remove([STORAGE_KEY]);
  };

  const clearSelectionHistory = () => {
    chrome.storage.local.remove([SELECTION_HISTORY_KEY]);
    setSelectionHistory([]);
  };

  const actionLabel = (a: SelectionHistoryItem['action']) =>
    a === 'explain' ? '解释' : a === 'translate' ? '翻译' : '面试';

  const formatTime = (ts: number) =>
    new Date(ts).toLocaleString('zh-CN', { hour12: false });

  const openHistoryItem = (item: SelectionHistoryItem) => {
    const title = `📋 划词历史（${actionLabel(item.action)}）`;
    setView('chat');
    setMessages((prev) =>
      clampHistoryTo10Rounds([
        ...prev,
        { role: 'user', content: `${title}\n\n选中：${item.text}` },
        { role: 'assistant', content: item.result },
      ]),
    );
  };

  const summarize = async () => {
    if (streaming) return;
    setMessages((prev) => clampHistoryTo10Rounds([...prev, { role: 'user', content: '📄 摘要本页' }]));
    try {
      const { text, title, url } = await extractPageText();
      const prompt = buildSummaryPrompt(text.slice(0, 8000));
      const sys = { role: 'system' as const, content: '你是AI阅读助手。' };
      const user = {
        role: 'user' as const,
        content: `请摘要以下网页正文。\n\n【标题】${title ?? ''}\n【URL】${url ?? ''}\n\n【正文】\n${text.slice(0, 8000)}`,
      };
      await startStream([sys, ...prompt, user]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setMessages((prev) => clampHistoryTo10Rounds([...prev, { role: 'assistant', content: `摘要失败：${msg}` }]));
    }
  };

  return (
    <div className="popup-root">
      <div className="popup-header">AI阅读助手 ✨</div>

      <div className="popup-actions">
        <button className="popup-action-btn" type="button" onClick={summarize} disabled={streaming}>
          📄摘要本页
        </button>
        <button className="popup-action-btn danger" type="button" onClick={clear} disabled={streaming && messages.length === 0}>
          🗑️清空对话
        </button>
      </div>

      <div className="popup-tabs">
        <button
          className={`popup-tab ${view === 'history' ? 'active' : ''}`}
          type="button"
          onClick={() => setView('history')}
        >
          📋 查询历史
        </button>
      </div>

      {view === 'chat' ? (
        <div className="popup-list" ref={listRef}>
          {messages.map((m, idx) => (
            <div key={idx} className={`popup-msg-row ${m.role}`}>
              <div className={`popup-bubble ${m.role}`}>{m.content || (m.role === 'assistant' && streaming && idx === messages.length - 1 ? '...' : '')}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="popup-history">
          <div className="popup-history-header">
            <div className="popup-history-left">
              <button className="popup-history-back" type="button" onClick={() => setView('chat')}>
                ← 返回
              </button>
              <div className="popup-history-title">📋 查询历史</div>
            </div>
            <button className="popup-history-clear" type="button" onClick={clearSelectionHistory}>
              清空历史
            </button>
          </div>
          <div className="popup-history-list">
            {selectionHistory.length === 0 ? (
              <div className="popup-history-empty">暂无划词历史</div>
            ) : (
              selectionHistory.map((item) => (
                <button
                  key={item.id}
                  className="popup-history-item"
                  type="button"
                  onClick={() => openHistoryItem(item)}
                >
                  <div className="popup-history-row1">
                    <span className="popup-history-action">{actionLabel(item.action)}</span>
                    <span className="popup-history-time">{formatTime(item.timestamp)}</span>
                  </div>
                  <div className="popup-history-text">{item.text}</div>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      <div className="popup-input">
        <textarea
          className="popup-textarea"
          value={input}
          placeholder="输入你的问题…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={3}
          disabled={view !== 'chat' || streaming}
        />
        <button className="popup-send" type="button" onClick={send} disabled={streaming || !input.trim()}>
          发送
        </button>
      </div>
    </div>
  );
}

createRoot(document.getElementById('app')!).render(<App />);

