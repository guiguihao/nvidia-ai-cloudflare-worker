# NVIDIA API Proxy - Cloudflare Workers
完全免费的 NVIDIA API 代理服务，基于 Cloudflare Workers 实现。

这是一个运行在 Cloudflare Workers 上的 NVIDIA API 代理服务，支持自动测速、模型分组、降级和故障转移。

## 功能特性

- ✅ 自动发现和测试 NVIDIA 可用模型
- ✅ 根据延迟和优先级智能分组模型 (auto/coder/novel/task)
- ✅ 支持流式和非流式响应
- ✅ 自动故障转移和降级机制
- ✅ CORS 支持
- ✅ 全局边缘网络加速

## 一 手动部署
  - 1. Cloudflare 创建 Worker ->start with helloworld
  - 2. 编辑  直接复制worker.js全部代码 替换helloworld内容
  - 3. settings -> Variables and Secrets -> add ->Type选择secret -> Variable name填NVIDIA_API_KEY->value填你的nvidia api key
  - 4. 绑定kv 先创建kv 点击你刚才创建的worker 选择bindings -> add >kv namespase -> Variable name设置NVIDIA_KV ->选择kv
  - 5. settings -> Trigger Events >Cron Triggers  //自己根据情况设置自动探测时间 5分钟 10分钟 随便都可以
  - 6. settings -> Custom domain //绑定自定义域名

##### 1.1 查看模型优选状态
   - 你的域名/v1/status

##### 1.2 使用cherry 测试
  - 1. 设置 > 添加 -> 供应商名称 随意填 -> 类型 openai
  - 2. api 秘钥 随便填 没做验证
  - 3. api 地址 就是你的域名
  - 4. 添加模型 模型id: auto  coder novel task, 如果你需要固定模型例子:openai/gpt-oss-120b 

##### 1.3 查看日志

  - Worker -> observanility



## 二 快速部署

### 1. 配置 API Key

使用 `wrangler secret` 设置 NVIDIA API Key（推荐）：

```bash
wrangler secret put NVIDIA_API_KEY
# 输入你的 NVIDIA API Key（以 nvapi- 开头）
```

> ⚠️ 注意：不建议在 `wrangler.toml` 中硬编码 API Key，以免泄露。

### 2. 本地开发（可选）

```bash
npm install
npm run dev
```

这将在 `localhost:8787` 启动开发服务器。

### 3. 部署到 Cloudflare

```bash
npm run deploy
```

### 4. 配置定时触发器（可选）

`wrangler.toml` 已配置每 5 分钟自动探测模型状态：

```toml
[triggers]
crons = ["*/5 * * * *"]
```

部署后会自动执行模型测速和分组，无需手动配置。

## 使用方式

### 流式请求

```bash
curl https://your-worker.your-subdomain.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-oss-120b",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

### 非流式请求

```bash
curl https://your-worker.your-subdomain.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v3.2",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### 自动选择最优模型

不指定 `model` 或指定不支持的模型时，会自动选择最优模型：

```bash
curl https://your-worker.your-subdomain.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

## 模型分组说明

系统会自动将模型分为以下几组：

- **auto**: 全局最优模型优先
- **coder**: 编程相关模型 (deepseek, coder, qwen, gpt-oss)
- **novel**: 小说创作相关模型 (minimax, novel, qwen, llama)
- **task**: 任务处理相关模型 (gpt-oss, deepseek, task, qwen, 405b, 70b)


## 高级配置

### 启用 KV 存储（可选）

如果需要持久化模型缓存，可以启用 KV：

1. 创建 KV 命名空间：

```bash
wrangler kv:namespace create "NVIDIA_KV"
```

2. 将输出的 ID 复制到 `wrangler.toml` 中的 `[[kv_namespaces]]` 部分

3. 重新部署

### 查看日志

```bash
wrangler tail
```

## 故障转移机制

当首选模型出现以下情况时，会自动切换到下一个可用模型：

- HTTP 429 (速率限制)
- HTTP 500+ (服务器错误)
- HTTP 400 且包含 "unsupported" / "Extra inputs" / "tool" (参数不兼容)
- 请求超时 (60秒)

## 注意事项

1. **API Key 安全**：建议使用 `wrangler secret` 存储 API Key，不要硬编码在代码中
2. **超时限制**：Cloudflare Workers 免费版本单次请求超时为 10 秒，付费版本为 30 秒
3. **内存限制**：Workers 内存限制为 128MB，模型列表存储在内存中


#
