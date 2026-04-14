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



## 一、手动部署

### 1.1 部署步骤

1. **创建 Worker**
   - 登录 Cloudflare Dashboard → Workers & Pages → 创建 Worker → 选择 "Start with Hello World"

2. **部署代码**
   - 打开 Worker 编辑器，将 `worker.js` 的全部代码复制并替换 Hello World 默认内容

3. **配置 API Key**
   - 进入 **Settings** → **Variables and Secrets** → **Add**
   - Type 选择 **Secret**
   - Variable name 填写 `NVIDIA_API_KEY`
   - Value 填写你的 NVIDIA API Key（以 `nvapi-` 开头）

4. **绑定 KV 存储**
   - 先创建 KV 命名空间：**Workers & Pages** → **KV** → **Create**
   - 点击刚创建的 Worker → **Bindings** → **Add** → 选择 **KV Namespace**
   - Variable name 设置为 `NVIDIA_KV`，选择刚创建的 KV

5. **配置定时触发器**
   - 进入 **Settings** → **Triggers** → **Cron Triggers**
   - 根据需求设置自动探测时间（如 `*/5 * * * *` 每 5 分钟）

6. **绑定自定义域名**（必须,否则可能无法访问, 没有域名可以去申请免费域名https://my.dnshe.com/）
   - 进入 **Settings** → **Custom Domains** → 添加域名

### 1.2 查看模型优选状态

访问以下地址查看模型状态：
```
https://你的域名/v1/status
```

### 1.3 使用 Cherry Studio 测试

1. 打开 Cherry Studio → **设置** → **添加供应商**
2. 填写配置：
   - **供应商名称**：随意填写
   - **类型**：选择 `OpenAI`
   - **API 密钥**：任意填写（未做验证）
   - **API 地址**：你的 Worker 域名
3. 添加模型：
   - 智能选择(四选一)：`auto` / `coder` / `novel` / `task`
   - 固定模型示例：`openai/gpt-oss-120b`

### 1.4 查看日志

- 进入 **Worker** → **Observability** 查看运行日志

---

## 二、快速部署

### 2.1 配置 API Key

使用 `wrangler secret` 设置 NVIDIA API Key（推荐）：

```bash
wrangler secret put NVIDIA_API_KEY
# 输入你的 NVIDIA API Key（以 nvapi- 开头）
```

> ⚠️ **注意**：不建议在 `wrangler.toml` 中硬编码 API Key，以免泄露。

### 2.2 本地开发（可选）

```bash
npm install
npm run dev
```

这将在 `localhost:8787` 启动开发服务器。

### 2.3 部署到 Cloudflare

```bash
npm run deploy
```

### 2.4 配置定时触发器（可选）

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


## 有python版本,有需要自行部署,自行安装一下依赖
``` 
  修改 nvidia_server.py  第19行 self.api_key = "nvapi-xxxxxx"
  启动方式 pkill -f nvidia_server.py; sleep 3; pkill -9 -f nvidia_server.py; && nohup python3 nvidia_server.py > nvidia_server.log 2>&1 &
  ```

