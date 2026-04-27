/**
 * NVIDIA API Proxy - Cloudflare Workers (Ultimate Edition)
 * 极致优化：零拷贝流转发、内存 TTL 防老化、串行探测防限流、智能回退
 */

// ==================== 配置 ====================
const NVIDIA_API_URL = "https://integrate.api.nvidia.com/v1";

const TARGET_KEYWORDS = [
  "deepseek-v4", "gpt-oss-120b", "minimaxai", "gemma-4-", "qwen", "glm-5",
  "deepseek-v3", "kimi-k2.", "llama-3.1-405b", "mistral-large-3"
];

const PRIORITY_LIST = [
  "deepseek-ai/deepseek-v4-pro",
  "deepseek-ai/deepseek-v4-flash",
  "qwen/qwen3-coder-480b-a35b-instruct",
  "deepseek-ai/deepseek-v3.2",
  "google/gemma-4-31b-it",
  "qwen/qwen3.5-397b-a17b",
  "openai/gpt-oss-120b",
  "meta/llama-3.1-405b-instruct",
  "mistralai/mistral-large-3-675b-instruct-2512",
  "deepseek-ai/deepseek-v3.1",
  "minimaxai/minimax-m2.7",
  "minimaxai/minimax-m2.5",
  "nvidia/nemotron-4-340b-instruct",
  "qwen/qwen3.5-122b-a10b",
  "meta/llama-3.3-70b-instruct",
  "mistralai/mistral-large-2-instruct"
];

// ==================== 状态管理 ====================
class NvidiaManager {
  constructor() {
    this.apiKey = null;
    this.bestModels = { auto: null, coder: null, novel: null, task: null };
    this.optimalGroups = { auto: [], coder: [], novel: [], task: [] };
    this.availableModels = [];
    this.modelLatencies = {};
    this.lastCheck = 0;
    this.lastKVFetch = 0; // 新增：记录上次读取 KV 的时间
  }

  async loadApiKey(env) {
    if (this.apiKey) return;
    if (env.NVIDIA_API_KEY) {
      this.apiKey = env.NVIDIA_API_KEY;
      return;
    }
    if (env.NVIDIA_KV) {
      try {
        const key = await env.NVIDIA_KV.get("api_key");
        if (key && key.startsWith("nvapi-")) {
          this.apiKey = key;
          return;
        }
      } catch (e) { }
    }
    throw new Error("[NVIDIA] 未配置 API Key！");
  }

  // 优化 2：内存 TTL 机制，防止活跃节点数据老化
  async loadStateFromKV(env) {
    const now = Date.now();
    // 内存数据有效且距离上次查 KV 不到 60 秒，直接使用内存
    if (this.availableModels.length > 0 && (now - this.lastKVFetch) < 60000) return;

    if (env.NVIDIA_KV) {
      try {
        const stateStr = await env.NVIDIA_KV.get("nvidia_proxy_state");
        if (stateStr) {
          const state = JSON.parse(stateStr);
          this.availableModels = state.availableModels || [];
          this.bestModels = state.bestModels || this.bestModels;
          this.optimalGroups = state.optimalGroups || this.optimalGroups;
          this.lastCheck = state.lastCheck || 0;
          this.lastKVFetch = now; // 更新拉取时间
        }
      } catch (e) { }
    }
  }

  async saveStateToKV(env) {
    if (env.NVIDIA_KV) {
      try {
        const state = {
          availableModels: this.availableModels,
          bestModels: this.bestModels,
          optimalGroups: this.optimalGroups,
          lastCheck: this.lastCheck
        };
        await env.NVIDIA_KV.put("nvidia_proxy_state", JSON.stringify(state));
      } catch (e) { }
    }
  }

  isTargetModel(modelId) {
    const midLower = modelId.toLowerCase();
    return TARGET_KEYWORDS.some(sub => midLower.includes(sub));
  }

