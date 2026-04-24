export default defineContentScript({
  matches: ['*://*/*'],
  main() {
    const HISTORY_KEY = 'ai_reader_selection_history_v1';
    const HISTORY_MAX = 50;
    const HIGHLIGHT_KEY = 'ai_reader_highlights_v1';

    const ext = globalThis as unknown as {
      chrome?: {
        storage?: { local?: any };
        runtime?: { onMessage?: { addListener?: (fn: any) => void } };
      };
      browser?: {
        storage?: { local?: any };
        runtime?: { onMessage?: { addListener?: (fn: any) => void } };
      };
    };

    const storageLocal = (ext.chrome ?? ext.browser)?.storage?.local;

    const storageGet = (key: string) =>
      new Promise<Record<string, unknown>>((resolve) => {
        if (!storageLocal?.get) return resolve({});
        storageLocal.get([key], (res: Record<string, unknown>) => resolve(res ?? {}));
      });

    const storageSet = (obj: Record<string, unknown>) =>
      new Promise<void>((resolve) => {
        if (!storageLocal?.set) return resolve();
        storageLocal.set(obj, () => resolve());
      });

    const storageRemove = (keys: string[]) =>
      new Promise<void>((resolve) => {
        if (!storageLocal?.remove) return resolve();
        storageLocal.remove(keys, () => resolve());
      });

    const saveSelectionHistory = async (payload: {
      text: string;
      action: 'explain' | 'translate' | 'interview';
      result: string;
      timestamp: number;
    }) => {
      const prev = await storageGet(HISTORY_KEY);
      const list = Array.isArray(prev[HISTORY_KEY]) ? (prev[HISTORY_KEY] as any[]) : [];
      const next = [
        { id: `${payload.timestamp}-${Math.random().toString(36).slice(2)}`, ...payload },
        ...list,
      ].slice(0, HISTORY_MAX);
      await storageSet({ [HISTORY_KEY]: next });
    };

    type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink' | 'orange';
    type HighlightItem = {
      id: string;
      url: string;
      text: string;
      color: HighlightColor;
      timestamp: number;
      startXPath: string;
      startOffset: number;
      endXPath: string;
      endOffset: number;
    };

    const highlightStyleId = 'ai-reader-highlight-style';
    const ensureHighlightStyle = () => {
      if (document.getElementById(highlightStyleId)) return;
      const style = document.createElement('style');
      style.id = highlightStyleId;
      style.textContent = `
mark[data-ai-reader-highlight] {
  padding: 0 1px;
  border-radius: 4px;
  color: inherit;
  background-color: var(--ai-reader-hl-bg, rgba(255,230,100,0.4));
}
`;
      document.documentElement.appendChild(style);
    };

    const colorToVars = (color: HighlightColor) => {
      const map: Record<HighlightColor, string> = {
        yellow: 'rgba(255,230,100,0.4)',
        green: 'rgba(150,230,150,0.4)',
        blue: 'rgba(130,180,255,0.4)',
        pink: 'rgba(255,180,200,0.4)',
        orange: 'rgba(255,180,100,0.4)',
      };
      const bg = map[color];
      const wave = bg.replace(/0\.4\)$/, '0.85)');
      return { bg, wave };
    };

    const getXPath = (node: Node): string => {
      if (node === document) return '/';
      const parts: string[] = [];
      let cur: Node | null = node;
      while (cur && cur !== document) {
        const parent: ParentNode | null = cur.parentNode as ParentNode | null;
        if (!parent) break;
        const siblings = Array.from(parent.childNodes).filter(
          (n): n is ChildNode => (n as ChildNode).nodeName === cur!.nodeName,
        );
        const index = siblings.indexOf(cur as ChildNode) + 1;
        parts.unshift(`${cur.nodeName}[${index}]`);
        cur = parent;
      }
      return '/' + parts.join('/');
    };

    const nodeFromXPath = (xpath: string): Node | null => {
      try {
        const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        return result.singleNodeValue;
      } catch {
        return null;
      }
    };

    const unwrapMark = (mark: HTMLElement) => {
      const parent = mark.parentNode;
      if (!parent) return;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    };

    const getIntersectingHighlightMarks = (range: Range): HTMLElement[] => {
      const marks = Array.from(
        document.querySelectorAll<HTMLElement>('mark[data-ai-reader-highlight][data-id]'),
      );
      return marks.filter((m) => {
        try {
          const mr = document.createRange();
          mr.selectNodeContents(m);
          return (
            range.compareBoundaryPoints(Range.END_TO_START, mr) < 0 &&
            range.compareBoundaryPoints(Range.START_TO_END, mr) > 0
          );
        } catch {
          return false;
        }
      });
    };

    const wrapRangeWithMark = (range: Range, id: string, color: HighlightColor) => {
      const mark = document.createElement('mark');
      mark.setAttribute('data-ai-reader-highlight', '1');
      mark.setAttribute('data-id', id);
      mark.setAttribute('data-color', color);
      const { bg, wave } = colorToVars(color);
      mark.style.setProperty('--ai-reader-hl-bg', bg);
      mark.style.setProperty('--ai-reader-hl-wave', wave);
      try {
        range.surroundContents(mark);
        return mark;
      } catch {
        const frag = range.extractContents();
        mark.appendChild(frag);
        range.insertNode(mark);
        return mark;
      }
    };

    const loadHighlights = async (): Promise<HighlightItem[]> => {
      const prev = await storageGet(HIGHLIGHT_KEY);
      return Array.isArray(prev[HIGHLIGHT_KEY]) ? (prev[HIGHLIGHT_KEY] as HighlightItem[]) : [];
    };

    const saveHighlights = async (list: HighlightItem[]) => {
      await storageSet({ [HIGHLIGHT_KEY]: list.slice(0, 50) });
    };

    const upsertHighlight = async (item: HighlightItem) => {
      const list = await loadHighlights();
      const filtered = list.filter((x) => x.id !== item.id);
      await saveHighlights([item, ...filtered].slice(0, 50));
    };

    const removeHighlightById = async (id: string) => {
      const list = await loadHighlights();
      await saveHighlights(list.filter((x) => x.id !== id));
    };

    const restoreHighlightsForUrl = async () => {
      ensureHighlightStyle();
      const url = location.href;
      const list = (await loadHighlights()).filter((x) => x.url === url);
      for (const h of list) {
        const existing = document.querySelector(`mark[data-ai-reader-highlight][data-id="${h.id}"]`);
        if (existing) continue;
        const startNode = nodeFromXPath(h.startXPath);
        const endNode = nodeFromXPath(h.endXPath);
        if (!startNode || !endNode) continue;
        if (startNode.nodeType !== Node.TEXT_NODE || endNode.nodeType !== Node.TEXT_NODE) continue;
        const range = document.createRange();
        try {
          range.setStart(startNode, Math.min(h.startOffset, (startNode.textContent ?? '').length));
          range.setEnd(endNode, Math.min(h.endOffset, (endNode.textContent ?? '').length));
          wrapRangeWithMark(range, h.id, h.color);
        } catch {
          // ignore
        }
      }
    };

    // Popup -> Content: 提取正文/高亮管理
    const setupMessageHandler = async () => {
      const ext = globalThis as unknown as {
        chrome?: { runtime?: { onMessage?: { addListener?: (fn: any) => void } } };
        browser?: { runtime?: { onMessage?: { addListener?: (fn: any) => void } } };
      };

      const addListener = (ext.chrome ?? ext.browser)?.runtime?.onMessage?.addListener;
      if (!addListener) return;

      addListener(
        (
          message: unknown,
          _sender: unknown,
          sendResponse: (response: unknown) => void,
        ) => {
        if (!message || typeof message !== 'object') return;

        if ((message as { type?: string }).type === 'AI_READER_GET_ARTICLE_TEXT') {
          (async () => {
            try {
              const { Readability } = await import('@mozilla/readability');
              // 某些站点上 document.cloneNode(true) 可能触发 "Illegal invocation"
              // 这里改用 DOMParser 解析 HTML，生成干净的离线 Document 给 Readability
              const html = document.documentElement?.outerHTML ?? '';
              const parsed = new DOMParser().parseFromString(html, 'text/html');
              const article = new Readability(parsed).parse();
              const text = (article?.textContent ?? '').trim().slice(0, 8000);
              sendResponse({
                ok: true,
                title: article?.title ?? document.title,
                text,
                url: location.href,
              });
            } catch (err) {
              // 降级：Readability 失败时，直接用 body.innerText（仍截取 8000）
              try {
                const text = (document.body?.innerText ?? '').trim().slice(0, 8000);
                sendResponse({
                  ok: true,
                  title: document.title,
                  text,
                  url: location.href,
                });
              } catch (err2) {
                const msg = err2 instanceof Error ? err2.message : String(err2);
                sendResponse({ ok: false, error: msg });
              }
            }
          })();
          return true;
        }

        if ((message as { type?: string }).type === 'AI_READER_GET_HIGHLIGHTS') {
          (async () => {
            const url = (message as any).url ?? location.href;
            const list = (await loadHighlights()).filter((x) => x.url === url);
            sendResponse({ ok: true, list });
          })();
          return true;
        }

        if ((message as { type?: string }).type === 'AI_READER_CLEAR_HIGHLIGHTS') {
          (async () => {
            const url = (message as any).url ?? location.href;
            const all = await loadHighlights();
            await saveHighlights(all.filter((x) => x.url !== url));
            document
              .querySelectorAll<HTMLElement>('mark[data-ai-reader-highlight][data-id]')
              .forEach(unwrapMark);
            sendResponse({ ok: true });
          })();
          return true;
        }
      },
      );
    };

    void setupMessageHandler();
    void restoreHighlightsForUrl();

    let container: HTMLDivElement | null = null;
    let root: import('react-dom/client').Root | null = null;

    const removeMenu = () => {
      document.removeEventListener('mousedown', onGlobalMouseDown, true);
      if (root) {
        root.unmount();
        root = null;
      }
      if (container) {
        container.remove();
        container = null;
      }
    };

    const onGlobalMouseDown = (e: MouseEvent) => {
      if (!container) return;
      const target = e.target as Node | null;
      if (target && container.contains(target)) return;
      removeMenu();
    };

    const showMenu = async (
      selectedText: string,
      x: number,
      y: number,
      highlightTarget?: { id: string; color: HighlightColor } | null,
    ) => {
      removeMenu();

      container = document.createElement('div');
      container.id = 'tsr-text-selection-menu-root';
      container.style.position = 'fixed';
      container.style.left = '0';
      container.style.top = '0';
      container.style.width = '0';
      container.style.height = '0';
      container.style.zIndex = '2147483647';
      document.documentElement.appendChild(container);

      const [{ createRoot }, TextSelectionMenu] = await Promise.all([
        import('react-dom/client'),
        import('@/components/TextSelectionMenu'),
      ]);

      root = createRoot(container);
      const React = (await import('react')).default;
      root.render(
        React.createElement(TextSelectionMenu.default, {
          selectedText,
          position: { x, y },
          fullPageText: '',
          highlightTarget: highlightTarget ?? null,
          onAction: async (action, text, handlers, payload) => {
            if (action === 'highlight') {
              ensureHighlightStyle();
              const p = (payload ?? {}) as any;
              const op = p.op as 'create' | 'update' | 'remove' | undefined;
              const color = p.color as HighlightColor | undefined;
              const id = (p.id as string | undefined) ?? highlightTarget?.id ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

              if (op === 'remove') {
                let removedAny = false;
                if (id) {
                  const mark = document.querySelector<HTMLElement>(
                    `mark[data-ai-reader-highlight][data-id="${id}"]`,
                  );
                  if (mark) {
                    unwrapMark(mark);
                    removedAny = true;
                  }
                  await removeHighlightById(id);
                }

                // 兜底：如果没按 id 删到，则按当前选区删除重叠高亮
                const sel = window.getSelection?.();
                if ((!removedAny || !id) && sel && !sel.isCollapsed) {
                  const range = sel.getRangeAt(0);
                  const marks = getIntersectingHighlightMarks(range);
                  if (marks.length > 0) {
                    const ids = marks
                      .map((m) => m.getAttribute('data-id'))
                      .filter((x): x is string => !!x);
                    marks.forEach(unwrapMark);
                    if (ids.length > 0) {
                      const list = await loadHighlights();
                      await saveHighlights(list.filter((x) => !ids.includes(x.id)));
                    }
                  }
                }
                return;
              }

              if (!color) return;

              if (op === 'update' && id) {
                const mark = document.querySelector<HTMLElement>(`mark[data-ai-reader-highlight][data-id="${id}"]`);
                if (mark) {
                  mark.setAttribute('data-color', color);
                  const { bg, wave } = colorToVars(color);
                  mark.style.setProperty('--ai-reader-hl-bg', bg);
                  mark.style.setProperty('--ai-reader-hl-wave', wave);
                }
                // 更新存储（尽量保留原位置信息）
                const list = await loadHighlights();
                const existing = list.find((x) => x.id === id);
                if (existing) {
                  await upsertHighlight({ ...existing, color, timestamp: Date.now() });
                }
                return;
              }

              // create
              const sel = window.getSelection?.();
              if (!sel || sel.isCollapsed) return;
              const range = sel.getRangeAt(0);
              if (!range) return;
              if (range.toString().trim() !== selectedText.trim()) {
                // 如果选区变化，仍按当前 range 为准
              }

              // 关键约束：同一字符只能存在一种高亮
              // 新高亮前先清理与当前选区相交的旧高亮
              const overlaps = getIntersectingHighlightMarks(range);
              if (overlaps.length > 0) {
                const overlapIds = overlaps
                  .map((m) => m.getAttribute('data-id'))
                  .filter((x): x is string => !!x);
                overlaps.forEach(unwrapMark);
                if (overlapIds.length > 0) {
                  const list = await loadHighlights();
                  await saveHighlights(list.filter((x) => !overlapIds.includes(x.id)));
                }
              }

              const startNode = range.startContainer;
              const endNode = range.endContainer;
              if (startNode.nodeType !== Node.TEXT_NODE || endNode.nodeType !== Node.TEXT_NODE) return;
              const startXPath = getXPath(startNode);
              const endXPath = getXPath(endNode);
              const item: HighlightItem = {
                id,
                url: location.href,
                text: range.toString(),
                color,
                timestamp: Date.now(),
                startXPath,
                startOffset: range.startOffset,
                endXPath,
                endOffset: range.endOffset,
              };
              wrapRangeWithMark(range, id, color);
              await upsertHighlight(item);
              return;
            }

            if (!handlers) return;
            if (action !== 'explain' && action !== 'translate' && action !== 'interview') return;

            const ts = Date.now();
            let acc = '';

            const [{ streamChat }, prompts] = await Promise.all([
              import('@/api/glm'),
              Promise.all([
                import('@/api/prompts'),
                import('@/api/prompts/interview'),
              ]),
            ]);

            const [basePrompts, interviewPrompts] = prompts;
            const messages =
              action === 'explain'
                ? basePrompts.buildExplainPrompt(text, '')
                : action === 'translate'
                  ? basePrompts.buildTranslatePrompt(text)
                  : interviewPrompts.buildInterviewPrompt(text);

            await streamChat({
              messages,
              onChunk: (chunk) => {
                acc += chunk;
                handlers.onChunk(chunk);
              },
              onDone: async () => {
                handlers.onDone();
                await saveSelectionHistory({
                  text,
                  action,
                  result: acc,
                  timestamp: ts,
                });
              },
              onError: async (err) => {
                handlers.onError(err);
                const msg = err instanceof Error ? err.message : String(err);
                await saveSelectionHistory({
                  text,
                  action,
                  result: `请求失败：${msg}`,
                  timestamp: ts,
                });
              },
            });
          },
          onClose: removeMenu,
        }),
      );

      document.addEventListener('mousedown', onGlobalMouseDown, true);
    };

    const getSelectionInfo = () => {
      const selection = window.getSelection?.();
      if (!selection || selection.isCollapsed) return null;

      const text = selection.toString().trim();
      if (!text) return null;

      try {
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        if (!rect || rect.width === 0 || rect.height === 0) return null;

        const x = rect.left + rect.width / 2;
        const y = rect.top;
        return { text, x, y };
      } catch {
        return null;
      }
    };

    const onMouseUp = (e: MouseEvent) => {
      // 点击菜单自身时会触发 mouseup，且可能导致选区坍塌；
      // 这里直接忽略菜单内部的 mouseup，避免菜单被误关闭/重建
      if (container) {
        const target = e.target as Node | null;
        if (target && container.contains(target)) return;
      }

      const info = getSelectionInfo();
      if (!info) {
        removeMenu();
        return;
      }
      // 菜单显示在选中文本“上方居中”
      void showMenu(info.text, info.x, info.y, null);
    };

    window.addEventListener('mouseup', onMouseUp, { passive: true });

    // 点击已高亮文字：弹出菜单用于改色/取消
    const onHighlightClick = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.('mark[data-ai-reader-highlight][data-id]') as
        | HTMLElement
        | null;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top;
      const id = el.getAttribute('data-id') ?? '';
      const color = (el.getAttribute('data-color') as HighlightColor | null) ?? 'yellow';
      void showMenu(el.textContent?.trim() ?? '', x, y, { id, color });
    };

    document.addEventListener('click', onHighlightClick, true);

    // content script 生命周期结束时清理（WXT 热重载/页面卸载）
    const cleanup = () => {
      window.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('click', onHighlightClick, true);
      document.removeEventListener('mousedown', onGlobalMouseDown, true);
      removeMenu();
    };

    window.addEventListener('pagehide', cleanup, { once: true });
  },
});
