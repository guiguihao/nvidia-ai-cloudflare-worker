import os
import sys
import json
import time
import asyncio
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Optional, Union, Any
from fastapi.responses import JSONResponse, StreamingResponse
from contextlib import asynccontextmanager
from playwright.async_api import async_playwright
import httpx
from fastapi import Request

### 启动方式 pkill -f nvidia_server.py; sleep 3; pkill -9 -f nvidia_server.py; cd ~/myserver/ && nohup python3 nvidia_server.py > nvidia_server.log 2>&1 &

class NvidiaManager:
    def __init__(self):
        self.api_key = "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"
        self.best_models = {"auto": None, "coder": None, "novel": None, "task": None}
        self.optimal_groups = {"auto": [], "coder": [], "novel": [], "task": []}
        self.available_models = []

    def load_api_key(self):
        try:
            json_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "openclaw.json")
            if os.path.exists(json_path):
                with open(json_path, 'r', encoding='utf-8') as f:
                    config = json.load(f)
                    nv_key = config.get("models", {}).get("providers", {}).get("openai", {}).get("apiKey")
                    if nv_key and nv_key.startswith("nvapi-"):
                        self.api_key = nv_key
                        print(f"[NVIDIA] 成功从 openclaw.json 提取 API Key (*{self.api_key[-4:]})")
        except Exception as e:
            print(f"[NVIDIA] 读取 openclaw.json 配置失败，将使用默认 Key: {e}")

    def is_target_model(self, model_id: str) -> bool:
        target_substrs = [
            "gpt-oss-120b", "deepseek-v3.2", "deepseek-v3.1", 
            "qwen3.5-397b", "minimax-m2.5", 
            "llama-3.1-405b", "llama-3.3-70b",
            "deepseek", "qwen", "minimax", "gpt-oss"
        ]
        mid_lower = model_id.lower()
        for sub in target_substrs:
            if sub in mid_lower:
                return True
        return False

    async def test_model_latency(self, client: httpx.AsyncClient, model: str, headers: dict) -> tuple:
        test_payload = {
            "model": model, 
            "messages": [{"role": "user", "content": "reply ok"}], 
            "max_tokens": 5
        }
        start_time = time.time()
        try:
            res = await client.post("https://integrate.api.nvidia.com/v1/chat/completions", headers=headers, json=test_payload, timeout=12)
            if res.status_code == 200:
                elapsed = time.time() - start_time
                print(f"✅ [NVIDIA-TEST] {model} 测试成功, 延迟: {elapsed:.2f}s")
                return model, elapsed
            else:
                print(f"❌ [NVIDIA-TEST] {model} 请求失败, HTTP {res.status_code}")
                return model, -1
        except Exception as e:
            print(f"❌ [NVIDIA-TEST] {model} 请求异常: {e}")
            return model, -1

    async def fetch_and_test_models(self):
        print("\n[NVIDIA] 开始进行内部探测，检查并测试指定模型响应速度 (每隔10分钟更新)...")
        self.load_api_key()
        
        print("[NVIDIA] 正在使用 Playwright 无头模式探测网页...")
        try:
            async with async_playwright() as p:
                browser = await p.chromium.launch(headless=True)
                page = await browser.new_page()
                await page.route("**/*.{png,jpg,jpeg,webp,gif,css,woff2}", lambda route: route.abort())
                await page.goto("https://build.nvidia.com/explore/discover", wait_until="domcontentloaded", timeout=15000)
                print(f"[NVIDIA] Playwright 探测成功，页面Title: {await page.title()}")
                await browser.close()
        except Exception as e:
            print(f"[NVIDIA] Playwright 探测超时或失败，退回 API 直连模式")
        
        headers = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}
        try:
            async with httpx.AsyncClient() as client:
                res = await client.get("https://integrate.api.nvidia.com/v1/models", headers=headers, timeout=10)
                if res.status_code == 200:
                    models_data = res.json().get("data", [])
                    fetched_models = [m["id"] for m in models_data]
                    
                    target_models = [m for m in fetched_models if self.is_target_model(m)]
                    print(f"[NVIDIA] 过滤后的目标模型: {target_models}")

                    tasks = [self.test_model_latency(client, m, headers) for m in target_models]
                    results = await asyncio.gather(*tasks)
                    
                    valid_models = [(m, l) for m, l in results if l > 0]
                    valid_models.sort(key=lambda x: x[1])
                    
                    if not valid_models:
                        print("[NVIDIA] ⚠️ 所有目标模型探测失败，保留原分组。")
                        return

                    sorted_model_ids = [m[0] for m in valid_models]
                    self.available_models = sorted_model_ids
                    print(f"[NVIDIA] 所有可用模型: {sorted_model_ids}")

                    # 优先级排序列表 (由高到低)
                    priority_list = [
                        "gpt-oss-120b",
                        "deepseek-v3.2",
                        "deepseek-v3.1",
                        "qwen3.5-397b-a17b",
                        "minimax-m2.5",
                        "llama-3.1-405b-instruct",
                        "meta/llama-3.3-70b-instruct"
                    ]

                    def model_sort_score(m_id):
                        ml = m_id.lower()
                        # 查找在优先级列表中的匹配项
                        for i, p in enumerate(priority_list):
                            if p in ml:
                                return i
                        # 如果是通用关键词，给一个次优分数
                        if "deepseek" in ml: return 10
                        if "qwen" in ml: return 11
                        if "minimax" in ml: return 12
                        if "gpt-oss" in ml: return 13
                        if "llama" in ml: return 100
                        return 1000

                    # 根据优先级和延迟（作为同权重的次要排序标准）排序
                    prioritized_models = sorted(sorted_model_ids, key=lambda x: (model_sort_score(x), next(l for m, l in valid_models if m == x)))
                    
                    new_groups = {"auto": prioritized_models.copy(), "coder": [], "novel": [], "task": []}
                    for mid in prioritized_models:
                        mid_lower = mid.lower()
                        # 编程组
                        if any(k in mid_lower for k in ["deepseek", "coder", "qwen", "gpt-oss"]):
                            new_groups["coder"].append(mid)
                        # 小说组
                        if any(k in mid_lower for k in ["minimax", "novel", "qwen", "llama"]):
                            new_groups["novel"].append(mid)
                        # 任务组
                        if any(k in mid_lower for k in ["gpt-oss", "deepseek", "task", "qwen", "405b", "70b"]):
                            new_groups["task"].append(mid)
                            
                    # 兜底：如果某组为空，或者为了保证多样性将所有模型作为备选加入（排序靠后）
                    for g in ["coder", "novel", "task"]:
                        if not new_groups[g]:
                            new_groups[g] = prioritized_models.copy()
                        else:
                            # 补全其他模型作为备选
                            for mid in prioritized_models:
                                if mid not in new_groups[g]:
                                    new_groups[g].append(mid)
                                
                    self.optimal_groups = new_groups
                    for g in new_groups:
                        if new_groups[g]:
                            self.best_models[g] = new_groups[g][0]
                            print(f"✨ [NVIDIA-{g.upper()}] 智能分组首选: {new_groups[g][0]}")

                else:
                    print(f"[ERROR] 获取模型列表失败，状态码 HTTP {res.status_code}")
        except Exception as e:
            print(f"[ERROR] 探测网络异常: {e}")

    async def periodic_check(self):
        while True:
            await self.fetch_and_test_models()
            await asyncio.sleep(600)

