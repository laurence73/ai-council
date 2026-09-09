#!/usr/bin/env python3
"""
AI Council - Multi-Model Code Review System
Runs parallel AI reviews using GPT-4, Grok, and Gemini
"""

import asyncio
import json
import sqlite3
import hashlib
import argparse
from pathlib import Path
from datetime import datetime
from typing import Optional
import os
import time
import sys
import threading

# Load .env file if it exists
def load_env_file():
    env_path = Path(__file__).parent / ".env"
    if env_path.exists():
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, value = line.split("=", 1)
                    if key not in os.environ:  # Don't override existing env vars
                        os.environ[key] = value

load_env_file()

# Optional imports - install as needed
try:
    import openai
    HAS_OPENAI = True
except ImportError:
    HAS_OPENAI = False

try:
    import httpx
    HAS_HTTPX = True
except ImportError:
    HAS_HTTPX = False

try:
    from watchdog.observers import Observer
    from watchdog.events import FileSystemEventHandler
    HAS_WATCHDOG = True
except ImportError:
    HAS_WATCHDOG = False

try:
    import anthropic
    HAS_ANTHROPIC = True
except ImportError:
    HAS_ANTHROPIC = False


# Configuration - uses script directory for database
SCRIPT_DIR = Path(__file__).parent.resolve()

DEFAULT_CONFIG = {
    "repo_path": os.environ.get("AI_COUNCIL_REPO", str(Path.cwd())),
    "db_path": str(SCRIPT_DIR / "reviews.db"),
    "watch_patterns": ["*.cs", "*.razor", "*.ts", "*.tsx", "*.js", "*.py", "*.go", "*.rs"],
    "ignore_patterns": ["bin", "obj", "publish", "node_modules", ".git", "__pycache__", "venv"],
    "models": {
        "gpt-4": {"enabled": True, "api_key_env": "OPENAI_API_KEY"},
        "grok": {"enabled": True, "api_key_env": "XAI_API_KEY"},
        "claude": {"enabled": True, "api_key_env": "ANTHROPIC_API_KEY"},
        "gemini": {"enabled": False, "api_key_env": "GOOGLE_API_KEY"}
    }
}

# Model configurations: standard (fast/cheap) vs power (best/expensive)
MODEL_CONFIGS = {
    "standard": {
        "gpt-4": "gpt-4-turbo",
        "grok": "grok-3-mini",
        "claude": "claude-sonnet-4-5",
        "gemini": "gemini-2.0-flash",
    },
    "power": {
        "gpt-4": "gpt-6-astra",
        "grok": "grok-3",
        "claude": "claude-fable-5-1",
        "gemini": "gemini-2.5-pro-preview-06-05",
    }
}

# API pricing per 1M tokens (as of 2024)
API_PRICING = {
    # Standard models
    "gpt-4": {"input": 10.00, "output": 30.00},      # GPT-4 Turbo
    "grok": {"input": 5.00, "output": 15.00},        # Grok (estimated)
    "claude": {"input": 3.00, "output": 15.00},      # Claude Sonnet
    "gemini": {"input": 0.075, "output": 0.30},      # Gemini 1.5 Flash
}

# Power model pricing (higher costs) - Sep 2026 prices
API_PRICING_POWER = {
    "gpt-4": {"input": 5.00, "output": 20.00},       # GPT-6 Astra (2.5x GPT-5.6 Sol)
    "grok": {"input": 3.00, "output": 15.00},        # Grok-3
    "claude": {"input": 10.00, "output": 50.00},     # Claude Fable 5.1
    "gemini": {"input": 1.25, "output": 10.00},      # Gemini 2.5 Pro
}


def calculate_cost(model: str, input_tokens: int, output_tokens: int, power_mode: bool = False) -> float:
    """Calculate cost in USD for a given model and token usage"""
    pricing_table = API_PRICING_POWER if power_mode else API_PRICING
    pricing = pricing_table.get(model, {"input": 0, "output": 0})
    input_cost = (input_tokens / 1_000_000) * pricing["input"]
    output_cost = (output_tokens / 1_000_000) * pricing["output"]
    return input_cost + output_cost


def format_usage_summary(usage_by_model: dict, power_mode: bool = False) -> str:
    """Format token usage summary for console output"""
    mode_label = " (POWER MODE)" if power_mode else ""
    lines = [f"\n[Token Usage{mode_label}]"]
    total_input = 0
    total_output = 0
    total_cost = 0.0

    for model, usage in usage_by_model.items():
        input_tokens = usage.get("input_tokens", 0)
        output_tokens = usage.get("output_tokens", 0)
        cost = calculate_cost(model, input_tokens, output_tokens, power_mode)
        total_input += input_tokens
        total_output += output_tokens
        total_cost += cost
        lines.append(f"  {model.upper():8s} {input_tokens:,} in / {output_tokens:,} out  (~${cost:.4f})")

    lines.append("  " + "-" * 40)
    lines.append(f"  {'TOTAL':8s} {total_input:,} in / {total_output:,} out  (~${total_cost:.4f})")
    return "\n".join(lines)


def get_current_repo() -> str:
    """Get the current git repo in owner/repo format"""
    import subprocess
    try:
        result = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            url = result.stdout.strip()
            # Parse GitHub URL: https://github.com/owner/repo.git or git@github.com:owner/repo.git
            if "github.com" in url:
                if url.startswith("git@"):
                    # git@github.com:owner/repo.git
                    path = url.split(":")[-1]
                else:
                    # https://github.com/owner/repo.git
                    path = url.split("github.com/")[-1]
                return path.replace(".git", "")
    except Exception:
        pass
    return None


