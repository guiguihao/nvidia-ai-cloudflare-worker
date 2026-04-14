/**
 * NVIDIA API Proxy - Cloudflare Workers 版本
 * 自动测速、分组、降级和故障转移
 */

// ==================== 配置 ====================
const NVIDIA_API_URL = "https://integrate.api.nvidia.com/v1";
const CHECK_INTERVAL = 600 * 1000; // 10分钟

// 目标模型关键词（精确匹配 NVIDIA API 实际提供的模型）
// 基于 NVIDIA API 真实可用模型列表筛选（高质量、大参数量）
const TARGET_KEYWORDS = [
  // GPT-OSS 系列（OpenAI 开源模型）
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  // DeepSeek 系列（编程/推理强）
  "deepseek-ai/deepseek-v3.2",
  "deepseek-ai/deepseek-v3.1",
  "deepseek-ai/deepseek-r1-distill-qwen-32b",
  "deepseek-ai/deepseek-r1-distill-qwen-14b",
  // Qwen 系列（中文优化）
  "qwen/qwen3.5-397b-a17b",
  "qwen/qwen3.5-122b-a10b",
  "qwen/qwen3-coder-480b-a35b-instruct",
  "qwen/qwen2.5-coder-32b-instruct",
  // MiniMax 系列（长文本/创作）
  "minimaxai/minimax-m2.5",
  "minimaxai/minimax-m2.7",
  // Llama 系列（通用对话）
  "meta/llama-3.1-405b-instruct",
  "meta/llama-3.3-70b-instruct",
  "meta/llama-3.1-70b-instruct",
  // Mistral 系列
  "mistralai/mistral-large-3-675b-instruct-2512",
  "mistralai/mistral-large-2-instruct",
  "mistralai/mistral-medium-3-instruct",
  "mistralai/mixtral-8x22b-instruct-v0.1",
  // Nemotron 系列（NVIDIA 自家）
  "nvidia/nemotron-4-340b-instruct",
  "nvidia/llama-3.1-nemotron-ultra-253b-v1",
  "nvidia/llama-3.3-nemotron-super-49b-v1.5",
];

// 优先级列表（按综合性能、延迟、成本排序）
// 评分越低优先级越高，用于 modelSortScore 函数
const PRIORITY_LIST = [
  // Tier 1: 最强通用模型（最高优先级）
  "qwen/qwen3-coder-480b-a35b-instruct",   // 0 - 代码能力最强
  "deepseek-ai/deepseek-v3.2",              // 1 - 推理/编程强
  "qwen/qwen3.5-397b-a17b",                // 2 - 中文优化，参数量大
  "openai/gpt-oss-120b",                   // 3 - OpenAI 开源大模型
  "meta/llama-3.1-405b-instruct",          // 4 - 参数量最大，通用性强
  // Tier 2: 高质量备选
  "mistralai/mistral-large-3-675b-instruct-2512", // 5 - 最新大模型
  "deepseek-ai/deepseek-v3.1",              // 6
  "minimaxai/minimax-m2.7",                // 7 - 长文本擅长
  "minimaxai/minimax-m2.5",                // 8
  "nvidia/nemotron-4-340b-instruct",       // 9 - NVIDIA 自家优化
  "qwen/qwen3.5-122b-a10b",               // 10
  // Tier 3: 中等模型（延迟更低）
  "meta/llama-3.3-70b-instruct",           // 11
  "meta/llama-3.1-70b-instruct",           // 12
  "mistralai/mistral-large-2-instruct",    // 13
  "mistralai/mixtral-8x22b-instruct-v0.1", // 14
  "nvidia/llama-3.3-nemotron-super-49b-v1.5", // 15
  "deepseek-ai/deepseek-r1-distill-qwen-32b", // 16
];

// ==================== 状态管理 ====================
class NvidiaManager {
  constructor() {
    this.apiKey = null; // 从环境变量读取
    this.bestModels = { auto: null, coder: null, novel: null, task: null };
    this.optimalGroups = { auto: [], coder: [], novel: [], task: [] };
    this.availableModels = [];
    this.modelLatencies = {}; // 存储每个模型的延迟
    this.lastCheck = 0;
    this.checkPromise = null;
  }