manager = NvidiaManager()

@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(manager.periodic_check())
    yield
    task.cancel()
    print("[SERVER] 服务正在关闭...")

app = FastAPI(title="Nvidia Proxy Service (4 Modes Auto-Optimal)", lifespan=lifespan)

@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    try:
        payload = await request.json()
    except Exception as e:
        print("[ERROR] 无法解析 JSON payload:", e)
        return JSONResponse(status_code=400, content={"error": "Invalid JSON payload"})
        
    req_model = payload.get("model", "")
    stream = payload.get("stream", False)
    
    # 动态匹配分组或直连指定模型
    target_model = None
    fallback_models = []
    profile = "auto"
    
    if req_model in manager.available_models:
        # 用户显式指定了目前在线且响应速度正常的特定模型，直接放行
        target_model = req_model
        fallback_models = [req_model] + [m for m in manager.available_models if m != req_model]
        profile = "EXPLICIT"
    else:
        # 直接从全局测速最优序列中选择最强模型
        profile = "auto"
        group_list = manager.optimal_groups.get("auto", [])
        if not group_list:
            # 极限制兜底
            group_list = ["meta/llama-3.1-405b-instruct", "meta/llama-3.3-70b-instruct"]
            
        target_model = group_list[0]
        fallback_models = group_list
    
    print(f"\n[PROXY-REQ] 收到请求({req_model}) -> 匹配模式 [{profile.upper()}], 引流至首选: {target_model} (Stream={stream})")
    
    headers = {
        "Authorization": f"Bearer {manager.api_key}",
        "Content-Type": "application/json"
    }
    
    simplified_messages = []
    for m in payload.get("messages", []):
        if "content" in m and isinstance(m["content"], list):
            text_content = ""
            for item in m["content"]:
                if isinstance(item, dict) and item.get("type") == "text":
                    text_content += item.get("text", "")
            m["content"] = text_content
        simplified_messages.append(m)
    payload["messages"] = simplified_messages
    
    # 过滤不兼容参数
    if "max_completion_tokens" in payload:
        mc_tokens = payload.pop("max_completion_tokens")
        if "max_tokens" not in payload:
            payload["max_tokens"] = mc_tokens
            
    if stream:
        async def stream_generator():
            for current_model in fallback_models:
                payload["model"] = current_model
                try:
                    async with httpx.AsyncClient() as client:
                        async with client.stream("POST", "https://integrate.api.nvidia.com/v1/chat/completions", headers=headers, json=payload, timeout=60) as response:
                            if response.status_code == 429 or response.status_code >= 500:
                                print(f"⚠️ [{profile.upper()}-WARN] {current_model} 异常({response.status_code})，切往下一节点...")
                                continue
                                
                            if response.status_code != 200:
                                err_text = await response.aread()
                                err_msg = err_text.decode('utf-8')
                                if response.status_code == 400 and ("unsupported" in err_msg or "Extra inputs" in err_msg or "tool" in err_msg):
                                    print(f"⚠️ [{profile.upper()}-WARN] {current_model} 组件交互不兼容(400)，尝试降级节点...")
                                    continue
                                
                                print(f"❌ [{profile.upper()}-ERR] 致命错误 ({response.status_code}): {err_msg}")
                                yield f"data: {json.dumps({'error': err_msg})}\n\n"
                                yield "data: [DONE]\n\n"
                                return
                                
                            print(f"🚀 [{profile.upper()}-OK] 成功接通底层模型 {current_model}，开始流式泵送...\n[流式内容]: ", end="", flush=True)
                            async for chunk in response.aiter_lines():
                                if chunk:
                                    if chunk.startswith("data:") and "[DONE]" not in chunk:
                                        try:
                                            # Nvidia 的 data: 后面可能没有空格，直接 strip()
                                            json_str = chunk.replace("data:", "", 1).strip()
                                            data_json = json.loads(json_str)
                                            
                                            if "choices" in data_json and len(data_json["choices"]) > 0:
                                                delta = data_json["choices"][0].get("delta", {})
                                                content = delta.get("content", "")
                                                if content:
                                                    print(content, end="", flush=True)
                                        except Exception as e:
                                            pass
                                    yield f"{chunk}\n\n"
                            print("\n") # 结束泵送换行
                            return
                except Exception as e:
                    print(f"⏳ [{profile.upper()}-TIMEOUT] 连通超时或断开 ({e})，该节点挂掉，无缝切往下一模型...")
                    continue
            yield f"data: {json.dumps({'error': f'[{profile.upper()}] 所有优选备用节点均失效，请稍后重试。'})}\n\n"
            yield "data: [DONE]\n\n"
            
        return StreamingResponse(stream_generator(), media_type="text/event-stream")
    else:
        for current_model in fallback_models:
            payload["model"] = current_model
            try:
                async with httpx.AsyncClient() as client:
                    res = await client.post("https://integrate.api.nvidia.com/v1/chat/completions", headers=headers, json=payload, timeout=60)
                    if res.status_code == 429 or res.status_code >= 500:
                        print(f"⚠️ [{profile.upper()}-WARN] {current_model} 非流异常 ({res.status_code})，尝试降级...")
                        continue
                        
                    if res.status_code != 200:
                        err_msg = res.text
                        if res.status_code == 400 and ("unsupported" in err_msg or "Extra inputs" in err_msg or "tool" in err_msg):
                            print(f"⚠️ [{profile.upper()}-WARN] {current_model} 非流参数不兼容(400)，尝试降级节点...")
                            continue
                        
                        return JSONResponse(status_code=res.status_code, content=res.json() if "{" in res.text else {"detail": res.text})
                    return res.json()
            except Exception as e:
                print(f"⏳ [{profile.upper()}-TIMEOUT] 非流计算超时 ({e})，切换切往下一模型...")
                continue
                
        return JSONResponse(status_code=504, content={"detail": f"[{profile.upper()}] 分组所有节点均遭遇阻断或超时。"})

if __name__ == "__main__":
    import uvicorn
    print("[SERVER] 正在启动 Nvidia 自适应分组（4路并发）代理集群 ...")
    uvicorn.run(app, host="127.0.0.1", port=38808)