def create_github_issues(file_path: str, issues: list, repo: str = None, consensus_only: bool = True) -> list:
    """Create GitHub issues for review findings using gh CLI"""
    import subprocess

    if not repo:
        repo = get_current_repo()
        if not repo:
            print("[!] Could not detect git repo. Use --repo to specify.")
            return []

    filename = Path(file_path).name
    created_issues = []

    # Severity to label mapping
    severity_labels = {
        "CRITICAL": "bug,critical",
        "HIGH": "bug",
        "MEDIUM": "enhancement",
        "LOW": "enhancement",
        "INFO": "documentation"
    }

    print(f"\n[*] Creating GitHub issues in {repo}...")

    for issue in issues:
        severity = issue.get("severity", "MEDIUM").upper()
        line = issue.get("line", "?")
        description = issue.get("description", "No description")
        recommendation = issue.get("recommendation", "")
        models = issue.get("models", [issue.get("model", "unknown")])

        # Build issue title
        title = f"[{severity}] {filename}:{line} - {description[:60]}"
        if len(description) > 60:
            title += "..."

        # Build issue body
        body = f"""## Code Review Finding

**File:** `{file_path}`
**Line:** {line}
**Severity:** {severity}
**Found by:** {', '.join(models) if isinstance(models, list) else models}

### Description
{description}

### Recommendation
{recommendation if recommendation else 'No specific recommendation provided.'}

---
*Generated by [AI Council](https://github.com/laurence73/ai-council) - Multi-Model Code Review*
"""

        # Create issue using gh CLI
        try:
            labels = severity_labels.get(severity, "enhancement")
            cmd = [
                "gh", "issue", "create",
                "--repo", repo,
                "--title", title,
                "--body", body,
                "--label", labels
            ]

            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)

            if result.returncode == 0:
                issue_url = result.stdout.strip()
                print(f"  [+] Created: {issue_url}")
                created_issues.append(issue_url)
            else:
                error = result.stderr.strip()
                if "label" in error.lower():
                    # Try without labels if labels don't exist
                    cmd = [
                        "gh", "issue", "create",
                        "--repo", repo,
                        "--title", title,
                        "--body", body
                    ]
                    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
                    if result.returncode == 0:
                        issue_url = result.stdout.strip()
                        print(f"  [+] Created: {issue_url}")
                        created_issues.append(issue_url)
                    else:
                        print(f"  [!] Failed to create issue: {result.stderr.strip()[:100]}")
                else:
                    print(f"  [!] Failed to create issue: {error[:100]}")

        except subprocess.TimeoutExpired:
            print(f"  [!] Timeout creating issue for line {line}")
        except Exception as e:
            print(f"  [!] Error creating issue: {e}")

    print(f"\n[+] Created {len(created_issues)} GitHub issues")
    return created_issues


class ProgressTracker:
    """Simple progress tracking for console output"""

    def __init__(self, models: list):
        self.models = models
        self.model_status = {m: {"status": "pending", "start": None, "end": None, "score": None} for m in models}
        self.start_time = time.time()

    def start_model(self, model: str):
        self.model_status[model]["status"] = "running"
        self.model_status[model]["start"] = time.time()
        print(f"  [~] {model.upper()} started...")

    def complete_model(self, model: str, score: int = None, error: str = None):
        self.model_status[model]["status"] = "error" if error else "done"
        self.model_status[model]["end"] = time.time()
        self.model_status[model]["score"] = score
        elapsed = self._get_elapsed(model)

        completed = sum(1 for m in self.model_status.values() if m["status"] in ("done", "error"))
        total = len(self.models)

        if error:
            print(f"  [!] {model.upper()} ERROR ({elapsed}) [{completed}/{total}]")
        else:
            print(f"  [+] {model.upper()} Score: {score}/10 ({elapsed}) [{completed}/{total}]")

    def _get_elapsed(self, model: str) -> str:
        status = self.model_status[model]
        if status["start"] is None:
            return "--.-s"
        end = status["end"] or time.time()
        elapsed = end - status["start"]
        return f"{elapsed:.1f}s"

    def start_spinner(self):
        """No-op for compatibility"""
        pass

    def stop_spinner(self):
        """No-op for compatibility"""
        pass

    def print_summary(self):
        """Print final summary"""
        total_elapsed = time.time() - self.start_time
        print(f"\n{'='*60}")
        print(f"  Review Complete - Total Time: {total_elapsed:.1f}s")
        print(f"{'='*60}")


REVIEW_SYSTEM_PROMPT = """You are a senior code reviewer. Analyze this code for:

1. **Bugs & Logic Errors** - Potential runtime issues, edge cases, null references
2. **Security Vulnerabilities** - Injection risks, auth issues, data exposure
3. **Performance Issues** - N+1 queries, memory leaks, inefficient algorithms
4. **Code Quality** - Readability, naming, SOLID principles, DRY
5. **Architecture Concerns** - Coupling, cohesion, design patterns

For each issue, provide:
- severity: CRITICAL | HIGH | MEDIUM | LOW | INFO
- line: approximate line number (or null if general)
- description: what the issue is
- recommendation: how to fix it
- confidence: 0-100

Output ONLY valid JSON:
{
  "issues": [
    {"severity": "...", "line": N, "description": "...", "recommendation": "...", "confidence": N}
  ],
  "summary": "Brief overall assessment",
  "quality_score": 1-10
}"""