  // 从环境变量或 KV 获取 API Key
  async loadApiKey(env) {
    if (env.NVIDIA_API_KEY) {
      this.apiKey = env.NVIDIA_API_KEY;
      console.log(`[NVIDIA] 从环境变量加载 API Key (*${this.apiKey.slice(-4)})`);
      return;
    }

    // 尝试从 KV 读取
    if (env.NVIDIA_KV) {
      try {
        const key = await env.NVIDIA_KV.get("api_key");
        if (key && key.startsWith("nvapi-")) {
          this.apiKey = key;
          console.log(`[NVIDIA] 从 KV 加载 API Key (*${this.apiKey.slice(-4)})`);
          return;
        }
      } catch (e) {
        console.log("[NVIDIA] KV 读取失败");
      }
    }

    throw new Error("[NVIDIA] 未配置 API Key！请通过 wrangler secret put NVIDIA_API_KEY 设置");
  }

  // 判断是否为目标模型
  isTargetModel(modelId) {
    const midLower = modelId.toLowerCase();
    return TARGET_KEYWORDS.some(sub => midLower.includes(sub));
  }

  // 测试模型延迟（缩短超时以适配 Workers 限制）
  async testModelLatency(model, headers) {
    const testPayload = {
      model: model,
      messages: [{ role: "user", content: "ok" }],
      max_tokens: 3
    };

    const startTime = Date.now();
    let res;
    try {
      res = await fetch(`${NVIDIA_API_URL}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(testPayload),
        signal: AbortSignal.timeout(4000) // 4秒超时（适配 Workers）
      });

      if (res.ok) {
        const elapsed = (Date.now() - startTime) / 1000;
        console.log(`✅ [NVIDIA-TEST] ${model}: ${elapsed.toFixed(2)}s`);
        // 读取并丢弃响应体，释放连接
        await res.arrayBuffer();
        // 保存延迟数据
        this.modelLatencies[model] = elapsed;
        return { model, latency: elapsed };
      } else {
        console.log(`❌ [NVIDIA-TEST] ${model}: HTTP ${res.status}`);
        // 读取并丢弃错误响应体，释放连接
        await res.arrayBuffer();
        return { model, latency: -1 };
      }
    } catch (e) {
      console.log(`❌ [NVIDIA-TEST] ${model}: ${e.message}`);
      // 如果有响应但未完成，尝试取消
      if (res && res.body) {
        try { await res.body.cancel(); } catch(e) {}
      }
      return { model, latency: -1 };
    }
  }

  // 模型排序分数（综合考虑优先级和延迟）
  modelSortScore(modelId) {
    const ml = modelId.toLowerCase();
    // 精确匹配 PRIORITY_LIST
    for (let i = 0; i < PRIORITY_LIST.length; i++) {
      if (ml === PRIORITY_LIST[i].toLowerCase() || ml.includes(PRIORITY_LIST[i].toLowerCase())) {
        return i;
      }
    }
    // 模糊匹配（兜底）
    if (ml.includes("qwen") && ml.includes("coder")) return 10;
    if (ml.includes("deepseek")) return 11;
    if (ml.includes("qwen")) return 12;
    if (ml.includes("gpt-oss")) return 13;
    if (ml.includes("minimax")) return 14;
    if (ml.includes("mistral")) return 15;
    if (ml.includes("nemotron")) return 16;
    if (ml.includes("llama")) return 20;
    return 1000; // 未知模型最低优先级
  }

  // 计算综合评分（延迟 <= 1.5s 视为同等快速，不产生差异）
  calculateCompositeScore(model) {
    const priorityScore = this.modelSortScore(model);
    const latency = this.modelLatencies[model];
    
    // 归一化优先级（0-16 → 0-1）
    const normalizedPriority = Math.min(priorityScore, 16) / 16;
    
    // 延迟阈值：1.5s内的模型视为"同样快"
    const LATENCY_THRESHOLD = 1.5;
    const normalizedLatency = !latency ? 1 :
      latency <= LATENCY_THRESHOLD ? 0 : // 1.5s内延迟权重为0
      Math.min((latency - LATENCY_THRESHOLD) / 10, 1); // 超过部分归一化

    // 综合得分：优先级 60% + 延迟惩罚 40%
    const compositeScore = normalizedPriority * 0.6 + normalizedLatency * 0.4;
    
    return {
      priorityScore,
      latency: latency ? parseFloat(latency.toFixed(2)) : null,
      compositeScore: parseFloat(compositeScore.toFixed(4)),
    };
  }

  // 获取并测试模型
  async fetchAndTestModels(env) {
    // 如果距离上次检查不到5分钟，且已有缓存，直接返回
    const now = Date.now();
    if (this.availableModels.length > 0 && (now - this.lastCheck) < 300000) {
      return;
    }

    // 防止并发重复检查
    if (this.checkPromise) {
      return this.checkPromise;
    }

    this.checkPromise = this._doFetchAndTest(env);
    try {
      await this.checkPromise;
    } finally {
      this.checkPromise = null;
    }
  }

  async _doFetchAndTest(env) {
    console.log("\n[NVIDIA] 开始进行内部探测，检查并测试指定模型响应速度...");
    await this.loadApiKey(env);

    const headers = {
      "Authorization": `Bearer ${this.apiKey}`,
      "Content-Type": "application/json"
    };

    try {
      // 获取模型列表
      const res = await fetch(`${NVIDIA_API_URL}/models`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(10000)
      });

      if (!res.ok) {
        console.log(`[ERROR] 获取模型列表失败，状态码 HTTP ${res.status}`);
        return;
      }

      const modelsData = await res.json();
      const fetchedModels = (modelsData.data || []).map(m => m.id);
      const targetModels = fetchedModels.filter(m => this.isTargetModel(m));
      console.log(`[NVIDIA] 过滤后的目标模型 (${targetModels.length}个): ${JSON.stringify(targetModels)}`);

      // 全并发测试（使用短超时避免阻塞）
      // 每个模型最多等待 5 秒，整体最多 15 秒
      const testPromises = targetModels.map(m => 
        Promise.race([
          this.testModelLatency(m, headers),
          new Promise(resolve => setTimeout(() => resolve({ model: m, latency: -1 }), 5000))
        ])
      );
      
      const results = await Promise.allSettled(testPromises);
      const validResults = results
        .filter(r => r.status === 'fulfilled')
        .map(r => r.value);

      const validModels = validResults.filter(r => r.latency > 0);
      validModels.sort((a, b) => a.latency - b.latency);

      if (validModels.length === 0) {
        console.log("[NVIDIA] ⚠️ 所有目标模型探测失败，保留原分组。");
        return;
      }

      const sortedModelIds = validModels.map(r => r.model);
      this.availableModels = sortedModelIds;
      console.log(`[NVIDIA] 所有可用模型: ${JSON.stringify(sortedModelIds)}`);

      // 综合评分排序（延迟 <= 1.5s 视为同等快速，仅按优先级排序）
      const prioritizedModels = sortedModelIds.sort((a, b) => {
        const scoreA = this.calculateCompositeScore(a);
        const scoreB = this.calculateCompositeScore(b);
        return scoreA.compositeScore - scoreB.compositeScore;
      });

      console.log(`[NVIDIA] 综合评分排序: ${prioritizedModels.map(m => {
        const s = this.calculateCompositeScore(m);
        return `${m}(${s.latency}s,pri=${s.priorityScore},score=${s.compositeScore})`;
      }).join(', ')}`);

      // 智能分组（根据模型特性精准分类）
      const newGroups = { auto: [...prioritizedModels], coder: [], novel: [], task: [] };

      for (const mid of prioritizedModels) {
        const midLower = mid.toLowerCase();
        
        // 编程组（推理/代码能力强）
        if (midLower.includes("coder") ||                      // 专用编程模型
            (midLower.includes("deepseek") && !midLower.includes("distill")) ||  // DeepSeek 主模型
            midLower.includes("qwen") ||                       // Qwen 代码能力好
            midLower.includes("gpt-oss")) {                    // GPT-OSS 代码强
          newGroups.coder.push(mid);
        }
        
        // 小说组（长文本/创作能力强）
        if (midLower.includes("minimax") ||                    // MiniMax 擅长长文本
            midLower.includes("mixtral") ||                    // Mixtral MoE 适合创作
            midLower.includes("mistral-large-3") ||            // 最新大模型质量好
            (midLower.includes("llama") && midLower.includes("405b"))) {  // 超大模型
          newGroups.novel.push(mid);
        }
        
        // 任务组（通用/多任务处理）
        if (midLower.includes("llama") ||                      // Llama 通用性好
            midLower.includes("nemotron") ||                   // Nemotron 任务优化
            midLower.includes("mistral") ||                    // Mistral 多任务
            midLower.includes("405b") ||                       // 大模型
            midLower.includes("397b") ||                       // Qwen 大模型
            midLower.includes("675b")) {                       // Mistral 超大模型
          newGroups.task.push(mid);
        }
      }

      // 兜底策略：如果某组为空，使用 auto 组的所有模型
      for (const g of ["coder", "novel", "task"]) {
        if (newGroups[g].length === 0) {
          newGroups[g] = [...prioritizedModels];
        } else {
          // 将其他模型作为备选补充
          for (const mid of prioritizedModels) {
            if (!newGroups[g].includes(mid)) {
              newGroups[g].push(mid);
            }
          }
        }
      }

      this.optimalGroups = newGroups;
      for (const g of ["auto", "coder", "novel", "task"]) {
        if (newGroups[g].length > 0) {
          this.bestModels[g] = newGroups[g][0];
          console.log(`✨ [NVIDIA-${g.toUpperCase()}] 智能分组首选: ${newGroups[g][0]}`);
        }
      }

      this.lastCheck = Date.now();
    } catch (e) {
      console.log(`[ERROR] 探测网络异常: ${e.message}`);
    }
  }

  // 获取目标模型
  getTargetModel(reqModel) {
    let targetModel = null;
    let fallbackModels = [];
    let profile = "auto";

    if (reqModel && this.availableModels.includes(reqModel)) {
      // 用户显式指定了特定模型
      targetModel = reqModel;
      fallbackModels = [reqModel, ...this.availableModels.filter(m => m !== reqModel)];
      profile = "EXPLICIT";
    } else {
      // 从全局测速最优序列中选择
      profile = "auto";
      const groupList = this.optimalGroups.auto || [];
      if (groupList.length === 0) {
        // 极限制兜底
        fallbackModels = ["meta/llama-3.1-405b-instruct", "meta/llama-3.3-70b-instruct"];
      } else {
        fallbackModels = groupList;
      }
      targetModel = fallbackModels[0];
    }

    return { targetModel, fallbackModels, profile };
  }

  // 简化消息格式
  simplifyMessages(messages) {
    return messages.map(m => {
      if (m.content && Array.isArray(m.content)) {
        const textContent = m.content
          .filter(item => item.type === "text")
          .map(item => item.text || "")
          .join("");
        return { ...m, content: textContent };
      }
      return m;
    });
  }

  // 过滤不兼容参数
  filterPayload(payload) {
    const filtered = { ...payload };
    if ("max_completion_tokens" in filtered) {
      const mcTokens = filtered.max_completion_tokens;
      delete filtered.max_completion_tokens;
      if (!("max_tokens" in filtered)) {
        filtered.max_tokens = mcTokens;
      }
    }
    return filtered;
  }
}

// 全局管理器实例
const manager = new NvidiaManager();

// ==================== Workers 主逻辑 ====================
export default {
  // HTTP 请求处理
  async fetch(request, env, ctx) {
    // 处理 CORS
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        }
      });
    }

    const url = new URL(request.url);
    
    // 调试端点：GET /v1/status 查看当前状态
    if (url.pathname === "/v1/status" && request.method === "GET") {
      // 如果没有缓存，触发一次探测并等待
      if (manager.availableModels.length === 0) {
        await manager.fetchAndTestModels(env);
      }
      
      // 构建带延迟和评分的模型详情
      const modelDetails = manager.availableModels.map(model => {
        const scoreInfo = manager.calculateCompositeScore(model);
        return {
          model,
          ...scoreInfo,
        };
      });
      
      // 按综合评分排序
      modelDetails.sort((a, b) => a.compositeScore - b.compositeScore);
      
      return new Response(JSON.stringify({
        availableModels: manager.availableModels,
        modelDetails,
        bestModels: manager.bestModels,
        optimalGroups: manager.optimalGroups,
        lastCheck: manager.lastCheck,
        targetKeywords: TARGET_KEYWORDS,
        priorityList: PRIORITY_LIST,
      }, null, 2), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // 只在 POST /v1/chat/completions 时处理
    if (url.pathname !== "/v1/chat/completions" || request.method !== "POST") {
      return new Response("Not Found", { status: 404 });
    }

    // 后台触发模型检查（不阻塞请求）
    // fetchAndTestModels 内部会检查是否超过 10 分钟，自动决定是否刷新
    ctx.waitUntil(manager.fetchAndTestModels(env));

    // 解析请求
    let payload;
    try {
      payload = await request.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: "Invalid JSON payload" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const reqModel = payload.model || "";
    const stream = payload.stream || false;

    // 获取目标模型
    const { targetModel, fallbackModels, profile } = manager.getTargetModel(reqModel);
    console.log(`\n[PROXY-REQ] 收到请求(${reqModel}) -> 匹配模式 [${profile.toUpperCase()}], 引流至首选: ${targetModel} (Stream=${stream})`);

    // 准备请求头
    const headers = {
      "Authorization": `Bearer ${manager.apiKey}`,
      "Content-Type": "application/json"
    };

    // 简化消息并过滤参数
    if (payload.messages) {
      payload.messages = manager.simplifyMessages(payload.messages);
    }
    payload = manager.filterPayload(payload);

    // 处理流式响应
    if (stream) {
      return handleStreamResponse(payload, fallbackModels, headers, profile, env, ctx);
    }

    // 处理非流式响应
    return handleNonStreamResponse(payload, fallbackModels, headers, profile, env, ctx);
  },

  // Cron 定时任务处理（由 Cloudflare 自动触发）
  async scheduled(event, env, ctx) {
    console.log(`[NVIDIA-CRON] 定时触发探测 (${event.cron})`);
    // 强制刷新，忽略缓存
    manager.lastCheck = 0;
    await manager.fetchAndTestModels(env);
    console.log("[NVIDIA-CRON] 探测完成");
  }
};

// ==================== 流式响应处理 ====================
async function handleStreamResponse(payload, fallbackModels, headers, profile, env, ctx) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // 后台执行流式请求
  ctx.waitUntil((async () => {
    try {
      for (const currentModel of fallbackModels) {
        const modelPayload = { ...payload, model: currentModel };
        try {
          const res = await fetch(`${NVIDIA_API_URL}/chat/completions`, {
            method: "POST",
            headers,
            body: JSON.stringify(modelPayload),
            signal: AbortSignal.timeout(60000)
          });

          if (res.status === 429 || res.status >= 500) {
            console.log(`⚠️ [${profile.toUpperCase()}-WARN] ${currentModel} 异常(${res.status})，切往下一节点...`);
            continue;
          }

          if (!res.ok) {
            const errText = await res.text();
            if (res.status === 400 && (errText.includes("unsupported") || errText.includes("Extra inputs") || errText.includes("tool"))) {
              console.log(`⚠️ [${profile.toUpperCase()}-WARN] ${currentModel} 组件交互不兼容(400)，尝试降级节点...`);
              continue;
            }
            console.log(`❌ [${profile.toUpperCase()}-ERR] 致命错误 (${res.status}): ${errText}`);
            await writer.write(encoder.encode(`data: ${JSON.stringify({ error: errText })}\n\n`));
            await writer.write(encoder.encode("data: [DONE]\n\n"));
            break;
          }

          console.log(`🚀 [${profile.toUpperCase()}-OK] 成功接通底层模型 ${currentModel}，开始流式泵送...`);
          
          // 流式读取并转发
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() || "";

              for (const line of lines) {
                if (line.trim()) {
                  await writer.write(encoder.encode(`${line}\n\n`));
                  
                  // 解析并打印内容
                  if (line.startsWith("data:") && !line.includes("[DONE]")) {
                    try {
                      const jsonStr = line.replace("data:", "").trim();
                      const dataJson = JSON.parse(jsonStr);
                      if (dataJson.choices && dataJson.choices.length > 0) {
                        const content = dataJson.choices[0].delta?.content || "";
                        if (content) {
                          process.stdout.write(content); // Workers 可能不支持，仅用于日志
                        }
                      }
                    } catch (e) {
                      // 忽略解析错误
                    }
                  }
                }
              }
            }
          } catch (e) {
            console.log(`⏳ [${profile.toUpperCase()}-TIMEOUT] 流式读取中断: ${e.message}`);
          }

          console.log("\n"); // 结束泵送换行
          return;
        } catch (e) {
          console.log(`⏳ [${profile.toUpperCase()}-TIMEOUT] 连通超时或断开 (${e.message})，该节点挂掉，无缝切往下一模型...`);
          continue;
        }
      }

      // 所有模型都失败
      await writer.write(encoder.encode(`data: ${JSON.stringify({ error: `[${profile.toUpperCase()}] 所有优选备用节点均失效，请稍后重试。` })}\n\n`));
      await writer.write(encoder.encode("data: [DONE]\n\n"));
    } catch (e) {
      console.log(`[ERROR] 流式处理异常: ${e.message}`);
    } finally {
      try {
        await writer.close();
      } catch (e) {
        // 忽略关闭错误
      }
    }
  })());

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

// ==================== 非流式响应处理 ====================
async function handleNonStreamResponse(payload, fallbackModels, headers, profile, env, ctx) {
  for (const currentModel of fallbackModels) {
    const modelPayload = { ...payload, model: currentModel };
    try {
      const res = await fetch(`${NVIDIA_API_URL}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(modelPayload),
        signal: AbortSignal.timeout(60000)
      });

      if (res.status === 429 || res.status >= 500) {
        console.log(`⚠️ [${profile.toUpperCase()}-WARN] ${currentModel} 非流异常 (${res.status})，尝试降级...`);
        continue;
      }

      if (!res.ok) {
        const errText = await res.text();
        if (res.status === 400 && (errText.includes("unsupported") || errText.includes("Extra inputs") || errText.includes("tool"))) {
          console.log(`⚠️ [${profile.toUpperCase()}-WARN] ${currentModel} 非流参数不兼容(400)，尝试降级节点...`);
          continue;
        }

        let errorBody;
        try {
          errorBody = JSON.parse(errText);
        } catch (e) {
          errorBody = { detail: errText };
        }
        return new Response(JSON.stringify(errorBody), {
          status: res.status,
          headers: { "Content-Type": "application/json" }
        });
      }

      const data = await res.json();
      return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json" }
      });
    } catch (e) {
      console.log(`⏳ [${profile.toUpperCase()}-TIMEOUT] 非流计算超时 (${e.message})，切换切往下一模型...`);
      continue;
    }
  }

  return new Response(JSON.stringify({ detail: `[${profile.toUpperCase()}] 分组所有节点均遭遇阻断或超时。` }), {
    status: 504,
    headers: { "Content-Type": "application/json" }
  });
}
