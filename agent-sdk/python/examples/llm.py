# llm.py — a tiny streaming chat client that targets EITHER a local Ollama or
# OpenRouter, chosen automatically from the environment. Python mirror of
# agent-sdk/typescript/examples/llm.ts.
#
# This is the "reusable base" behind 04-combined.py: it reduces both backends to
# one chat shape, so the agent — and any future tool-calling — looks the same
# regardless of provider. Keep it small and dependency-light (just httpx).
#
#   OPENROUTER_API_KEY set?  → OpenRouter (OPENROUTER_MODEL, default openai/gpt-4o-mini)
#   otherwise                → local Ollama (OLLAMA_MODEL, default llama3.2; OLLAMA_URL)

from __future__ import annotations

import json
import os
from collections.abc import AsyncGenerator

import httpx

ChatMessage = dict[str, str]  # {"role": ..., "content": ...}


class OllamaClient:
    def __init__(self) -> None:
        self.url = os.environ.get("OLLAMA_URL", "http://localhost:11434")
        self.model = os.environ.get("OLLAMA_MODEL", "llama3.2")
        self.label = f"ollama/{self.model}"

    async def chat_stream(self, messages: list[ChatMessage]) -> AsyncGenerator[str, None]:
        # /api/chat returns newline-delimited JSON, each line `{message: {content}}`.
        async with (
            httpx.AsyncClient(timeout=None) as client,
            client.stream(
                "POST",
                f"{self.url}/api/chat",
                json={"model": self.model, "messages": messages, "stream": True},
            ) as resp,
        ):
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line.strip():
                    continue
                # A rare malformed line shouldn't crash the stream — skip it.
                try:
                    token = (json.loads(line).get("message") or {}).get("content", "")
                except json.JSONDecodeError:
                    continue
                if token:
                    yield token


class OpenRouterClient:
    def __init__(self, api_key: str) -> None:
        self.api_key = api_key
        self.model = os.environ.get("OPENROUTER_MODEL", "openai/gpt-4o-mini")
        self.label = f"openrouter/{self.model}"

    async def chat_stream(self, messages: list[ChatMessage]) -> AsyncGenerator[str, None]:
        # OpenAI SSE: `data: {json}` lines (+ keep-alive comments), then `data: [DONE]`.
        headers = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}
        async with (
            httpx.AsyncClient(timeout=None) as client,
            client.stream(
                "POST",
                "https://openrouter.ai/api/v1/chat/completions",
                headers=headers,
                json={"model": self.model, "messages": messages, "stream": True},
            ) as resp,
        ):
            resp.raise_for_status()
            async for raw in resp.aiter_lines():
                line = raw.strip()
                if not line.startswith("data:"):
                    continue
                data = line[len("data:") :].strip()
                if data in ("", "[DONE]"):
                    continue
                try:
                    token = json.loads(data)["choices"][0]["delta"].get("content")
                except (json.JSONDecodeError, KeyError, IndexError):
                    continue
                if token:
                    yield token


LlmClient = OllamaClient | OpenRouterClient


def create_llm_client() -> LlmClient:
    """Pick a backend from the environment: OpenRouter if a key is present, else Ollama."""
    api_key = os.environ.get("OPENROUTER_API_KEY")
    return OpenRouterClient(api_key) if api_key else OllamaClient()