class ReviewDatabase:
    """SQLite database for storing reviews"""

    def __init__(self, db_path: str):
        self.db_path = db_path
        self.conn = sqlite3.connect(db_path)
        self.setup()

    def setup(self):
        self.conn.executescript("""
            CREATE TABLE IF NOT EXISTS reviews (
                id INTEGER PRIMARY KEY,
                file_path TEXT NOT NULL,
                file_hash TEXT NOT NULL,
                model TEXT NOT NULL,
                review_json TEXT NOT NULL,
                quality_score REAL,
                issue_count INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS queue (
                id INTEGER PRIMARY KEY,
                file_path TEXT NOT NULL,
                priority TEXT DEFAULT 'normal',
                status TEXT DEFAULT 'pending',
                queued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_reviews_file ON reviews(file_path);
            CREATE INDEX IF NOT EXISTS idx_reviews_hash ON reviews(file_hash);
            CREATE INDEX IF NOT EXISTS idx_queue_status ON queue(status);
        """)
        self.conn.commit()

    def add_review(self, file_path: str, file_hash: str, model: str, review: dict):
        self.conn.execute("""
            INSERT INTO reviews (file_path, file_hash, model, review_json, quality_score, issue_count)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (
            file_path,
            file_hash,
            model,
            json.dumps(review),
            review.get("quality_score", 0),
            len(review.get("issues", []))
        ))
        self.conn.commit()

    def get_reviews(self, file_path: str, limit: int = 10) -> list:
        cursor = self.conn.execute("""
            SELECT model, review_json, created_at
            FROM reviews
            WHERE file_path = ?
            ORDER BY created_at DESC
            LIMIT ?
        """, (file_path, limit))
        return [{"model": r[0], "review": json.loads(r[1]), "created_at": r[2]} for r in cursor]

    def get_latest_by_hash(self, file_hash: str) -> list:
        cursor = self.conn.execute("""
            SELECT model, review_json
            FROM reviews
            WHERE file_hash = ?
        """, (file_hash,))
        return [{"model": r[0], "review": json.loads(r[1])} for r in cursor]

    def queue_file(self, file_path: str, priority: str = "normal"):
        self.conn.execute("""
            INSERT INTO queue (file_path, priority, status)
            VALUES (?, ?, 'pending')
        """, (file_path, priority))
        self.conn.commit()

    def get_pending(self, limit: int = 10) -> list:
        cursor = self.conn.execute("""
            SELECT id, file_path, priority
            FROM queue
            WHERE status = 'pending'
            ORDER BY
                CASE priority WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
                queued_at
            LIMIT ?
        """, (limit,))
        return [{"id": r[0], "file_path": r[1], "priority": r[2]} for r in cursor]

    def mark_complete(self, queue_id: int):
        self.conn.execute("UPDATE queue SET status = 'complete' WHERE id = ?", (queue_id,))
        self.conn.commit()


class GPTReviewer:
    """OpenAI GPT-4 reviewer"""

    def __init__(self, api_key: str, model: str = "gpt-4-turbo"):
        if not HAS_OPENAI:
            raise ImportError("openai package not installed. Run: pip install openai")
        self.client = openai.OpenAI(api_key=api_key)
        self.model = model

    async def review(self, code: str, file_path: str) -> dict:
        try:
            # Run synchronous API call in thread pool to avoid blocking event loop
            loop = asyncio.get_event_loop()
            model = self.model
            response = await loop.run_in_executor(
                None,
                lambda: self.client.chat.completions.create(
                    model=model,
                    messages=[
                        {"role": "system", "content": REVIEW_SYSTEM_PROMPT},
                        {"role": "user", "content": f"File: {file_path}\n\n```\n{code}\n```"}
                    ],
                    response_format={"type": "json_object"},
                    temperature=0.3
                )
            )
            result = json.loads(response.choices[0].message.content)
            # Add token usage
            if hasattr(response, 'usage') and response.usage:
                result["_usage"] = {
                    "input_tokens": response.usage.prompt_tokens,
                    "output_tokens": response.usage.completion_tokens
                }
            return result
        except Exception as e:
            return {"error": str(e), "issues": [], "quality_score": 0}


class GrokReviewer:
    """xAI Grok reviewer"""

    # Max characters per chunk (Grok works better with smaller contexts)
    MAX_CHUNK_SIZE = 15000

    def __init__(self, api_key: str, model: str = "grok-3-mini"):
        if not HAS_HTTPX:
            raise ImportError("httpx package not installed. Run: pip install httpx")
        self.api_key = api_key
        self.base_url = "https://api.x.ai/v1"
        self.model = model

    def _chunk_code(self, code: str) -> list:
        """Split large files into reviewable chunks by function/class boundaries"""
        if len(code) <= self.MAX_CHUNK_SIZE:
            return [code]

        chunks = []
        lines = code.split('\n')
        current_chunk = []
        current_size = 0

        for line in lines:
            line_size = len(line) + 1
            # Start new chunk at class/function boundaries when near limit
            is_boundary = line.strip().startswith(('class ', 'def ', 'async def '))
            if current_size + line_size > self.MAX_CHUNK_SIZE and is_boundary and current_chunk:
                chunks.append('\n'.join(current_chunk))
                current_chunk = [line]
                current_size = line_size
            else:
                current_chunk.append(line)
                current_size += line_size

        if current_chunk:
            chunks.append('\n'.join(current_chunk))

        return chunks

    async def review(self, code: str, file_path: str) -> dict:
        chunks = self._chunk_code(code)

        if len(chunks) == 1:
            return await self._review_chunk(chunks[0], file_path, None)

        # Review multiple chunks and merge results
        all_issues = []
        summaries = []
        scores = []

        for i, chunk in enumerate(chunks):
            result = await self._review_chunk(chunk, file_path, i + 1)
            if "error" not in result:
                all_issues.extend(result.get("issues", []))
                summaries.append(result.get("summary", ""))
                scores.append(result.get("quality_score", 5))

        if not scores:
            return {"error": "All chunks failed to review", "issues": [], "quality_score": 0}

        return {
            "issues": all_issues,
            "summary": f"Reviewed in {len(chunks)} chunks. " + " ".join(summaries[:2]),
            "quality_score": sum(scores) // len(scores)
        }

    async def _review_chunk(self, code: str, file_path: str, chunk_num: Optional[int]) -> dict:
        chunk_info = f" (chunk {chunk_num})" if chunk_num else ""
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{self.base_url}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
                        "Content-Type": "application/json"
                    },
                    json={
                        "model": self.model,
                        "messages": [
                            {"role": "system", "content": REVIEW_SYSTEM_PROMPT + "\n\nIMPORTANT: You MUST respond with ONLY valid JSON, no markdown, no explanation."},
                            {"role": "user", "content": f"File: {file_path}{chunk_info}\n\n```\n{code}\n```"}
                        ]
                    },
                    timeout=120.0
                )
                data = response.json()

                # Handle API errors
                if "error" in data:
                    return {"error": str(data.get("error", "Unknown API error")), "issues": [], "quality_score": 0}

                content = data["choices"][0]["message"]["content"]

                # Capture token usage from response
                usage_data = data.get("usage", {})

                # Try to extract JSON from response (Grok sometimes wraps in markdown)
                if "```json" in content:
                    content = content.split("```json")[1].split("```")[0]
                elif "```" in content:
                    parts = content.split("```")
                    for part in parts:
                        part = part.strip()
                        if part.startswith("{"):
                            content = part
                            break

                # Clean up content
                content = content.strip()
                if not content.startswith("{"):
                    # Try to find JSON object in response
                    start = content.find("{")
                    end = content.rfind("}") + 1
                    if start != -1 and end > start:
                        content = content[start:end]
                    else:
                        return {"error": f"No JSON found in response: {content[:200]}...", "issues": [], "quality_score": 0}

                result = json.loads(content)
                # Add token usage
                if usage_data:
                    result["_usage"] = {
                        "input_tokens": usage_data.get("prompt_tokens", 0),
                        "output_tokens": usage_data.get("completion_tokens", 0)
                    }
                return result

        except json.JSONDecodeError as e:
            return {"error": f"JSON parse error: {e}. Response started with: {content[:100] if 'content' in dir() else 'N/A'}...", "issues": [], "quality_score": 0}
        except Exception as e:
            return {"error": str(e), "issues": [], "quality_score": 0}


class GeminiReviewer:
    """Google Gemini reviewer"""

    def __init__(self, api_key: str, model: str = "gemini-2.0-flash"):
        if not HAS_HTTPX:
            raise ImportError("httpx package not installed. Run: pip install httpx")
        self.api_key = api_key
        self.base_url = "https://generativelanguage.googleapis.com/v1beta"
        self.model = model

    async def review(self, code: str, file_path: str) -> dict:
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{self.base_url}/models/{self.model}:generateContent?key={self.api_key}",
                    headers={"Content-Type": "application/json"},
                    json={
                        "contents": [{
                            "parts": [{
                                "text": f"{REVIEW_SYSTEM_PROMPT}\n\nFile: {file_path}\n\n```\n{code}\n```"
                            }]
                        }],
                        "generationConfig": {
                            "temperature": 0.3,
                            "responseMimeType": "application/json"
                        }
                    },
                    timeout=90.0
                )
                data = response.json()
                # Handle API errors
                if "error" in data:
                    return {"error": data["error"].get("message", "Unknown API error"), "issues": [], "quality_score": 0}
                content = data["candidates"][0]["content"]["parts"][0]["text"]
                # Capture token usage
                usage_metadata = data.get("usageMetadata", {})

                # Try to extract JSON from response
                if "```json" in content:
                    content = content.split("```json")[1].split("```")[0]
                elif "```" in content:
                    content = content.split("```")[1].split("```")[0]
                result = json.loads(content)
                # Add token usage
                if usage_metadata:
                    result["_usage"] = {
                        "input_tokens": usage_metadata.get("promptTokenCount", 0),
                        "output_tokens": usage_metadata.get("candidatesTokenCount", 0)
                    }
                return result
        except Exception as e:
            return {"error": str(e), "issues": [], "quality_score": 0}


class ClaudeReviewer:
    """Anthropic Claude reviewer"""

    def __init__(self, api_key: str, model: str = "claude-sonnet-4-5"):
        if not HAS_ANTHROPIC:
            raise ImportError("anthropic package not installed. Run: pip install anthropic")
        self.client = anthropic.Anthropic(api_key=api_key)
        self.model = model

    async def review(self, code: str, file_path: str) -> dict:
        try:
            # Run synchronous API call in thread pool
            import asyncio
            loop = asyncio.get_event_loop()
            model = self.model
            response = await loop.run_in_executor(
                None,
                lambda: self.client.messages.create(
                    model=model,
                    max_tokens=4096,
                    messages=[
                        {"role": "user", "content": f"{REVIEW_SYSTEM_PROMPT}\n\nFile: {file_path}\n\n```\n{code}\n```"}
                    ]
                )
            )
            content = response.content[0].text
            # Capture token usage
            usage_data = None
            if hasattr(response, 'usage') and response.usage:
                usage_data = {
                    "input_tokens": response.usage.input_tokens,
                    "output_tokens": response.usage.output_tokens
                }

            # Try to extract JSON from response
            if "```json" in content:
                content = content.split("```json")[1].split("```")[0]
            elif "```" in content:
                parts = content.split("```")
                for part in parts:
                    part = part.strip()
                    if part.startswith("{"):
                        content = part
                        break
            # Clean and parse
            content = content.strip()
            if not content.startswith("{"):
                start = content.find("{")
                end = content.rfind("}") + 1
                if start != -1 and end > start:
                    content = content[start:end]
            result = json.loads(content)
            # Add token usage
            if usage_data:
                result["_usage"] = usage_data
            return result
        except Exception as e:
            return {"error": str(e), "issues": [], "quality_score": 0}


class AICouncil:
    """Main orchestrator for multi-model reviews"""

    def __init__(self, config: dict = None, enable_gemini: bool = False, enable_claude: bool = False, power_mode: bool = False):
        self.config = config or DEFAULT_CONFIG.copy()
        self.power_mode = power_mode
        # Override model settings if requested
        if enable_gemini:
            self.config["models"]["gemini"]["enabled"] = True
        if enable_claude:
            self.config["models"]["claude"]["enabled"] = True
        self.db = ReviewDatabase(self.config["db_path"])
        self.reviewers = {}
        self._setup_reviewers()

    def _setup_reviewers(self):
        models = self.config.get("models", {})
        mode = "power" if self.power_mode else "standard"
        model_names = MODEL_CONFIGS[mode]

        if self.power_mode:
            print("\n[!] POWER MODE ENABLED - Using premium models (higher cost)")
            print("    Estimated cost: ~$0.30-0.50 per review\n")

        if models.get("gpt-4", {}).get("enabled"):
            api_key = os.environ.get(models["gpt-4"]["api_key_env"])
            if api_key:
                try:
                    model_name = model_names["gpt-4"]
                    self.reviewers["gpt-4"] = GPTReviewer(api_key, model=model_name)
                    print(f"[+] GPT-4 reviewer enabled ({model_name})")
                except ImportError as e:
                    print(f"[-] GPT-4 disabled: {e}")

        if models.get("grok", {}).get("enabled"):
            api_key = os.environ.get(models["grok"]["api_key_env"])
            if api_key:
                try:
                    model_name = model_names["grok"]
                    self.reviewers["grok"] = GrokReviewer(api_key, model=model_name)
                    print(f"[+] Grok reviewer enabled ({model_name})")
                except ImportError as e:
                    print(f"[-] Grok disabled: {e}")

        if models.get("gemini", {}).get("enabled"):
            api_key = os.environ.get(models["gemini"]["api_key_env"])
            if api_key:
                try:
                    model_name = model_names["gemini"]
                    self.reviewers["gemini"] = GeminiReviewer(api_key, model=model_name)
                    print(f"[+] Gemini reviewer enabled ({model_name})")
                except ImportError as e:
                    print(f"[-] Gemini disabled: {e}")

        if models.get("claude", {}).get("enabled"):
            api_key = os.environ.get(models["claude"]["api_key_env"])
            if api_key:
                try:
                    model_name = model_names["claude"]
                    self.reviewers["claude"] = ClaudeReviewer(api_key, model=model_name)
                    print(f"[+] Claude reviewer enabled ({model_name})")
                except ImportError as e:
                    print(f"[-] Claude disabled: {e}")

        if not self.reviewers:
            print("[!] No reviewers configured. Set API keys in environment.")

    def get_file_hash(self, content: str) -> str:
        return hashlib.sha256(content.encode()).hexdigest()[:16]

    async def review_file(self, file_path: str, force: bool = False, show_progress: bool = True) -> dict:
        """Review a single file with all enabled models"""
        path = Path(file_path)
        if not path.exists():
            return {"error": f"File not found: {file_path}"}

        content = path.read_text(encoding="utf-8", errors="ignore")
        file_hash = self.get_file_hash(content)

        # Check if already reviewed (unless forced)
        if not force:
            existing = self.db.get_latest_by_hash(file_hash)
            if existing:
                return {"cached": True, "reviews": existing}

        # Initialize progress tracker
        tracker = None
        if show_progress and self.reviewers:
            tracker = ProgressTracker(list(self.reviewers.keys()))
            tracker.start_spinner()

        # Run reviews in parallel
        results = {}
        tasks = []

        for model_name, reviewer in self.reviewers.items():
            tasks.append(self._review_with_model(model_name, reviewer, content, file_path, tracker))

        if tasks:
            completed = await asyncio.gather(*tasks)
            for model_name, review in completed:
                results[model_name] = review
                self.db.add_review(str(file_path), file_hash, model_name, review)

        # Stop spinner and print summary
        if tracker:
            tracker.stop_spinner()
            tracker.print_summary()

        return {"cached": False, "reviews": results, "_tracker": tracker}

    async def _review_with_model(self, model_name: str, reviewer, content: str, file_path: str, tracker: ProgressTracker = None):
        if tracker:
            tracker.start_model(model_name)

        review = await reviewer.review(content, file_path)
        score = review.get('quality_score') if "error" not in review else None
        error = review.get("error") if "error" in review else None

        if tracker:
            tracker.complete_model(model_name, score=score, error=error)

        return (model_name, review)

    def aggregate_reviews(self, reviews: dict) -> dict:
        """Combine reviews into consensus"""
        all_issues = []
        scores = []

        for model, review in reviews.items():
            if "error" in review:
                continue
            scores.append(review.get("quality_score", 5))
            for issue in review.get("issues", []):
                issue["model"] = model
                all_issues.append(issue)

        # Find consensus issues (mentioned by multiple models)
        issue_map = {}
        for issue in all_issues:
            key = issue.get("description", "")[:50].lower()
            if key not in issue_map:
                issue_map[key] = []
            issue_map[key].append(issue)

        consensus = [issues[0] for issues in issue_map.values() if len(issues) > 1]
        unique = [issues[0] for issues in issue_map.values() if len(issues) == 1]

        return {
            "consensus_issues": consensus,
            "unique_insights": unique,
            "average_score": sum(scores) / len(scores) if scores else 0,
            "model_count": len(reviews)
        }

    def queue_file(self, file_path: str, priority: str = "normal"):
        """Add file to review queue"""
        self.db.queue_file(file_path, priority)
        print(f"[+] Queued: {file_path} (priority: {priority})")

    async def process_queue(self):
        """Process pending reviews"""
        pending = self.db.get_pending(5)
        if not pending:
            print("[*] No pending reviews")
            return

        for item in pending:
            print(f"\n[*] Processing: {item['file_path']}")
            await self.review_file(item['file_path'])
            self.db.mark_complete(item['id'])

    def show_reviews(self, file_path: str):
        """Display reviews for a file"""
        reviews = self.db.get_reviews(file_path)
        if not reviews:
            print(f"No reviews found for: {file_path}")
            return

        print(f"\n{'='*60}")
        print(f"Reviews for: {file_path}")
        print(f"{'='*60}\n")

        for r in reviews:
            print(f"[{r['model'].upper()}] - {r['created_at']}")
            review = r['review']
            if "error" in review:
                print(f"  Error: {review['error']}")
                continue

            print(f"  Quality Score: {review.get('quality_score', '?')}/10")
            print(f"  Summary: {review.get('summary', 'N/A')}")

            issues = review.get("issues", [])
            if issues:
                print(f"  Issues ({len(issues)}):")
                for issue in issues:
                    sev = issue.get("severity", "?")
                    line = issue.get("line", "?")
                    desc = issue.get("description", "")[:60]
                    print(f"    [{sev}] Line {line}: {desc}")
            print()


def generate_html_report(file_path: str, reviews: dict, output_path: str = None, power_mode: bool = False) -> str:
    """Generate a beautiful HTML report for the review results"""
    from datetime import datetime

    filename = Path(file_path).name
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # Calculate consensus and collect token usage
    all_issues = []
    scores = []
    usage_by_model = {}
    for model, review in reviews.items():
        if isinstance(review, dict) and "error" not in review:
            scores.append(review.get("quality_score", 0))
            for issue in review.get("issues", []):
                issue["model"] = model
                all_issues.append(issue)
            # Collect token usage
            if "_usage" in review:
                usage_by_model[model] = review["_usage"]

    avg_score = sum(scores) / len(scores) if scores else 0

    # Find consensus (issues mentioned by multiple models)
    issue_map = {}
    for issue in all_issues:
        key = issue.get("description", "")[:50].lower()
        if key not in issue_map:
            issue_map[key] = []
        issue_map[key].append(issue)

    consensus_issues = [issues[0] for issues in issue_map.values() if len(issues) > 1]

    # Generate HTML
    html = f'''<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI Council Review - {filename}</title>
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🤖</text></svg>">
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
        :root {{
            --indigo-500: #6366f1; --indigo-400: #818cf8; --purple-500: #a855f7;
            --cyan-500: #06b6d4; --cyan-400: #22d3ee; --zinc-900: #18181b;
            --zinc-800: #27272a; --zinc-700: #3f3f46; --zinc-600: #52525b;
            --zinc-500: #71717a; --zinc-400: #a1a1aa; --emerald-500: #10b981;
            --emerald-400: #34d399; --rose-500: #f43f5e; --amber-500: #f59e0b;
            --bg-dark: #09090b; --text-primary: #fafafa; --text-secondary: #a1a1aa;
        }}
        * {{ margin: 0; padding: 0; box-sizing: border-box; }}
        body {{
            font-family: 'Inter', -apple-system, sans-serif;
            background: var(--bg-dark); color: var(--text-primary);
            line-height: 1.7; font-size: 16px; padding: 2rem;
        }}
        .container {{ max-width: 1125px; margin: 0 auto; }}
        .header {{
            background: linear-gradient(135deg, var(--zinc-900), var(--zinc-800));
            border: 1px solid var(--zinc-700); border-radius: 16px;
            padding: 2rem; margin-bottom: 2rem; position: relative; overflow: hidden;
        }}
        .header::before {{
            content: ''; position: absolute; top: 0; left: 0; right: 0; height: 4px;
            background: linear-gradient(90deg, var(--indigo-500), var(--purple-500), var(--cyan-500));
        }}
        .header-content {{ display: flex; align-items: center; gap: 1.5rem; }}
        .header-logo {{ flex-shrink: 0; }}
        .header-logo img {{ width: 100%; height: 100%; object-fit: contain; }}
        .header-text {{ flex: 1; }}
        .header h1 {{
            font-size: 1.75rem; font-weight: 700; margin-bottom: 0.5rem;
            background: linear-gradient(135deg, var(--indigo-400), var(--cyan-400));
            -webkit-background-clip: text; -webkit-text-fill-color: transparent;
        }}
        .header .meta {{ color: var(--zinc-400); font-size: 0.875rem; }}
        .score-grid {{
            display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 1rem; margin-bottom: 2rem;
        }}
        .score-card {{
            background: var(--zinc-800); border: 1px solid var(--zinc-700);
            border-radius: 12px; padding: 1.5rem; text-align: center;
        }}
        .score-card.gpt {{ border-top: 4px solid #10a37f; }}
        .score-card.grok {{ border-top: 4px solid #1da1f2; }}
        .score-card.gemini {{ border-top: 4px solid #8e44ad; }}
        .score-card.claude {{ border-top: 4px solid #d97706; }}
        .score-card.consensus {{ border-top: 4px solid var(--indigo-500); }}
        .score-card h3 {{ font-size: 0.875rem; color: var(--zinc-400); margin-bottom: 0.5rem; }}
        .score-card .score {{ font-size: 2.5rem; font-weight: 700; }}
        .score-card .score.good {{ color: var(--emerald-400); }}
        .score-card .score.medium {{ color: var(--amber-500); }}
        .score-card .score.bad {{ color: var(--rose-500); }}
        .section {{
            background: var(--zinc-800); border: 1px solid var(--zinc-700);
            border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem;
        }}
        .section h2 {{
            font-size: 1.1rem; font-weight: 600; margin-bottom: 1rem;
            padding-bottom: 0.5rem; border-bottom: 1px solid var(--zinc-700);
            display: flex; align-items: center; gap: 0.5rem;
        }}
        .issue {{
            background: var(--zinc-900); border-radius: 8px; padding: 1rem;
            margin-bottom: 0.75rem; border-left: 4px solid var(--zinc-600);
        }}
        .issue.critical {{ border-left-color: #dc2626; }}
        .issue.high {{ border-left-color: #ea580c; }}
        .issue.medium {{ border-left-color: var(--amber-500); }}
        .issue.low {{ border-left-color: var(--cyan-500); }}
        .issue.info {{ border-left-color: var(--zinc-500); }}
        .issue-header {{ display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.5rem; }}
        .badge {{
            display: inline-block; padding: 0.2em 0.6em; font-size: 0.7rem;
            font-weight: 600; border-radius: 4px; text-transform: uppercase;
        }}
        .badge.critical {{ background: #dc2626; color: white; }}
        .badge.high {{ background: #ea580c; color: white; }}
        .badge.medium {{ background: var(--amber-500); color: black; }}
        .badge.low {{ background: var(--cyan-500); color: white; }}
        .badge.info {{ background: var(--zinc-600); color: var(--text-secondary); }}
        .issue-line {{ font-family: 'JetBrains Mono', monospace; font-size: 0.75rem; color: var(--zinc-400); }}
        .issue-file {{ font-family: 'JetBrains Mono', monospace; font-size: 0.75rem; color: var(--cyan-400); margin-right: 0.5rem; }}
        .issue-desc {{ color: var(--text-secondary); font-size: 0.9rem; }}
        .issue-rec {{ color: var(--emerald-400); font-size: 0.85rem; margin-top: 0.5rem; font-style: italic; }}
        .model-tag {{
            font-size: 0.65rem; padding: 0.15em 0.4em; border-radius: 3px;
            background: var(--zinc-700); color: var(--zinc-400);
        }}
        .summary {{ color: var(--text-secondary); font-size: 0.9rem; margin-bottom: 1rem; }}
        .footer {{ text-align: center; margin-top: 2rem; color: var(--zinc-500); font-size: 0.8rem; }}
        code {{ font-family: 'JetBrains Mono', monospace; background: var(--zinc-900); padding: 0.1em 0.3em; border-radius: 3px; font-size: 0.85em; }}
        .usage-card {{
            background: linear-gradient(135deg, var(--zinc-800), var(--zinc-900));
            border: 1px solid var(--zinc-700); border-radius: 12px;
            padding: 1.25rem; margin-bottom: 2rem;
        }}
        .usage-card h3 {{
            font-size: 0.9rem; font-weight: 600; color: var(--zinc-300);
            margin-bottom: 0.75rem; display: flex; align-items: center; gap: 0.5rem;
        }}
        .usage-grid {{
            display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 0.75rem;
        }}
        .usage-item {{
            background: var(--zinc-900); border-radius: 8px; padding: 0.75rem;
            display: flex; flex-direction: column; gap: 0.25rem;
        }}
        .usage-model {{ font-size: 0.75rem; font-weight: 600; color: var(--zinc-400); text-transform: uppercase; }}
        .usage-model.gpt {{ color: #10a37f; }}
        .usage-model.grok {{ color: #1da1f2; }}
        .usage-model.claude {{ color: #d97706; }}
        .usage-model.gemini {{ color: #8e44ad; }}
        .usage-tokens {{ font-family: 'JetBrains Mono', monospace; font-size: 0.8rem; color: var(--text-secondary); }}
        .usage-cost {{ font-size: 0.85rem; font-weight: 600; color: var(--emerald-400); }}
        .usage-total {{ background: linear-gradient(135deg, var(--indigo-500), var(--purple-500)); border-radius: 8px; padding: 0.75rem; }}
        .usage-total .usage-model {{ color: white; }}
        .usage-total .usage-tokens {{ color: rgba(255,255,255,0.8); }}
        .usage-total .usage-cost {{ color: white; font-size: 1rem; }}
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="header-content">
                <div class="header-logo">
                    <img src="https://cdn.jsdelivr.net/gh/laurence73/assets@main/logos/ai-council-logo.png" alt="AI Council Logo" />
                </div>
                <div class="header-text">
                    <h1>Review</h1>
                    <div class="meta">
                        <strong>{filename}</strong> &bull; {timestamp}
                    </div>
                </div>
            </div>
        </div>
'''

    # Add token usage section if we have usage data
    if usage_by_model:
        total_input = sum(u.get("input_tokens", 0) for u in usage_by_model.values())
        total_output = sum(u.get("output_tokens", 0) for u in usage_by_model.values())
        total_cost = sum(calculate_cost(m, u.get("input_tokens", 0), u.get("output_tokens", 0), power_mode) for m, u in usage_by_model.items())

        mode_label = " (POWER MODE)" if power_mode else ""
        html += f'''
        <div class="usage-card">
            <h3>📊 Token Usage & Cost{mode_label}</h3>
            <div class="usage-grid">
'''
        for model, usage in usage_by_model.items():
            input_tokens = usage.get("input_tokens", 0)
            output_tokens = usage.get("output_tokens", 0)
            cost = calculate_cost(model, input_tokens, output_tokens, power_mode)
            model_class = "gpt" if "gpt" in model.lower() else ("grok" if "grok" in model.lower() else ("claude" if "claude" in model.lower() else "gemini"))
            html += f'''
                <div class="usage-item">
                    <span class="usage-model {model_class}">{model.upper()}</span>
                    <span class="usage-tokens">{input_tokens:,} in / {output_tokens:,} out</span>
                    <span class="usage-cost">${cost:.4f}</span>
                </div>
'''

        html += f'''
                <div class="usage-item usage-total">
                    <span class="usage-model">TOTAL</span>
                    <span class="usage-tokens">{total_input:,} in / {total_output:,} out</span>
                    <span class="usage-cost">${total_cost:.4f}</span>
                </div>
            </div>
        </div>
'''

    html += '''
        <div class="score-grid">
'''

    # Add score cards for each model
    for model, review in reviews.items():
        if isinstance(review, dict):
            score = review.get("quality_score", 0) if "error" not in review else "ERR"
            issues_count = len(review.get("issues", [])) if "error" not in review else 0
            model_class = "gpt" if "gpt" in model.lower() else ("grok" if "grok" in model.lower() else ("claude" if "claude" in model.lower() else "gemini"))
            score_class = "good" if isinstance(score, (int, float)) and score >= 7 else ("medium" if isinstance(score, (int, float)) and score >= 5 else "bad")

            html += f'''
            <div class="score-card {model_class}">
                <h3>{model.upper()}</h3>
                <div class="score {score_class}">{score}/10</div>
                <div style="color: var(--zinc-400); font-size: 0.8rem;">{issues_count} issues</div>
            </div>
'''

    # Add consensus card
    html += f'''
            <div class="score-card consensus">
                <h3>CONSENSUS</h3>
                <div class="score {"good" if avg_score >= 7 else ("medium" if avg_score >= 5 else "bad")}">{avg_score:.1f}/10</div>
                <div style="color: var(--zinc-400); font-size: 0.8rem;">{len(consensus_issues)} agreed issues</div>
            </div>
        </div>
'''

    # Add consensus issues section
    if consensus_issues:
        html += '''
        <div class="section">
            <h2>🎯 Consensus Issues (High Confidence)</h2>
'''
        for issue in consensus_issues:
            sev = issue.get("severity", "INFO").lower()
            html += f'''
            <div class="issue {sev}">
                <div class="issue-header">
                    <span class="badge {sev}">{issue.get("severity", "INFO")}</span>
                    <span class="issue-file">{filename}</span>
                    <span class="issue-line">Line {issue.get("line", "?")}</span>
                </div>
                <div class="issue-desc">{issue.get("description", "")}</div>
                {"<div class='issue-rec'>💡 " + issue.get("recommendation", "") + "</div>" if issue.get("recommendation") else ""}
            </div>
'''
        html += '        </div>\n'

    # Add per-model sections
    for model, review in reviews.items():
        if isinstance(review, dict) and "error" not in review:
            issues = review.get("issues", [])
            summary = review.get("summary", "")
            model_class = "gpt" if "gpt" in model.lower() else ("grok" if "grok" in model.lower() else ("claude" if "claude" in model.lower() else "gemini"))
            emoji = "🧠" if "gpt" in model.lower() else ("⚡" if "grok" in model.lower() else ("🔮" if "claude" in model.lower() else "💎"))

            html += f'''
        <div class="section">
            <h2>{emoji} {model.upper()} Review</h2>
            <div class="summary">{summary}</div>
'''
            for issue in issues:
                sev = issue.get("severity", "INFO").lower()
                html += f'''
            <div class="issue {sev}">
                <div class="issue-header">
                    <span class="badge {sev}">{issue.get("severity", "INFO")}</span>
                    <span class="issue-file">{filename}</span>
                    <span class="issue-line">Line {issue.get("line", "?")}</span>
                </div>
                <div class="issue-desc">{issue.get("description", "")}</div>
                {"<div class='issue-rec'>💡 " + issue.get("recommendation", "") + "</div>" if issue.get("recommendation") else ""}
            </div>
'''
            html += '        </div>\n'

    html += '''
        <div class="footer">
            Generated by AI Council &bull; Multi-Model Code Review System<br>
            <a href="https://github.com/laurence73/ai-council" style="color: var(--indigo-400);">github.com/laurence73/ai-council</a>
        </div>
    </div>
</body>
</html>
'''

    # Write to file
    if output_path is None:
        output_path = str(SCRIPT_DIR / "reports" / f"review-{Path(file_path).stem}-{datetime.now().strftime('%Y%m%d-%H%M%S')}.html")

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    Path(output_path).write_text(html, encoding="utf-8")

    return output_path


class FileWatchHandler(FileSystemEventHandler):
    """Watchdog handler for file changes"""

    def __init__(self, council: AICouncil):
        self.council = council
        self.config = council.config

    def should_review(self, path: str) -> bool:
        p = Path(path)

        # Check ignore patterns
        for ignore in self.config.get("ignore_patterns", []):
            if ignore in str(p):
                return False

        # Check watch patterns
        for pattern in self.config.get("watch_patterns", []):
            if p.match(pattern):
                return True

        return False

    def on_modified(self, event):
        if event.is_directory:
            return
        if self.should_review(event.src_path):
            print(f"[*] File changed: {event.src_path}")
            self.council.queue_file(event.src_path)


def main():
    parser = argparse.ArgumentParser(description="AI Council - Multi-Model Code Review")
    subparsers = parser.add_subparsers(dest="command", help="Commands")

    # Status command
    subparsers.add_parser("status", help="Show current status")

    # Review command
    review_parser = subparsers.add_parser("review", help="Review a file")
    review_parser.add_argument("file", help="File to review")
    review_parser.add_argument("--force", "-f", action="store_true", help="Force re-review")
    review_parser.add_argument("--gemini", "-g", action="store_true", help="Include Gemini in review")
    review_parser.add_argument("--claude", "-c", action="store_true", help="Include Claude in review")
    review_parser.add_argument("--power", "-p", action="store_true", help="Use premium models (higher cost, better results)")
    review_parser.add_argument("--html", action="store_true", help="Generate HTML report")
    review_parser.add_argument("--output", "-o", help="Output path for HTML report")
    review_parser.add_argument("--issues", action="store_true", help="Create GitHub issues for consensus findings")
    review_parser.add_argument("--issues-all", action="store_true", help="Create GitHub issues for ALL findings")
    review_parser.add_argument("--repo", help="Target repo for issues (default: current git repo)")

    # Show command
    show_parser = subparsers.add_parser("show", help="Show reviews for a file")
    show_parser.add_argument("file", help="File to show reviews for")

    # Queue command
    queue_parser = subparsers.add_parser("queue", help="Queue a file for review")
    queue_parser.add_argument("file", help="File to queue")
    queue_parser.add_argument("--priority", "-p", default="normal", choices=["high", "normal", "low"])

    # Process command
    subparsers.add_parser("process", help="Process pending reviews")

    # Watch command
    watch_parser = subparsers.add_parser("watch", help="Watch for file changes")
    watch_parser.add_argument("--path", "-p", default="C:/RUBI/RUBI1", help="Path to watch")

    args = parser.parse_args()

    # Enable optional models and power mode if flags are passed on review command
    enable_gemini = getattr(args, 'gemini', False)
    enable_claude = getattr(args, 'claude', False)
    power_mode = getattr(args, 'power', False)
    council = AICouncil(enable_gemini=enable_gemini, enable_claude=enable_claude, power_mode=power_mode)

    if args.command == "status":
        print("\n=== AI Council Status ===")
        print(f"Database: {council.config['db_path']}")
        print(f"Reviewers: {', '.join(council.reviewers.keys()) or 'None configured'}")
        pending = council.db.get_pending(100)
        print(f"Pending reviews: {len(pending)}")

    elif args.command == "review":
        # Get actual model names being used
        mode = "power" if power_mode else "standard"
        model_names = MODEL_CONFIGS[mode]
        active_models = [(k, model_names[k]) for k in council.reviewers.keys()]

        print(f"\n{'='*60}")
        print(f"  AI Council Review: {Path(args.file).name}")
        print(f"  Mode: {'POWER' if power_mode else 'Standard'}")
        print(f"{'='*60}")
        print(f"  Models:")
        for key, model_id in active_models:
            print(f"    - {key.upper():8s} -> {model_id}")
        print(f"{'='*60}\n")

        result = asyncio.run(council.review_file(args.file, force=args.force))

        if result.get("cached"):
            print("\n[*] Using cached review (use --force to re-review)")

        reviews_data = {}
        usage_by_model = {}
        if "reviews" in result:
            # Print detailed results
            print(f"\n{'='*60}")
            print("  Detailed Results")
            print(f"{'='*60}")

            for model, review in result["reviews"].items():
                reviews_data[model] = review
                if "error" in review:
                    print(f"\n  [{model.upper()}] ERROR: {review['error'][:80]}")
                else:
                    issues = review.get("issues", [])
                    score = review.get('quality_score', '?')
                    print(f"\n  [{model.upper()}] Score: {score}/10 | Issues: {len(issues)}")

                    # Show top issues by severity
                    severity_order = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3, "INFO": 4}
                    sorted_issues = sorted(issues, key=lambda x: severity_order.get(x.get("severity", "INFO"), 5))
                    for issue in sorted_issues[:3]:  # Show top 3
                        sev = issue.get("severity", "?")
                        line = issue.get("line", "?")
                        desc = issue.get("description", "")[:60]
                        print(f"    [{sev}] Line {line}: {desc}...")

                    if len(issues) > 3:
                        print(f"    ... and {len(issues) - 3} more issues")

                    # Collect token usage
                    if "_usage" in review:
                        usage_by_model[model] = review["_usage"]

            # Print token usage summary
            if usage_by_model:
                print(format_usage_summary(usage_by_model, power_mode))

        # Generate HTML report if --html flag is passed
        if getattr(args, 'html', False) and reviews_data:
            output_path = getattr(args, 'output', None)
            report_path = generate_html_report(args.file, reviews_data, output_path, power_mode)
            print(f"\n[+] HTML report generated: {report_path}")

        # Create GitHub issues if --issues or --issues-all flag is passed
        create_issues = getattr(args, 'issues', False)
        create_all_issues = getattr(args, 'issues_all', False)

        if (create_issues or create_all_issues) and reviews_data:
            target_repo = getattr(args, 'repo', None)

            # Collect issues from all reviews
            all_issues = []
            for model, review in reviews_data.items():
                if isinstance(review, dict) and "error" not in review:
                    for issue in review.get("issues", []):
                        issue_copy = issue.copy()
                        issue_copy["model"] = model
                        all_issues.append(issue_copy)

            if create_all_issues:
                # Create issues for all findings
                issues_to_create = all_issues
            else:
                # Find consensus issues (mentioned by multiple models)
                issue_map = {}
                for issue in all_issues:
                    key = issue.get("description", "")[:50].lower()
                    if key not in issue_map:
                        issue_map[key] = {"issue": issue, "models": []}
                    issue_map[key]["models"].append(issue.get("model", "unknown"))

                # Only include issues found by multiple models
                issues_to_create = []
                for key, data in issue_map.items():
                    if len(data["models"]) > 1:
                        issue = data["issue"].copy()
                        issue["models"] = data["models"]
                        issues_to_create.append(issue)

            if issues_to_create:
                create_github_issues(args.file, issues_to_create, target_repo)
            else:
                print("\n[*] No consensus issues found to create GitHub issues for.")
                if not create_all_issues:
                    print("    Use --issues-all to create issues for all findings.")

    elif args.command == "show":
        council.show_reviews(args.file)

    elif args.command == "queue":
        council.queue_file(args.file, args.priority)

    elif args.command == "process":
        asyncio.run(council.process_queue())

    elif args.command == "watch":
        if not HAS_WATCHDOG:
            print("Error: watchdog not installed. Run: pip install watchdog")
            return

        print(f"Watching: {args.path}")
        print("Press Ctrl+C to stop\n")

        handler = FileWatchHandler(council)
        observer = Observer()
        observer.schedule(handler, args.path, recursive=True)
        observer.start()

        try:
            while True:
                asyncio.run(council.process_queue())
                asyncio.run(asyncio.sleep(10))
        except KeyboardInterrupt:
            observer.stop()
        observer.join()

    else:
        parser.print_help()


if __name__ == "__main__":
    main()