  async testModelLatency(model, headers) {
    const startTime = Date.now();
    let res;
    try {
      res = await fetch(`${NVIDIA_API_URL}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: model, messages: [{ role: "user", content: "ok" }], max_tokens: 3 }),
        signal: AbortSignal.timeout(10000)
      });

      if (res.ok) {
        const elapsed = (Date.now() - startTime) / 1000;
        console.log(`✅ [TEST] ${model}: ${elapsed.toFixed(2)}s`);
        await res.arrayBuffer(); // 清理内存
        this.modelLatencies[model] = elapsed;
        return { model, latency: elapsed };
      } else {
        console.log(`❌ [TEST] ${model}: HTTP ${res.status}`);
        await res.arrayBuffer();
        return { model, latency: -1 };
      }
    } catch (e) {
      console.log(`❌ [TEST] ${model}: 超时/异常`);
      if (res && res.body) try { await res.body.cancel(); } catch (e) { }
      return { model, latency: -1 };
    }
  }

  modelSortScore(modelId) {
    const ml = modelId.toLowerCase();
    for (let i = 0; i < PRIORITY_LIST.length; i++) {
      if (ml === PRIORITY_LIST[i].toLowerCase() || ml.includes(PRIORITY_LIST[i].toLowerCase())) return i;
    }
    return 1000;
  }

  calculateCompositeScore(model) {
    const priorityScore = this.modelSortScore(model);
    const latency = this.modelLatencies[model];
    const normalizedPriority = Math.min(priorityScore, 16) / 16;
    const normalizedLatency = !latency ? 1 : latency <= 1.5 ? 0 : Math.min((latency - 1.5) / 10, 1);
    return { priorityScore, latency: latency ? parseFloat(latency.toFixed(2)) : null, compositeScore: parseFloat((normalizedPriority * 0.6 + normalizedLatency * 0.4).toFixed(4)) };
  }

  async fetchAndTestModels(env) {
    console.log("\n[NVIDIA] 开始执行探测...");
    await this.loadApiKey(env);
    const headers = { "Authorization": `Bearer ${this.apiKey}`, "Content-Type": "application/json" };

    try {
      const res = await fetch(`${NVIDIA_API_URL}/models`, { method: "GET", headers, signal: AbortSignal.timeout(10000) });
      if (!res.ok) return;

      const fetchedModels = (await res.json()).data.map(m => m.id);
      const targetModels = fetchedModels.filter(m => this.isTargetModel(m));

      // 优化 3：取消并发，完全串行探测，防止 429 限流
      const validResults = [];
      for (const m of targetModels) {
        const result = await Promise.race([
          this.testModelLatency(m, headers),
          new Promise(resolve => setTimeout(() => resolve({ model: m, latency: -1 }), 12000))
        ]);
        if (result && result.latency > 0) {
          validResults.push(result);
        }
      }

      if (validResults.length === 0) {
        console.log("⚠️ 所有模型探测失败");
        return;
      }

      const sortedModelIds = validResults.sort((a, b) => a.latency - b.latency).map(r => r.model);
      this.availableModels = sortedModelIds;

      const prioritizedModels = sortedModelIds.sort((a, b) => this.calculateCompositeScore(a).compositeScore - this.calculateCompositeScore(b).compositeScore);
      const newGroups = { auto: [...prioritizedModels], coder: [], novel: [], task: [] };

      for (const mid of prioritizedModels) {
        const ml = mid.toLowerCase();
        if (ml.includes("coder") || (ml.includes("deepseek") && !ml.includes("distill")) || ml.includes("gpt-oss")) newGroups.coder.push(mid);
        if (ml.includes("minimax") || ml.includes("mixtral") || ml.includes("mistral-large-3") || ml.includes("405b")) newGroups.novel.push(mid);
        if (ml.includes("llama") || ml.includes("nemotron") || ml.includes("mistral") || ml.includes("397b")) newGroups.task.push(mid);
      }

      ["coder", "novel", "task"].forEach(g => {
        if (newGroups[g].length === 0) newGroups[g] = [...prioritizedModels];
        else prioritizedModels.forEach(mid => { if (!newGroups[g].includes(mid)) newGroups[g].push(mid); });
      });

      this.optimalGroups = newGroups;
      ["auto", "coder", "novel", "task"].forEach(g => { if (newGroups[g].length > 0) this.bestModels[g] = newGroups[g][0]; });

      this.lastCheck = Date.now();
      await this.saveStateToKV(env);
    } catch (e) {
      console.log(`[ERROR] 探测异常: ${e.message}`);
    }
  }

  getTargetModel(reqModel) {
    let profile = "auto", targetModel = null, fallbackModels = [];
    const GROUP_KEYS = ["auto", "coder", "novel", "task"];

    if (reqModel && GROUP_KEYS.includes(reqModel.toLowerCase())) {
      profile = reqModel.toLowerCase();
      fallbackModels = this.optimalGroups[profile]?.length ? this.optimalGroups[profile] : (this.optimalGroups.auto || ["meta/llama-3.1-405b-instruct"]);
    } else if (reqModel) {
      profile = "EXPLICIT";
      fallbackModels = this.availableModels.includes(reqModel) ? [reqModel, ...this.availableModels.filter(m => m !== reqModel)] : [reqModel, ...this.availableModels];
    } else {
      fallbackModels = this.optimalGroups.auto || ["meta/llama-3.1-405b-instruct"];
    }
    return { targetModel: fallbackModels[0], fallbackModels, profile };
  }
}

const manager = new NvidiaManager();

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" } });
    }

    const url = new URL(request.url);
    try {
      await manager.loadApiKey(env);
      await manager.loadStateFromKV(env);
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/v1/update" && request.method === "GET") {
      manager.lastCheck = 0;
      await manager.fetchAndTestModels(env);
      return new Response(JSON.stringify({ success: true, models: manager.availableModels }), { headers: { "Content-Type": "application/json" } });
    }

    // 恢复 /v1/status 接口
    if (url.pathname === "/v1/status" && request.method === "GET") {
      const modelDetails = manager.availableModels.map(model => {
        const scoreInfo = manager.calculateCompositeScore(model);
        return { model, ...scoreInfo };
      });
      modelDetails.sort((a, b) => a.compositeScore - b.compositeScore);

      return new Response(JSON.stringify({
        note: "探测由 Cron 定时任务执行，状态通过 KV 跨节点同步。若需手动触发全量测速并查看日志，请访问 /v1/update",
        availableModels: manager.availableModels,
        modelDetails,
        bestModels: manager.bestModels,
        optimalGroups: manager.optimalGroups,
        lastCheck: manager.lastCheck,
        lastKVFetch: manager.lastKVFetch
      }, null, 2), {
        headers: { "Content-Type": "application/json" }
      });
    }

    if (url.pathname !== "/v1/chat/completions" || request.method !== "POST") return new Response("Not Found", { status: 404 });

    let payload;
    try { payload = await request.json(); } catch (e) { return new Response("Invalid JSON", { status: 400 }); }

    const { targetModel, fallbackModels, profile } = manager.getTargetModel(payload.model);
    console.log(`\n[PROXY] 请求匹配 [${profile.toUpperCase()}], 首选: ${targetModel} (Stream=${!!payload.stream})`);

    // 清理载荷
    if (payload.messages) {
      payload.messages = payload.messages.map(m => ({
        ...m, content: Array.isArray(m.content) ? m.content.filter(i => i.type === "text").map(i => i.text).join("") : m.content
      }));
    }
    if ("max_completion_tokens" in payload) {
      payload.max_tokens = payload.max_tokens || payload.max_completion_tokens;
      delete payload.max_completion_tokens;
    }

    const headers = { "Authorization": `Bearer ${manager.apiKey}`, "Content-Type": "application/json" };
    return handleProxyRequest(payload, fallbackModels, headers, profile);
  },

  async scheduled(event, env, ctx) {
    await manager.fetchAndTestModels(env);
  }
};

// ==================== 响应处理 (零拷贝转发) ====================
async function handleProxyRequest(payload, fallbackModels, headers, profile) {
  for (const currentModel of fallbackModels) {
    try {
      const res = await fetch(`${NVIDIA_API_URL}/chat/completions`, {
        method: "POST", headers, body: JSON.stringify({ ...payload, model: currentModel }), signal: AbortSignal.timeout(60000)
      });

      // 如果遭遇限流或服务器熔断，快速重试下一个备用模型
      if (res.status === 429 || res.status >= 500) {
        console.log(`⚠️ [WARN] ${currentModel} 返回 ${res.status}，降级重试...`);
        continue;
      }

      // 只要不是 429/500，哪怕是 400 传参错误，我们也直接透传给客户端，不再暴力干预
      console.log(`🚀 [OK] 接通 ${currentModel}，开始零拷贝透传管道...`);

      // 优化 1：零拷贝转发 (Zero-Copy Pipe)
      // 我们直接提取 NVIDIA 的 res.body 并返回，Workers 底层会用流的方式原样发送给客户端
      // 无需再做 TextDecoder 拆包和 TextEncoder 封包，极大节省资源。
      const proxyHeaders = new Headers(res.headers);
      proxyHeaders.set("Access-Control-Allow-Origin", "*"); // 注入 CORS

      return new Response(res.body, {
        status: res.status,
        headers: proxyHeaders
      });

    } catch (e) {
      console.log(`⏳ [TIMEOUT] ${currentModel} 连接异常，降级重试...`);
      continue;
    }
  }

  // 所有节点全部阵亡的最终兜底返回
  return new Response(JSON.stringify({
    error: { message: `[${profile}] 抱歉，该分组下所有优选模型节点均由于网络或服务异常断开，请稍后再试。` }
  }), { status: 504, headers: { "Content-Type": "application/json" } });
}