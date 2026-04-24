type GlmMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type StreamChatParams = {
  messages: GlmMessage[];
  onChunk: (chunk: string) => void;
  onDone: () => void;
  onError: (error: unknown) => void;
  signal?: AbortSignal;
};

const ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const MODEL = "glm-4-flash";

// 注意：把 Key 打进扩展包里并不安全（页面/用户都可能获取到）。
// 这里为了先把功能跑通，按你给的 Key 直接使用；后续建议改为后台服务/用户配置注入。
const API_KEY = "074dadb66dfc417dbb3708bc9d90d97f.l7yYB3TG6q4qiYBG";

function decodeSseLines(chunk: string) {
  // SSE 事件通常以 \n\n 分隔
  return chunk.split("\n\n");
}

export async function streamChat({
  messages,
  onChunk,
  onDone,
  onError,
  signal,
}: StreamChatParams) {
  try {
    // 在浏览器扩展/页面环境中运行，避免被某些打包器 tree-shaking
    const res = await fetch(ENDPOINT, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        messages,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `GLM API 请求失败: ${res.status} ${res.statusText}${text ? `\n${text}` : ""}`,
      );
    }

    if (!res.body) {
      throw new Error("GLM API 响应没有可读流 (ReadableStream)");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    const handleData = (data: string) => {
      if (!data) return;
      if (data === "[DONE]") {
        onDone();
        return "done" as const;
      }

      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        return;
      }

      const choice = json?.choices?.[0];
      const deltaContent = choice?.delta?.content;
      const finishReason = choice?.finish_reason;

      if (typeof deltaContent === "string" && deltaContent.length > 0) {
        onChunk(deltaContent);
      }

      if (finishReason === "stop") {
        onDone();
        return "done" as const;
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // 更稳妥：逐行解析 data:，支持跨 chunk 拼接
      while (true) {
        const nl = buffer.indexOf("\n");
        if (nl === -1) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);

        const trimmed = line.trim();
        if (!trimmed) continue;
        if (!trimmed.startsWith("data:")) continue;

        const data = trimmed.slice(5).trim();
        const status = handleData(data);
        if (status === "done") return;
      }
    }

    onDone();
  } catch (err) {
    // AbortController 主动取消时不当作错误
    if (err instanceof DOMException && err.name === "AbortError") return;
    onError(err);
  }
}
