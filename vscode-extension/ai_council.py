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
import uuid
from pathlib import Path
from datetime import datetime
from typing import Optional
import os
import time
import sys
import threading

# Windows defaults stdio to the legacy console codepage (cp1252 etc), which can't represent
# characters like em-dashes or smart quotes that AI-generated text routinely contains -
# printing or JSON-dumping them then mangles or crashes. Force UTF-8 regardless of platform.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

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
    Observer = None
    class FileSystemEventHandler:  # stub so class body can load without watchdog
        pass

try:
    import anthropic
    HAS_ANTHROPIC = True
except ImportError:
    HAS_ANTHROPIC = False

try:
    from cli_transport import CliReviewer, find_cli, resolve_transport, resolve_cli_model, PROVIDER_CLI, CLI_MODEL_CHOICES, extract_json_object
    HAS_CLI_TRANSPORT = True
except ImportError:
    HAS_CLI_TRANSPORT = False
    CliReviewer = None
    def find_cli(name):
        return None
    def resolve_transport(provider, explicit=None):
        return "api"
    def extract_json_object(text):
        return None


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
        "gemini": {"enabled": False, "api_key_env": "GOOGLE_API_KEY"},
        "ollama": {"enabled": False, "api_key_env": "OLLAMA_API_KEY", "url_env": "OLLAMA_URL"}
    }
}

# Model configurations: standard (fast/cheap) vs power (best/expensive)
MODEL_CONFIGS = {
    "standard": {
        "gpt-4": "gpt-4-turbo",
        "grok": "grok-3-mini",
        "claude": "claude-sonnet-4-5",
        "gemini": "gemini-3-flash-preview",
        "ollama": "qwen3.6:35b-mlx",
    },
    "power": {
        "gpt-4": "gpt-6-astra",
        "grok": "grok-3",
        "claude": "claude-fable-5-1",
        "gemini": "gemini-3.1-pro-preview",
        "ollama": "qwen3.6:35b-mlx",
    }
}

# API pricing per 1M tokens (as of 2024)
API_PRICING = {
    # Standard models
    "gpt-4": {"input": 10.00, "output": 30.00},      # GPT-4 Turbo
    "grok": {"input": 5.00, "output": 15.00},        # Grok (estimated)
    "claude": {"input": 3.00, "output": 15.00},      # Claude Sonnet
    "gemini": {"input": 0.075, "output": 0.30},      # Gemini 1.5 Flash
    "ollama": {"input": 0.00, "output": 0.00},       # Self-hosted (free)
}

# Power model pricing (higher costs) - Sep 2026 prices
API_PRICING_POWER = {
    "gpt-4": {"input": 5.00, "output": 20.00},       # GPT-6 Astra (2.5x GPT-5.6 Sol)
    "grok": {"input": 3.00, "output": 15.00},        # Grok-3
    "claude": {"input": 10.00, "output": 50.00},     # Claude Fable 5.1
    "gemini": {"input": 1.25, "output": 10.00},      # Gemini 2.5 Pro
    "ollama": {"input": 0.00, "output": 0.00},       # Self-hosted (free)
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


def describe_exception(e: Exception) -> str:
    """str(e) is empty for several real exception types (httpx's ConnectTimeout/ConnectError
    among them - a network-level failure to a self-hosted endpoint being the common case here),
    which produced a genuinely blank, undiagnosable error message. Fall back to the exception
    type name (still not a full explanation, but tells you timeout vs. connection-refused vs.
    something else, instead of nothing at all)."""
    text = str(e).strip()
    if text:
        return text
    return f"{type(e).__name__} (no further detail available from this error)"


def _cluster_needs_debate(cluster: dict) -> bool:
    """A cluster needs a debate round only if it's unconfirmed (one seat raised it, no
    cross-check yet) or contested (2+ seats raised it but at different severities). A cluster
    where 2+ independent seats already agree on severity is already agreement - arbiter mode
    ratifies it directly instead of spending a seat call re-confirming what's already settled."""
    members = cluster.get("members", [])
    if len(members) < 2:
        return True
    severities = {m["issue"].get("severity") for m in members}
    return len(severities) > 1


def print_scoped_round_results(result: dict):
    """Shared console output for scoped-review and scoped-followup - same shape as the plain
    review command's 'Detailed Results' section plus a consensus summary."""
    print(f"\n{'='*60}")
    print("  Detailed Results")
    print(f"{'='*60}")

    total_models = len(result["reviews"])
    completed = 0
    for model, review in result["reviews"].items():
        completed += 1
        if "error" in review:
            print(f"[!] {model.upper()} ERROR")
            print(f"  [{model.upper()}] ERROR: {review['error'][:80]}")
        else:
            issues = review.get("issues", [])
            score = review.get('quality_score', '?')
            print(f"[+] {model.upper()} Score: {score}/10 (0.0s) [{completed}/{total_models}]")
            print(f"  [{model.upper()}] Score: {score}/10 | Issues: {len(issues)}")
            severity_order = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3, "INFO": 4}
            sorted_issues = sorted(issues, key=lambda x: severity_order.get(str(x.get("severity", "INFO")).upper(), 5))
            for issue in sorted_issues[:5]:
                sev = issue.get("severity", "?")
                line = issue.get("line", "?")
                desc = issue.get("description", "")[:80]
                print(f"    [{sev}] Line {line}: {desc}...")

    consensus = result.get("consensus", {})
    print(f"\n{'='*60}")
    print(f"  Consensus - Average Score: {consensus.get('average_score', 0):.1f}/10")
    print(f"  Consensus issues: {len(consensus.get('consensus_issues', []))}")
    print(f"  Unique insights: {len(consensus.get('unique_insights', []))}")
    print(f"{'='*60}")


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


# Layer 1: permanent integrity rule. Never exposed as a setting, never overridden by the
# rubric or by scope text - always prepended so a custom rubric/scope can't quietly relax it.
REVIEW_INTEGRITY_RULE = """You are a senior code reviewer. State what's true, not what's pleasant:
- If a category has no genuine issues, say so plainly. Do not invent a finding to appear thorough.
- Rate severity by real-world impact, not to seem more useful or more careful than the code warrants.
- Form your own independent judgment. Do not agree with another reviewer's finding merely for
  consensus, and do not soften disagreement with a co-reviewer's assessment if your analysis differs."""

# Layer 2: the rubric - what to actually look for. This is a *default*; the running rubric
# is resolved via get_review_rubric() so it can be overridden by the ai-council.reviewRubric
# VS Code setting (passed through as AI_COUNCIL_REVIEW_RUBRIC) without touching layer 1.
DEFAULT_REVIEW_RUBRIC = """Analyze this code for:

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


def get_review_rubric() -> str:
    """Layer 2, resolved at call time so a live setting change takes effect immediately."""
    return os.environ.get("AI_COUNCIL_REVIEW_RUBRIC", "").strip() or DEFAULT_REVIEW_RUBRIC


def build_review_prompt(scope: str = None) -> str:
    """Compose layer 1 (fixed) + layer 2 (rubric, overridable) + layer 3 (optional scope)."""
    parts = [REVIEW_INTEGRITY_RULE, get_review_rubric()]
    if scope:
        parts.append(f"Additionally, focus the review on this specific request:\n{scope}")
    return "\n\n".join(parts)


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

            CREATE TABLE IF NOT EXISTS scoped_reviews (
                id INTEGER PRIMARY KEY,
                session_id TEXT NOT NULL,
                file_path TEXT NOT NULL,
                file_hash TEXT NOT NULL,
                round_num INTEGER NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS debate_rounds (
                id INTEGER PRIMARY KEY,
                session_id TEXT NOT NULL,
                debate_round_num INTEGER NOT NULL,
                mode TEXT NOT NULL,
                arbiter TEXT,
                clusters_json TEXT NOT NULL,
                positions_json TEXT NOT NULL,
                consensus_pct REAL NOT NULL,
                token_usage_json TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS debate_consolidations (
                id INTEGER PRIMARY KEY,
                session_id TEXT NOT NULL,
                debate_round_num INTEGER NOT NULL,
                consolidated_by TEXT NOT NULL,
                result_json TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(session_id, debate_round_num)
            );

            CREATE INDEX IF NOT EXISTS idx_reviews_file ON reviews(file_path);
            CREATE INDEX IF NOT EXISTS idx_reviews_hash ON reviews(file_hash);
            CREATE INDEX IF NOT EXISTS idx_queue_status ON queue(status);
            CREATE INDEX IF NOT EXISTS idx_scoped_reviews_session ON scoped_reviews(session_id);
            CREATE INDEX IF NOT EXISTS idx_debate_rounds_session ON debate_rounds(session_id);
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

    def add_scoped_round(self, session_id: str, file_path: str, file_hash: str, round_num: int, role: str, content: dict):
        self.conn.execute("""
            INSERT INTO scoped_reviews (session_id, file_path, file_hash, round_num, role, content)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (session_id, file_path, file_hash, round_num, role, json.dumps(content)))
        self.conn.commit()

    def get_scoped_session(self, session_id: str) -> list:
        cursor = self.conn.execute("""
            SELECT round_num, role, content, file_path, file_hash, created_at
            FROM scoped_reviews
            WHERE session_id = ?
            ORDER BY round_num ASC, id ASC
        """, (session_id,))
        return [
            {
                "round_num": r[0],
                "role": r[1],
                "content": json.loads(r[2]),
                "file_path": r[3],
                "file_hash": r[4],
                "created_at": r[5],
            }
            for r in cursor
        ]

    def get_scoped_session_max_round(self, session_id: str) -> int:
        cursor = self.conn.execute("""
            SELECT COALESCE(MAX(round_num), -1) FROM scoped_reviews WHERE session_id = ?
        """, (session_id,))
        return cursor.fetchone()[0]

    def add_debate_round(self, session_id: str, debate_round_num: int, mode: str, arbiter: Optional[str],
                          clusters: list, positions: dict, consensus_pct: float, token_usage: dict = None):
        self.conn.execute("""
            INSERT INTO debate_rounds (session_id, debate_round_num, mode, arbiter, clusters_json, positions_json, consensus_pct, token_usage_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            session_id, debate_round_num, mode, arbiter,
            json.dumps(clusters), json.dumps(positions), consensus_pct,
            json.dumps(token_usage) if token_usage else None,
        ))
        self.conn.commit()

    def get_debate_rounds(self, session_id: str) -> list:
        cursor = self.conn.execute("""
            SELECT debate_round_num, mode, arbiter, clusters_json, positions_json, consensus_pct, token_usage_json, created_at
            FROM debate_rounds
            WHERE session_id = ?
            ORDER BY debate_round_num ASC
        """, (session_id,))
        return [
            {
                "debate_round_num": r[0],
                "mode": r[1],
                "arbiter": r[2],
                "clusters": json.loads(r[3]),
                "positions": json.loads(r[4]),
                "consensus_pct": r[5],
                "token_usage": json.loads(r[6]) if r[6] else None,
                "created_at": r[7],
            }
            for r in cursor
        ]

    def get_latest_debate_round(self, session_id: str) -> Optional[dict]:
        rounds = self.get_debate_rounds(session_id)
        return rounds[-1] if rounds else None

    def get_cached_consolidation(self, session_id: str, debate_round_num: int) -> Optional[dict]:
        cursor = self.conn.execute("""
            SELECT consolidated_by, result_json FROM debate_consolidations
            WHERE session_id = ? AND debate_round_num = ?
        """, (session_id, debate_round_num))
        row = cursor.fetchone()
        if not row:
            return None
        result = json.loads(row[1])
        result["consolidated_by"] = row[0]
        return result

    def save_consolidation(self, session_id: str, debate_round_num: int, consolidated_by: str, result: dict):
        self.conn.execute("""
            INSERT OR REPLACE INTO debate_consolidations (session_id, debate_round_num, consolidated_by, result_json)
            VALUES (?, ?, ?, ?)
        """, (session_id, debate_round_num, consolidated_by, json.dumps(result)))
        self.conn.commit()


class GPTReviewer:
    """OpenAI GPT-4 reviewer"""

    def __init__(self, api_key: str, model: str = "gpt-4-turbo"):
        if not HAS_OPENAI:
            raise ImportError("openai package not installed. Run: pip install openai")
        self.client = openai.OpenAI(api_key=api_key)
        self.model = model

    async def _call_api(self, prompt: str) -> tuple:
        """Make a direct API call. Returns (text, usage_dict)."""
        try:
            loop = asyncio.get_event_loop()
            model = self.model
            response = await loop.run_in_executor(
                None,
                lambda: self.client.chat.completions.create(
                    model=model,
                    messages=[
                        {"role": "user", "content": prompt}
                    ],
                    temperature=0.3
                )
            )
            usage = {"input_tokens": 0, "output_tokens": 0}
            if getattr(response, "usage", None):
                usage = {"input_tokens": response.usage.prompt_tokens, "output_tokens": response.usage.completion_tokens}
            return response.choices[0].message.content, usage
        except Exception as e:
            raise Exception(f"GPT API call failed: {describe_exception(e)}")

    async def review(self, code: str, file_path: str, scope: str = None) -> dict:
        try:
            # Run synchronous API call in thread pool to avoid blocking event loop
            loop = asyncio.get_event_loop()
            model = self.model
            response = await loop.run_in_executor(
                None,
                lambda: self.client.chat.completions.create(
                    model=model,
                    messages=[
                        {"role": "system", "content": build_review_prompt(scope)},
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
            return {"error": describe_exception(e), "issues": [], "quality_score": 0}


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

    async def _call_api(self, prompt: str) -> tuple:
        """Make a direct API call. Returns (text, usage_dict)."""
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
                            {"role": "user", "content": prompt}
                        ]
                    },
                    timeout=120.0
                )
                data = response.json()
                if data.get("error"):
                    raise Exception(str(data["error"]))
                usage_data = data.get("usage", {})
                usage = {"input_tokens": usage_data.get("prompt_tokens", 0), "output_tokens": usage_data.get("completion_tokens", 0)}
                return data["choices"][0]["message"]["content"], usage
        except Exception as e:
            raise Exception(f"Grok API call failed: {describe_exception(e)}")

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

    async def review(self, code: str, file_path: str, scope: str = None) -> dict:
        chunks = self._chunk_code(code)

        if len(chunks) == 1:
            return await self._review_chunk(chunks[0], file_path, None, scope=scope)

        # Review multiple chunks and merge results
        all_issues = []
        summaries = []
        scores = []

        for i, chunk in enumerate(chunks):
            result = await self._review_chunk(chunk, file_path, i + 1, scope=scope)
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

    async def _review_chunk(self, code: str, file_path: str, chunk_num: Optional[int], scope: str = None) -> dict:
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
                            {"role": "system", "content": build_review_prompt(scope) + "\n\nIMPORTANT: You MUST respond with ONLY valid JSON, no markdown, no explanation."},
                            {"role": "user", "content": f"File: {file_path}{chunk_info}\n\n```\n{code}\n```"}
                        ]
                    },
                    timeout=120.0
                )
                data = response.json()

                # Handle API errors
                if data.get("error"):
                    return {"error": str(data["error"]), "issues": [], "quality_score": 0}

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
            return {"error": describe_exception(e), "issues": [], "quality_score": 0}


class GeminiReviewer:
    """Google Gemini reviewer"""

    def __init__(self, api_key: str, model: str = "gemini-3-flash-preview"):
        if not HAS_HTTPX:
            raise ImportError("httpx package not installed. Run: pip install httpx")
        self.api_key = api_key
        self.base_url = "https://generativelanguage.googleapis.com/v1beta"
        self.model = model

    async def _call_api(self, prompt: str) -> tuple:
        """Make a direct API call. Returns (text, usage_dict)."""
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{self.base_url}/models/{self.model}:generateContent?key={self.api_key}",
                    headers={"Content-Type": "application/json"},
                    json={
                        "contents": [{
                            "parts": [{
                                "text": prompt
                            }]
                        }],
                        "generationConfig": {
                            "temperature": 0.3
                        }
                    },
                    timeout=90.0
                )
                data = response.json()
                if data.get("error"):
                    err = data["error"]
                    raise Exception(err.get("message", "Unknown API error") if isinstance(err, dict) else str(err))
                usage_data = data.get("usageMetadata", {})
                usage = {"input_tokens": usage_data.get("promptTokenCount", 0), "output_tokens": usage_data.get("candidatesTokenCount", 0)}
                return data["candidates"][0]["content"]["parts"][0]["text"], usage
        except Exception as e:
            raise Exception(f"Gemini API call failed: {describe_exception(e)}")

    async def review(self, code: str, file_path: str, scope: str = None) -> dict:
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{self.base_url}/models/{self.model}:generateContent?key={self.api_key}",
                    headers={"Content-Type": "application/json"},
                    json={
                        "contents": [{
                            "parts": [{
                                "text": f"{build_review_prompt(scope)}\n\nFile: {file_path}\n\n```\n{code}\n```"
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
                if data.get("error"):
                    err = data["error"]
                    return {"error": err.get("message", "Unknown API error") if isinstance(err, dict) else str(err), "issues": [], "quality_score": 0}
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
            return {"error": describe_exception(e), "issues": [], "quality_score": 0}


class OllamaReviewer:
    """Self-hosted Ollama reviewer (OpenAI-compatible API)"""

    def __init__(self, base_url: str, model: str = "qwen3.6:35b-mlx", api_key: str = None):
        if not HAS_HTTPX:
            raise ImportError("httpx package not installed. Run: pip install httpx")
        # Normalize URL - remove trailing slash
        self.base_url = base_url.rstrip('/')
        self.model = model
        self.api_key = api_key  # Optional Bearer token

    def _get_headers(self) -> dict:
        """Build request headers with appropriate auth"""
        import base64
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            # Check if it's Basic auth format (user:pass) or just a token
            if ':' in self.api_key:
                # Basic auth - encode credentials
                credentials = base64.b64encode(self.api_key.encode()).decode()
                headers["Authorization"] = f"Basic {credentials}"
            else:
                # Bearer token or custom header
                headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    async def _call_api(self, prompt: str) -> tuple:
        """Make a direct API call. Returns (text, usage_dict)."""
        try:
            headers = self._get_headers()
            endpoint = f"{self.base_url}/v1/chat/completions"
            request_body = {
                "model": self.model,
                "messages": [{"role": "user", "content": prompt}],
                "stream": False
            }

            async with httpx.AsyncClient(verify=False) as client:
                response = await client.post(
                    endpoint,
                    headers=headers,
                    json=request_body,
                    timeout=180.0
                )
                if response.status_code != 200:
                    raise Exception(f"HTTP {response.status_code}: {response.text[:200]}")
                data = response.json()
                if data.get("error"):
                    raise Exception(str(data["error"]))
                if "choices" in data:
                    # Ollama/self-hosted endpoints often don't implement the "usage" field at
                    # all - treat a genuinely missing field as unknown, not silently as zero
                    # (a fabricated "0 in / 0 out" reads as a real measurement, not an absence).
                    usage_data = data.get("usage")
                    if isinstance(usage_data, dict) and usage_data:
                        usage = {"input_tokens": usage_data.get("prompt_tokens", 0), "output_tokens": usage_data.get("completion_tokens", 0)}
                    else:
                        usage = {"input_tokens": None, "output_tokens": None}
                    return data["choices"][0]["message"]["content"], usage
                else:
                    raise Exception(f"Unexpected response: {str(data)[:200]}")
        except Exception as e:
            raise Exception(f"Ollama API call failed: {describe_exception(e)}")

    async def review(self, code: str, file_path: str, scope: str = None) -> dict:
        try:
            headers = self._get_headers()

            # Use standard OpenAI-compatible format for all endpoints
            endpoint = f"{self.base_url}/v1/chat/completions"
            request_body = {
                "model": self.model,
                "messages": [
                    {"role": "system", "content": build_review_prompt(scope) + "\n\nIMPORTANT: Respond with ONLY valid JSON, no markdown."},
                    {"role": "user", "content": f"File: {file_path}\n\n```\n{code}\n```"}
                ],
                "stream": False
            }

            print(f"  [DEBUG] Ollama endpoint: {endpoint}")
            print(f"  [DEBUG] Ollama model: {self.model}")
            print(f"  [DEBUG] Ollama headers: {list(headers.keys())}")

            async with httpx.AsyncClient(verify=False) as client:  # verify=False for self-signed certs
                response = await client.post(
                    endpoint,
                    headers=headers,
                    json=request_body,
                    timeout=180.0
                )

                print(f"  [DEBUG] Ollama response status: {response.status_code}")

                # Check HTTP status first
                if response.status_code != 200:
                    error_text = response.text[:500] if response.text else "No response body"
                    print(f"  [!] Ollama HTTP {response.status_code}: {error_text}")
                    return {"error": f"HTTP {response.status_code}: {error_text[:200]}", "issues": [], "quality_score": 0}

                data = response.json()
                print(f"  [DEBUG] Ollama response keys: {list(data.keys()) if isinstance(data, dict) else type(data)}")

                # Handle API errors - check truthiness, not mere key presence: this endpoint
                # can return {"error": null} on a perfectly normal response (seen live: the
                # exact cause of an empty-string error discarding a real, otherwise-valid
                # result), so an "error" key with no actual value is not an error.
                if data.get("error"):
                    error_msg = str(data["error"])
                    print(f"  [!] Ollama API error: {error_msg[:200]}")
                    return {"error": error_msg, "issues": [], "quality_score": 0}

                # Extract content - standard OpenAI format
                content = None
                if "choices" in data and len(data["choices"]) > 0:
                    content = data["choices"][0]["message"]["content"]
                    print(f"  [DEBUG] Ollama content extracted, length: {len(content)}")
                else:
                    print(f"  [DEBUG] Ollama unexpected response: {str(data)[:300]}")
                    return {"error": f"Unexpected response format: {str(data)[:200]}", "issues": [], "quality_score": 0}

                if content is None:
                    return {"error": f"Could not parse response: {str(data)[:200]}", "issues": [], "quality_score": 0}

                # Capture token usage from response if available
                usage_data = data.get("usage", {})

                # A self-hosted model is far more likely than a frontier API to wrap its JSON
                # in commentary, leave an unescaped character in a string value, or otherwise
                # produce something the naive "trim to outer braces" parse below can't handle.
                # Try the same tolerant extractor the CLI transports use (handles fenced
                # blocks, nested envelopes, and a final greedy-brace regex fallback) before
                # falling back to the stricter original parse and its more specific error.
                result = extract_json_object(content)
                if result is not None and ("issues" in result or "quality_score" in result):
                    if usage_data:
                        result["_usage"] = {
                            "input_tokens": usage_data.get("prompt_tokens", 0),
                            "output_tokens": usage_data.get("completion_tokens", 0)
                        }
                    return result

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

                # Clean up content
                content = content.strip()
                if not content.startswith("{"):
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
            return {"error": f"JSON parse error: {e}. Response started with: {content[:200] if 'content' in dir() else 'N/A'}", "issues": [], "quality_score": 0}
        except Exception as e:
            return {"error": describe_exception(e), "issues": [], "quality_score": 0}


class ClaudeReviewer:
    """Anthropic Claude reviewer"""

    def __init__(self, api_key: str, model: str = "claude-sonnet-4-5"):
        if not HAS_ANTHROPIC:
            raise ImportError("anthropic package not installed. Run: pip install anthropic")
        self.client = anthropic.Anthropic(api_key=api_key)
        self.model = model

    async def _call_api(self, prompt: str) -> tuple:
        """Make a direct API call. Returns (text, usage_dict)."""
        try:
            import asyncio
            loop = asyncio.get_event_loop()
            model = self.model
            response = await loop.run_in_executor(
                None,
                lambda: self.client.messages.create(
                    model=model,
                    max_tokens=8192,
                    messages=[
                        {"role": "user", "content": prompt}
                    ]
                )
            )
            usage = {"input_tokens": 0, "output_tokens": 0}
            if getattr(response, "usage", None):
                usage = {"input_tokens": response.usage.input_tokens, "output_tokens": response.usage.output_tokens}
            return response.content[0].text, usage
        except Exception as e:
            raise Exception(f"Claude API call failed: {describe_exception(e)}")

    async def review(self, code: str, file_path: str, scope: str = None) -> dict:
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
                        {"role": "user", "content": f"{build_review_prompt(scope)}\n\nFile: {file_path}\n\n```\n{code}\n```"}
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
            return {"error": describe_exception(e), "issues": [], "quality_score": 0}


class AICouncil:
    """Main orchestrator for multi-model reviews"""

    def __init__(self, config: dict = None, enable_gemini: bool = False, enable_gpt: bool = True, enable_claude: bool = True, enable_grok: bool = True, enable_ollama: bool = False, enable_gpt_cli: bool = False, enable_claude_cli: bool = False, enable_grok_cli: bool = False, ollama_url: str = None, ollama_model: str = None, power_mode: bool = False, db_path: str = None, transports: dict = None):
        import copy
        self.config = config or copy.deepcopy(DEFAULT_CONFIG)
        self.power_mode = power_mode
        self.ollama_url = ollama_url
        self.ollama_model = ollama_model
        self.transports = transports or {}
        self.enable_gpt_cli = enable_gpt_cli
        self.enable_claude_cli = enable_claude_cli
        self.enable_grok_cli = enable_grok_cli
        # Use custom db_path if provided
        if db_path:
            self.config["db_path"] = db_path
            # Ensure directory exists
            Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        # Override model settings if requested
        if enable_gemini:
            self.config["models"]["gemini"]["enabled"] = True
        if enable_ollama:
            self.config["models"]["ollama"]["enabled"] = True
        # Allow disabling default models
        if not enable_gpt:
            self.config["models"]["gpt-4"]["enabled"] = False
        if not enable_claude:
            self.config["models"]["claude"]["enabled"] = False
        if not enable_grok:
            self.config["models"]["grok"]["enabled"] = False
        self.db = ReviewDatabase(self.config["db_path"])
        self.reviewers = {}
        self._setup_reviewers()

    def _setup_reviewers(self):
        """Enable API and CLI seats independently (both can sit on the same council)."""
        models = self.config.get("models", {})
        mode = "power" if self.power_mode else "standard"
        model_names = MODEL_CONFIGS[mode]

        if self.power_mode:
            print("\n[!] POWER MODE ENABLED - Using premium models (higher cost)")
            print("    Estimated cost: ~$0.30-0.50 per review\n")

        def _add_cli(seat: str, provider: str, label: str) -> bool:
            if not HAS_CLI_TRANSPORT:
                print(f"[-] {label} CLI unavailable (cli_transport not loaded)")
                return False
            cli_name = PROVIDER_CLI[provider][0]
            binary = find_cli(cli_name)
            if not binary:
                print(f"[-] {label} CLI not found on PATH ({cli_name})")
                return False
            try:
                cli_model = resolve_cli_model(provider)
                self.reviewers[seat] = CliReviewer(provider, binary, model=cli_model or None)
                shown = cli_model or "default"
                print(f"[+] {label} reviewer enabled (cli:{cli_name}/{shown} as {seat})")
                return True
            except Exception as e:
                print(f"[-] {label} CLI failed: {e}")
                return False

        # GPT API
        if models.get("gpt-4", {}).get("enabled"):
            api_key = os.environ.get(models["gpt-4"]["api_key_env"])
            if api_key:
                try:
                    model_name = model_names["gpt-4"]
                    self.reviewers["gpt-4"] = GPTReviewer(api_key, model=model_name)
                    print(f"[+] GPT-4 reviewer enabled (api:{model_name})")
                except ImportError as e:
                    print(f"[-] GPT-4 API disabled: {e}")
            else:
                print("[-] GPT-4 API disabled: no OPENAI_API_KEY")

        if self.enable_gpt_cli:
            _add_cli("gpt-cli", "openai", "GPT/Codex")

        # Grok API
        if models.get("grok", {}).get("enabled"):
            api_key = os.environ.get(models["grok"]["api_key_env"])
            if api_key:
                try:
                    model_name = model_names["grok"]
                    self.reviewers["grok"] = GrokReviewer(api_key, model=model_name)
                    print(f"[+] Grok reviewer enabled (api:{model_name})")
                except Exception as e:
                    print(f"[-] Grok API disabled: {e}")
            else:
                print("[-] Grok API disabled: no XAI_API_KEY")

        if self.enable_grok_cli:
            _add_cli("grok-cli", "xai", "Grok")

        # Gemini
        if models.get("gemini", {}).get("enabled"):
            api_key = os.environ.get(models["gemini"]["api_key_env"])
            if api_key:
                try:
                    model_name = model_names["gemini"]
                    self.reviewers["gemini"] = GeminiReviewer(api_key, model=model_name)
                    print(f"[+] Gemini reviewer enabled (api:{model_name})")
                except Exception as e:
                    print(f"[-] Gemini disabled: {e}")
            else:
                print("[-] Gemini disabled: no GOOGLE_API_KEY")

        # Claude API
        if models.get("claude", {}).get("enabled"):
            api_key = os.environ.get(models["claude"]["api_key_env"])
            if api_key:
                try:
                    model_name = model_names["claude"]
                    self.reviewers["claude"] = ClaudeReviewer(api_key, model=model_name)
                    print(f"[+] Claude reviewer enabled (api:{model_name})")
                except ImportError as e:
                    print(f"[-] Claude API disabled: {e}")
            else:
                print("[-] Claude API disabled: no ANTHROPIC_API_KEY")

        if self.enable_claude_cli:
            _add_cli("claude-cli", "anthropic", "Claude")

        # Ollama
        if models.get("ollama", {}).get("enabled"):
            ollama_url = self.ollama_url or os.environ.get(
                models.get("ollama", {}).get("url_env", "OLLAMA_URL"),
                "https://wowai-api.worldofworkflows.com:9443",
            )
            model_name = self.ollama_model or model_names.get("ollama", "qwen3.6:35b-mlx")
            api_key = os.environ.get(models.get("ollama", {}).get("api_key_env", "OLLAMA_API_KEY"))
            try:
                self.reviewers["ollama"] = OllamaReviewer(ollama_url, model=model_name, api_key=api_key)
                print(f"[+] Ollama reviewer enabled ({model_name} @ {ollama_url})")
            except Exception as e:
                print(f"[-] Ollama disabled: {e}")

        if not self.reviewers:
            print("[!] No reviewers configured. Turn on API and/or CLI seats (claude / codex / grok).")

    def get_file_hash(self, content: str) -> str:
        return hashlib.sha256(content.encode()).hexdigest()[:16]

    async def review_file(self, file_path: str, force: bool = False, show_progress: bool = True) -> dict:
        """Review a single file with all enabled models"""
        path = Path(file_path)
        if not path.exists():
            return {"error": f"File not found: {file_path}"}

        content = path.read_text(encoding="utf-8", errors="ignore")
        file_hash = self.get_file_hash(content)

        # Get currently enabled models
        enabled_models = set(self.reviewers.keys())

        # Check for cached reviews (unless forced)
        cached_reviews = {}
        models_to_run = set(enabled_models)

        if not force:
            existing = self.db.get_latest_by_hash(file_hash)
            if existing:
                # Filter to only include successful reviews for currently enabled models
                for item in existing:
                    model = item["model"]
                    review = item["review"]
                    # Skip cached errors - re-run those models
                    if model in enabled_models and "error" not in review:
                        cached_reviews[model] = review
                        models_to_run.discard(model)

                # If all enabled models have cached reviews, return them
                if not models_to_run:
                    return {"cached": True, "reviews": cached_reviews}

        # Initialize progress tracker for models that need to be run
        tracker = None
        if show_progress and models_to_run:
            tracker = ProgressTracker(list(models_to_run))
            tracker.start_spinner()

        # Run reviews in parallel for models without cache
        results = dict(cached_reviews)  # Start with cached results
        tasks = []

        for model_name in models_to_run:
            reviewer = self.reviewers[model_name]
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

        has_cached = len(cached_reviews) > 0
        return {"cached": has_cached and not tasks, "reviews": results, "_tracker": tracker}

    async def _review_with_model(self, model_name: str, reviewer, content: str, file_path: str, tracker: ProgressTracker = None, scope: str = None):
        if tracker:
            tracker.start_model(model_name)

        review = await reviewer.review(content, file_path, scope=scope)
        score = review.get('quality_score') if "error" not in review else None
        error = review.get("error") if "error" in review else None

        if tracker:
            tracker.complete_model(model_name, score=score, error=error)

        return (model_name, review)

    async def review_file_scoped(self, file_path: str, scope: str, session_id: str = None, show_progress: bool = True) -> dict:
        """Round 0 of a 'Review with Scope' session: full council, layer1+2+3, no cache reuse
        (a scoped review is a distinct question from the file's canonical unscoped review, so
        it neither reads nor writes the plain `reviews` cache) - persisted to scoped_reviews."""
        path = Path(file_path)
        if not path.exists():
            return {"error": f"File not found: {file_path}"}

        content = path.read_text(encoding="utf-8", errors="ignore")
        file_hash = self.get_file_hash(content)
        session_id = session_id or str(uuid.uuid4())

        enabled_models = list(self.reviewers.keys())
        if not enabled_models:
            return {"error": "No reviewers configured. Turn on API and/or CLI seats (claude / codex / grok)."}

        tracker = ProgressTracker(enabled_models) if show_progress else None
        if tracker:
            tracker.start_spinner()

        tasks = [
            self._review_with_model(model_name, reviewer, content, file_path, tracker, scope=scope)
            for model_name, reviewer in self.reviewers.items()
        ]
        completed = await asyncio.gather(*tasks)
        results = dict(completed)

        if tracker:
            tracker.stop_spinner()
            tracker.print_summary()

        consensus = self.aggregate_reviews(results)

        self.db.add_scoped_round(session_id, str(file_path), file_hash, 0, "user", {"scope": scope})
        self.db.add_scoped_round(session_id, str(file_path), file_hash, 0, "council", {"reviews": results, "consensus": consensus})

        return {"session_id": session_id, "reviews": results, "consensus": consensus, "_tracker": tracker}

    @staticmethod
    def _summarize_scoped_round(round_num: int, entry_by_role: dict) -> str:
        """Compact prior-round summary for follow-up prompts - full issue text would blow up
        the prompt across several rounds, so this keeps model, score, and each finding's headline."""
        lines = [f"--- Round {round_num} ---"]
        user_entry = entry_by_role.get("user")
        if user_entry:
            text = user_entry.get("scope") or user_entry.get("question") or ""
            lines.append(f"Question/scope: {text}")
        council_entry = entry_by_role.get("council")
        if council_entry:
            for model, review in council_entry.get("reviews", {}).items():
                if "error" in review:
                    lines.append(f"{model}: ERROR - {review['error'][:100]}")
                    continue
                score = review.get("quality_score", "?")
                issue_lines = "; ".join(
                    f"[{i.get('severity', '?')}] {i.get('description', '')[:100]}"
                    for i in review.get("issues", [])[:8]
                )
                lines.append(f"{model} (score {score}/10): {issue_lines or 'no issues raised'}")
        return "\n".join(lines)

    def build_scoped_followup_context(self, rounds: list, new_question: str) -> str:
        """Compose the layer-3 scope text for a follow-up: prior rounds (compacted) + new question."""
        by_round: dict = {}
        for r in rounds:
            by_round.setdefault(r["round_num"], {})[r["role"]] = r["content"]

        summaries = [
            self._summarize_scoped_round(round_num, entry_by_role)
            for round_num, entry_by_role in sorted(by_round.items())
        ]
        history = "\n\n".join(summaries)
        return (
            "This is a follow-up in an ongoing review conversation. Prior rounds:\n\n"
            f"{history}\n\n"
            "--- New question for this round ---\n"
            f"{new_question}\n\n"
            "Answer the new question in light of the prior rounds above - you may revise, "
            "confirm, or add to earlier findings, but do not silently repeat them verbatim."
        )

    async def review_file_scoped_followup(self, session_id: str, question: str, show_progress: bool = True) -> dict:
        """Next round of an existing 'Review with Scope' session: full council answers again,
        with the prior rounds (compacted) plus the new question as context."""
        prior_rounds = self.db.get_scoped_session(session_id)
        if not prior_rounds:
            return {"error": f"No scoped review session found: {session_id}"}

        file_path = prior_rounds[0]["file_path"]
        path = Path(file_path)
        if not path.exists():
            return {"error": f"File not found: {file_path}"}

        content = path.read_text(encoding="utf-8", errors="ignore")
        file_hash = self.get_file_hash(content)
        next_round = self.db.get_scoped_session_max_round(session_id) + 1

        enabled_models = list(self.reviewers.keys())
        if not enabled_models:
            return {"error": "No reviewers configured. Turn on API and/or CLI seats (claude / codex / grok)."}

        followup_scope = self.build_scoped_followup_context(prior_rounds, question)

        tracker = ProgressTracker(enabled_models) if show_progress else None
        if tracker:
            tracker.start_spinner()

        tasks = [
            self._review_with_model(model_name, reviewer, content, file_path, tracker, scope=followup_scope)
            for model_name, reviewer in self.reviewers.items()
        ]
        completed = await asyncio.gather(*tasks)
        results = dict(completed)

        if tracker:
            tracker.stop_spinner()
            tracker.print_summary()

        consensus = self.aggregate_reviews(results)

        self.db.add_scoped_round(session_id, file_path, file_hash, next_round, "user", {"question": question})
        self.db.add_scoped_round(session_id, file_path, file_hash, next_round, "council", {"reviews": results, "consensus": consensus})

        return {"session_id": session_id, "round_num": next_round, "reviews": results, "consensus": consensus, "_tracker": tracker}

    @staticmethod
    def _format_scoped_round_full(round_num: int, entry_by_role: dict) -> str:
        """Full-fidelity round transcript for the finalize doc - unlike the follow-up context
        summary, this is written once per session (not re-sent every round), so completeness
        matters more than prompt size."""
        lines = [f"## Round {round_num}"]
        user_entry = entry_by_role.get("user")
        if user_entry:
            text = user_entry.get("scope") or user_entry.get("question") or ""
            label = "Scope" if "scope" in user_entry else "Follow-up question"
            lines.append(f"**{label}:** {text}\n")
        council_entry = entry_by_role.get("council")
        if council_entry:
            for model, review in council_entry.get("reviews", {}).items():
                if "error" in review:
                    lines.append(f"### {model} - ERROR\n{review['error']}\n")
                    continue
                score = review.get("quality_score", "?")
                lines.append(f"### {model} (score {score}/10)")
                for issue in review.get("issues", []):
                    sev = issue.get("severity", "?")
                    line = issue.get("line", "?")
                    desc = issue.get("description", "")
                    rec = issue.get("recommendation", "")
                    entry = f"- **[{sev}]** Line {line}: {desc}"
                    if rec:
                        entry += f"\n  - Recommendation: {rec}"
                    lines.append(entry)
                lines.append("")
            consensus = council_entry.get("consensus", {})
            if consensus:
                lines.append(f"**Round consensus:** average score {consensus.get('average_score', 0):.1f}/10, "
                              f"{len(consensus.get('consensus_issues', []))} issues raised by multiple reviewers.\n")
        return "\n".join(lines)

    def build_scoped_session_transcript(self, rounds: list) -> str:
        """Full transcript of a scoped review session, for the finalize/write-doc step."""
        by_round: dict = {}
        for r in rounds:
            by_round.setdefault(r["round_num"], {})[r["role"]] = r["content"]
        return "\n\n".join(
            self._format_scoped_round_full(round_num, entry_by_role)
            for round_num, entry_by_role in sorted(by_round.items())
        )

    async def finalize_scoped_review(self, session_id: str, writer_name: str, output_path: str = None) -> dict:
        """Have the nominated AI write up the session's findings as a review document
        (not a code fix - the deliverable is the doc itself)."""
        prior_rounds = self.db.get_scoped_session(session_id)
        if not prior_rounds:
            return {"error": f"No scoped review session found: {session_id}"}

        file_path = prior_rounds[0]["file_path"]

        # Fail loudly on an unavailable requested writer, like run_debate_round's arbiter check - no silent substitution.
        if writer_name and writer_name not in self.reviewers:
            return {"error": f"Writer '{writer_name}' is not an enabled/available seat"}

        writer = None
        if writer_name:
            writer = self.reviewers[writer_name]
        else:
            for candidate in ["claude", "claude-cli", "gpt-4", "gpt-cli", "gemini", "grok", "grok-cli", "ollama"]:
                if candidate in self.reviewers:
                    writer = self.reviewers[candidate]
                    writer_name = candidate
                    break
        if not writer:
            return {"error": "No fallback reviewer is enabled to write the review doc"}

        transcript = self.build_scoped_session_transcript(prior_rounds)
        filename = Path(file_path).name

        doc_prompt = f"""You are writing up a code review conversation as a standalone review document
for a human (or another AI) to act on. This is a documentation task, not a code-fixing task -
do not rewrite the source file, only report and recommend.

## File Reviewed: {filename}

## Full Review Conversation
{transcript}

## Your Task
Write a markdown review document with these sections:

1. **Summary** - what was reviewed, what scope/questions were asked, overall assessment
2. **Findings** - the real, still-relevant issues across all rounds, deduplicated (if a later
   round revised or superseded an earlier finding, keep the later judgment, not both)
3. **Recommendations** - concrete, prioritized actions
4. **Open Questions** (if any) - anything the conversation raised but did not resolve

State what's true, not what's pleasant: do not manufacture findings to seem thorough, and do
not omit a genuine finding to make the report shorter. Return ONLY the markdown document -
no preamble, no meta-commentary about this task, no markdown code fences around the whole thing."""

        try:
            if HAS_CLI_TRANSPORT and isinstance(writer, CliReviewer):
                doc, _usage = await writer._call_api(doc_prompt, mode="fix")
            else:
                doc, _usage = await writer._call_api(doc_prompt)
        except Exception as e:
            return {"error": f"Failed to generate review doc: {e}"}

        doc = doc.strip()
        if doc.startswith("```"):
            lines = doc.split("\n")
            if lines[-1].strip() == "```":
                lines = lines[1:-1]
            else:
                lines = lines[1:]
            doc = "\n".join(lines)

        if not output_path:
            reports_dir = Path(self.config["db_path"]).parent / "reports"
            reports_dir.mkdir(parents=True, exist_ok=True)
            clean_name = Path(file_path).stem[:30]
            timestamp = datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
            output_path = str(reports_dir / f"scoped-review-{clean_name}-{timestamp}.md")

        Path(output_path).write_text(doc, encoding="utf-8")

        return {"session_id": session_id, "writer": writer_name, "output_path": output_path, "doc": doc}

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

    async def synthesize_reviews(self, file_path: str, code_content: str, reviews: dict, preferred_synthesizer: str = None) -> dict:
        """AI-powered synthesis of all reviews - Council Verdict"""
        synthesizer = None
        synthesizer_name = None

        # If a specific synthesizer is requested and available, use it
        if preferred_synthesizer and preferred_synthesizer in self.reviewers:
            synthesizer = self.reviewers[preferred_synthesizer]
            synthesizer_name = preferred_synthesizer
        else:
            # Fall back to best available (prefer Claude > GPT-4 > Gemini > Grok)
            synthesis_order = ['claude', 'claude-cli', 'gpt-4', 'gpt-cli', 'gemini', 'grok', 'grok-cli', 'ollama']
            for model_name in synthesis_order:
                if model_name in self.reviewers:
                    synthesizer = self.reviewers[model_name]
                    synthesizer_name = model_name
                    break

        if not synthesizer:
            return {"error": "No AI available for synthesis"}

        # Build the synthesis prompt
        filename = Path(file_path).name

        # Format individual reviews
        reviews_text = ""
        for model, review in reviews.items():
            if "error" in review:
                reviews_text += f"\n### {model.upper()} - ERROR\nFailed to review.\n"
                continue

            score = review.get("quality_score", "?")
            issues = review.get("issues", [])
            reviews_text += f"\n### {model.upper()} (Score: {score}/10)\n"

            if issues:
                for i, issue in enumerate(issues, 1):
                    sev = issue.get("severity", "?")
                    line = issue.get("line", "?")
                    desc = issue.get("description", "")
                    reviews_text += f"{i}. [{sev}] Line {line}: {desc}\n"
            else:
                reviews_text += "No issues found.\n"

        # Truncate code if too long
        code_preview = code_content[:3000] + "\n...(truncated)" if len(code_content) > 3000 else code_content

        synthesis_prompt = f"""You are the Chief Arbiter of the AI Council, synthesizing code reviews from multiple AI models.

## File Under Review: {filename}

## Code Preview:
```
{code_preview}
```

## Individual Model Reviews:
{reviews_text}

## Your Synthesis Task:
Analyze all reviews and provide a unified Council Verdict:

1. **Consensus Issues** - Issues flagged by 2+ models (most important to fix)
2. **Disputed Findings** - Where models disagree, and your judgment on who's correct
3. **Priority Ranking** - Top 3 issues to fix first, with reasoning
4. **Potential False Positives** - Any issues that seem incorrect or overly pedantic
5. **Council Verdict** - Overall assessment in 2-3 sentences

Respond in JSON format:
{{
    "consensus_issues": [
        {{"description": "...", "severity": "high/medium/low", "models_agreed": ["gpt-4", "claude"], "line": 123}}
    ],
    "disputed_findings": [
        {{"issue": "...", "models_for": ["gpt-4"], "models_against": ["claude"], "verdict": "...", "correct_assessment": "..."}}
    ],
    "priority_ranking": [
        {{"rank": 1, "issue": "...", "reason": "..."}}
    ],
    "false_positives": [
        {{"issue": "...", "flagged_by": "gpt-4", "reason_incorrect": "..."}}
    ],
    "council_verdict": "Overall assessment...",
    "final_score": 8
}}"""

        print(f"\n[*] Synthesizing reviews with {synthesizer_name.upper()}...")

        try:
            # CLI transports default to the review JSON-schema pipeline; a synthesis verdict
            # has a completely different shape (consensus_issues/council_verdict/etc, not
            # issues/quality_score), so without mode="fix" the CLI wraps the real answer
            # inside its own forced schema's "summary" string field instead of returning it
            # directly - silently producing an "empty" verdict (every real key missing,
            # every .get(..., default) firing) rather than an error.
            if HAS_CLI_TRANSPORT and isinstance(synthesizer, CliReviewer):
                response, _usage = await synthesizer._call_api(synthesis_prompt, mode="fix")
            else:
                response, _usage = await synthesizer._call_api(synthesis_prompt)

            synthesis = self._extract_wrapped_json(response, required_key="council_verdict")
            if synthesis is not None:
                synthesis["synthesized_by"] = synthesizer_name
                print(f"[+] Synthesis complete by {synthesizer_name.upper()}")
                return synthesis
            else:
                return {"error": "Failed to parse synthesis response", "raw": response[:500]}
        except Exception as e:
            return {"error": f"Synthesis failed: {describe_exception(e)}"}

    @staticmethod
    def _extract_wrapped_json(response: str, required_key: str) -> Optional[dict]:
        """Parse a JSON object containing `required_key` out of a raw model response,
        tolerating the real answer being nested inside a wrapper's string field (e.g.
        {"summary": "<json>"}) - defense in depth for any prompt whose expected shape isn't
        the review schema, even with mode="fix" set correctly at the call site. Used by
        synthesis, clustering, and debate-round parsing so they can't independently drift."""
        import re

        def try_parse(text: str) -> Optional[dict]:
            match = re.search(r'\{[\s\S]*\}', text)
            if not match:
                return None
            try:
                data = json.loads(match.group())
            except json.JSONDecodeError:
                return None
            if isinstance(data, dict) and required_key in data:
                return data
            # Not the right shape at the top level - check string-valued fields for a
            # nested match (the wrapper-field case).
            if isinstance(data, dict):
                for value in data.values():
                    if isinstance(value, str):
                        nested = try_parse(value)
                        if nested is not None:
                            return nested
            return None

        return try_parse(response)

    # Priority order for picking an AI seat when none is explicitly specified - shared by
    # synthesis, clustering, and arbiter-fallback selection.
    _SEAT_PRIORITY = ['claude', 'claude-cli', 'gpt-4', 'gpt-cli', 'gemini', 'grok', 'grok-cli', 'ollama']

    def _pick_seat(self, preferred: str = None, exclude: set = None) -> tuple:
        """Returns (seat_name, reviewer) for `preferred` if available and not excluded,
        else the first seat in _SEAT_PRIORITY that's enabled and not excluded."""
        exclude = exclude or set()
        if preferred and preferred in self.reviewers and preferred not in exclude:
            return preferred, self.reviewers[preferred]
        for name in self._SEAT_PRIORITY:
            if name in self.reviewers and name not in exclude:
                return name, self.reviewers[name]
        return None, None

    @staticmethod
    def _cluster_member_hash(members: list) -> str:
        """Deterministic identity for a cluster from WHO raised WHAT, not the AI-written
        summary sentence (which reliably reworks itself between rounds). Same (model,
        description) pairs -> same hash regardless of clustering-call phrasing drift."""
        key = sorted(f"{m['model']}::{m['issue'].get('description', '')}" for m in members)
        return hashlib.sha256("|".join(key).encode()).hexdigest()[:12]

    async def cluster_findings(self, reviews: dict, clusterer_name: str = None, exclude_from_clustering: set = None,
                                prior_clusters: list = None) -> dict:
        """Group findings by MEANING (not the old 50-char text-prefix hack) so a debate round
        can address 'point 7' knowing every seat that raised something equivalent to it is
        actually in the same bucket. `exclude_from_clustering` is available for callers that
        have a genuinely uninvolved seat to prefer (e.g. arbiter mode passing the arbiter as
        `clusterer_name` directly makes this moot); with only the 3-seat debate minimum
        there's no seat outside the debate to exclude to, so all_to_all mode doesn't pass one.

        Cluster IDs stay stable across debate rounds two ways: primarily a content hash of
        the member set (free, deterministic, survives the AI rewriting its summary sentence
        every round); for a cluster whose membership genuinely changed (a finding was
        reworded enough to hash differently, or a member was added/dropped), `prior_clusters`
        is given to the clustering call so it can explicitly say "this is the same cluster as
        <old_id>" and that ID is reused instead of minting a new one that would silently break
        prior-position lookups."""
        clusterer_key, clusterer = self._pick_seat(clusterer_name, exclude=exclude_from_clustering)
        if not clusterer:
            return {"error": "No AI available for clustering"}

        findings_text = ""
        finding_index = 0
        index_map = {}
        for model, review in reviews.items():
            if "error" in review:
                continue
            for issue in review.get("issues", []):
                finding_index += 1
                index_map[finding_index] = (model, issue)
                findings_text += (
                    f"\n#{finding_index} [{model}] severity={issue.get('severity', '?')} "
                    f"line={issue.get('line', '?')}: {issue.get('description', '')}"
                )

        if finding_index == 0:
            return {"clusters": []}

        prior_text = ""
        if prior_clusters:
            prior_lines = [f"\n- {c['cluster_id']}: {c['summary']}" for c in prior_clusters]
            prior_text = (
                "\n\nThese clusters existed in the previous debate round:" + "".join(prior_lines) +
                "\n\nIf a new cluster you form is substantially the same underlying issue as one of "
                "these (even if the exact finding wording changed), include "
                '"same_as_prior": "<that prior cluster_id>" on it so it can be tracked as a '
                "continuation rather than a new cluster."
            )

        cluster_prompt = f"""You are grouping code-review findings from multiple independent AI
reviewers by MEANING, not wording. Two findings are the same cluster only if they describe the
same underlying defect (even if described in different words, different severity labels, or a
slightly different line number). Do not merge findings that are related but distinct (e.g. "SQL
injection in query A" and "SQL injection in query B" are different clusters if A and B are
different call sites).

Findings (numbered, tagged with which reviewer raised them):
{findings_text}{prior_text}

Respond with ONLY this JSON:
{{
  "clusters": [
    {{"finding_numbers": [1, 4, 7], "summary": "one sentence describing the shared underlying issue", "same_as_prior": null}}
  ]
}}

Every finding number from 1 to {finding_index} must appear in exactly one cluster, including
findings no other reviewer raised (a cluster can have just one finding_number). Omit
"same_as_prior" or set it to null for a genuinely new cluster."""

        try:
            # See synthesize_reviews for why mode="fix" is required for CLI transports here:
            # the clustering JSON shape ({"clusters": [...]}) isn't the review schema, so
            # without it the real answer gets wrapped inside the forced schema's "summary"
            # field instead of returned directly.
            if HAS_CLI_TRANSPORT and isinstance(clusterer, CliReviewer):
                response, usage = await clusterer._call_api(cluster_prompt, mode="fix")
            else:
                response, usage = await clusterer._call_api(cluster_prompt)
            parsed = self._extract_wrapped_json(response, required_key="clusters")
            if parsed is None:
                return {"error": "Failed to parse clustering response", "raw": response[:500]}
        except Exception as e:
            return {"error": f"Clustering failed: {describe_exception(e)}"}

        prior_by_id = {c["cluster_id"]: c for c in (prior_clusters or [])}
        prior_hash_to_id = {self._cluster_member_hash(c["members"]): c["cluster_id"] for c in (prior_clusters or [])}

        clusters = []
        for c in parsed.get("clusters", []):
            members = []
            for n in c.get("finding_numbers", []):
                if n in index_map:
                    model, issue = index_map[n]
                    members.append({"model": model, "issue": issue})
            if not members:
                continue

            member_hash = self._cluster_member_hash(members)
            same_as_prior = c.get("same_as_prior")
            if member_hash in prior_hash_to_id:
                cluster_id = prior_hash_to_id[member_hash]
            elif same_as_prior and same_as_prior in prior_by_id:
                cluster_id = same_as_prior
            else:
                cluster_id = member_hash

            clusters.append({
                "cluster_id": cluster_id,
                "summary": c.get("summary", ""),
                "members": members,
            })

        return {"clusters": clusters, "clustered_by": clusterer_key, "usage": {clusterer_key: usage}}

    @staticmethod
    def _format_clusters_for_debate(clusters: list, prior_positions: dict = None) -> str:
        """Renders the cluster list (+ any prior round's positions on each) as prompt text."""
        prior_positions = prior_positions or {}
        lines = []
        for c in clusters:
            lines.append(f"\n### Cluster {c['cluster_id']}: {c['summary']}")
            for m in c["members"]:
                issue = m["issue"]
                lines.append(f"  - [{m['model']}] severity={issue.get('severity', '?')} line={issue.get('line', '?')}: {issue.get('description', '')}")
            positions = prior_positions.get(c["cluster_id"])
            if positions:
                lines.append("  Prior positions:")
                for model, pos in positions.items():
                    lines.append(f"    - {model}: {pos.get('stance', '?')} - {pos.get('reasoning', '')}")
        return "\n".join(lines)

    async def _gather_debate_position(self, model_name: str, reviewer, clusters: list, prior_positions: dict, file_path: str, code_content: str) -> tuple:
        """One seat's position on every cluster for this round: agree, dispute, or refine,
        with reasoning. All debating seats see the SAME cluster snapshot (including any prior
        round's positions) and answer independently and in parallel within the round - a
        re-convene is what lets a seat react to what others said last round, not mid-round."""
        code_preview = code_content[:3000] + "\n...(truncated)" if len(code_content) > 3000 else code_content
        clusters_text = self._format_clusters_for_debate(clusters, prior_positions)

        prompt = f"""You are {model_name}, one of several independent reviewers debating code
review findings on {Path(file_path).name}. State what's true, not what's pleasant: concede a
point if another reviewer is right and you were wrong, or push back with specific reasoning if
you disagree - do not agree just to converge, and do not hold a position for the sake of having
one.

## Code Preview
```
{code_preview}
```

## Clusters to take a position on
{clusters_text}

For EACH cluster, take a position:
- "agree": the finding is real as described, at the stated severity
- "dispute": you disagree the finding is real, or disagree with its severity - say why
- "refine": the finding is real but needs a more accurate description, severity, or fix

Respond with ONLY this JSON:
{{
  "positions": {{
    "<cluster_id>": {{"stance": "agree|dispute|refine", "reasoning": "one or two sentences", "suggested_severity": "CRITICAL|HIGH|MEDIUM|LOW|INFO", "suggested_fix": "concrete fix if you have one, else empty string"}}
  }}
}}
Every cluster_id listed above must have an entry."""

        try:
            if HAS_CLI_TRANSPORT and isinstance(reviewer, CliReviewer):
                response, usage = await reviewer._call_api(prompt, mode="fix")
            else:
                response, usage = await reviewer._call_api(prompt)
            parsed = self._extract_wrapped_json(response, required_key="positions")
            if parsed is None:
                return (model_name, {"error": "Failed to parse debate position", "raw": response[:300]})
            positions = parsed.get("positions", {})
            positions["_usage"] = usage
            return (model_name, positions)
        except Exception as e:
            return (model_name, {"error": describe_exception(e)})

    @staticmethod
    def _compute_consensus_pct(clusters: list, positions_by_model: dict, ratified_clusters: list = None) -> float:
        """% of clusters where every model that took a position on it agrees: all "agree",
        or all "refine" with the same suggested_severity (a refine that only sharpens wording
        without changing severity is still substantive agreement; a real severity disagreement
        is not). Arbiter-mode's directly-ratified clusters (already agreed pre-debate, so never
        sent to debating seats) count as agreed without needing a position lookup."""
        if not clusters:
            return 100.0
        ratified_ids = {c["cluster_id"] for c in (ratified_clusters or [])}
        agreed = len(ratified_ids)
        for c in clusters:
            cluster_id = c["cluster_id"]
            if cluster_id in ratified_ids:
                continue
            stances = []
            severities = set()
            for model, positions in positions_by_model.items():
                if "error" in positions:
                    continue
                pos = positions.get(cluster_id)
                if not pos:
                    continue
                stances.append(pos.get("stance"))
                severities.add(pos.get("suggested_severity") or next(
                    (m["issue"].get("severity") for m in c["members"] if m["model"] == model), None
                ))
            if stances and all(s in ("agree", "refine") for s in stances) and len(severities) <= 1:
                agreed += 1
        return round(100.0 * agreed / len(clusters), 1)

    async def run_debate_round(self, session_id: str, mode: str = None, arbiter_name: str = None) -> dict:
        """Runs one debate round for a scoped-review session: cluster findings (or reuse the
        latest clustering if positions already exist and clusters haven't changed), gather
        each debating seat's position, compute consensus %, persist.

        mode: 'all_to_all' (every enabled seat debates every cluster) or 'arbiter' (one seat
        is excluded from debating and instead rules on disputes). Auto-selected from seat count
        if not given: 3 seats -> all_to_all, 4+ seats -> arbiter (arbiter_name required then).
        """
        scoped_rounds = self.db.get_scoped_session(session_id)
        if not scoped_rounds:
            return {"error": f"No scoped review session found: {session_id}"}

        file_path = scoped_rounds[0]["file_path"]
        path = Path(file_path)
        if not path.exists():
            return {"error": f"File not found: {file_path}"}
        code_content = path.read_text(encoding="utf-8", errors="ignore")

        # Merge all rounds' reviews (round 0 + any follow-ups) into one findings set to debate.
        merged_reviews: dict = {}
        for r in scoped_rounds:
            if r["role"] != "council":
                continue
            for model, review in r["content"].get("reviews", {}).items():
                merged_reviews[model] = review  # later rounds supersede earlier ones per model

        enabled_seats = list(self.reviewers.keys())
        if len(enabled_seats) < 3:
            return {"error": f"Debate requires at least 3 enabled seats (have {len(enabled_seats)}): review findings independently instead"}

        if not mode:
            mode = "arbiter" if len(enabled_seats) >= 4 else "all_to_all"
        if mode == "arbiter" and not arbiter_name:
            return {"error": "Arbiter mode requires --arbiter (which enabled seat should NOT debate and instead rule on disputes)"}
        if mode == "arbiter" and arbiter_name not in self.reviewers:
            return {"error": f"Arbiter '{arbiter_name}' is not an enabled seat"}

        debating_seats = [s for s in enabled_seats if s != arbiter_name] if mode == "arbiter" else enabled_seats
        # In all_to_all mode there is no seat outside the debate to cluster unbiased - with
        # the 3-seat minimum, every enabled seat is a debate participant. Clustering there is
        # necessarily done by one of the debating seats (picked deterministically via seat
        # priority), same as it having to independently form its own debate position anyway.
        # Only arbiter mode has a genuinely uninvolved party available.
        clusterer_override = arbiter_name if mode == "arbiter" else None

        prior_round = self.db.get_latest_debate_round(session_id)
        prior_clusters = prior_round["clusters"] if prior_round else None

        print("[DEBATE] Clustering findings...", file=sys.stderr, flush=True)
        cluster_result = await self.cluster_findings(merged_reviews, clusterer_name=clusterer_override, prior_clusters=prior_clusters)
        if "error" in cluster_result:
            return cluster_result
        clusters = cluster_result["clusters"]

        # Some seats (self-hosted Ollama in particular) don't report usage at all - _call_api
        # returns None rather than a fabricated 0 for those, so accumulation must not assume
        # every call contributes a real number, and the total is marked partial rather than
        # silently understating it as a confirmed small number.
        def _add_usage(seat: str, usage: dict):
            bucket = token_usage.setdefault(seat, {"input_tokens": 0, "output_tokens": 0, "partial": False})
            if usage.get("input_tokens") is None or usage.get("output_tokens") is None:
                bucket["partial"] = True
                return
            bucket["input_tokens"] += usage["input_tokens"]
            bucket["output_tokens"] += usage["output_tokens"]

        token_usage: dict = {}
        for seat, usage in cluster_result.get("usage", {}).items():
            _add_usage(seat, usage)

        prior_positions = prior_round["positions"] if prior_round else {}
        debate_round_num = (prior_round["debate_round_num"] + 1) if prior_round else 1

        def _accumulate_seat_usage(positions_by_model_dict: dict):
            for seat, positions in positions_by_model_dict.items():
                usage = positions.get("_usage") if isinstance(positions, dict) else None
                if usage:
                    _add_usage(seat, usage)

        if mode == "all_to_all":
            print(f"[DEBATE] {len(clusters)} cluster(s) - gathering positions from {', '.join(debating_seats)}...", file=sys.stderr, flush=True)
            tasks = [
                self._gather_debate_position(seat, self.reviewers[seat], clusters, prior_positions, file_path, code_content)
                for seat in debating_seats
            ]
            completed = await asyncio.gather(*tasks)
            positions_by_model = dict(completed)
            _accumulate_seat_usage(positions_by_model)
            ratified_clusters: list = []
        else:
            # Arbiter mode's cost saving: a cluster with 2+ members already agreeing on
            # severity needs no debate (multiple seats independently found the same thing at
            # the same severity - that's already agreement). Only clusters with exactly one
            # member (unconfirmed) or with disagreeing severities go back to the debating
            # seats; the rest the arbiter ratifies directly at zero extra seat calls.
            contested = [c for c in clusters if _cluster_needs_debate(c)]
            ratified_clusters = [c for c in clusters if not _cluster_needs_debate(c)]

            if contested:
                print(f"[DEBATE] {len(contested)} contested cluster(s) (of {len(clusters)}) - gathering positions from {', '.join(debating_seats)}...", file=sys.stderr, flush=True)
                tasks = [
                    self._gather_debate_position(seat, self.reviewers[seat], contested, prior_positions, file_path, code_content)
                    for seat in debating_seats
                ]
                completed = await asyncio.gather(*tasks)
                positions_by_model = dict(completed)
                _accumulate_seat_usage(positions_by_model)
            else:
                print(f"[DEBATE] All {len(clusters)} cluster(s) already agree - no debate needed, arbiter ratifying...", file=sys.stderr, flush=True)
                positions_by_model = {}

            print(f"[DEBATE] Arbiter ({arbiter_name}) ruling on disputes...", file=sys.stderr, flush=True)
            arbiter_ruling = await self._arbiter_rule_on_debate(arbiter_name, clusters, positions_by_model, ratified_clusters, file_path, code_content)
            if "error" not in arbiter_ruling:
                positions_by_model["_arbiter_ruling"] = arbiter_ruling.get("rulings", {})
                if "usage" in arbiter_ruling:
                    _add_usage(arbiter_name, arbiter_ruling["usage"])

        consensus_pct = self._compute_consensus_pct(clusters, {k: v for k, v in positions_by_model.items() if k != "_arbiter_ruling"}, ratified_clusters)
        print(f"[DEBATE] Done - consensus {consensus_pct}%", file=sys.stderr, flush=True)

        self.db.add_debate_round(session_id, debate_round_num, mode, arbiter_name, clusters, positions_by_model, consensus_pct, token_usage)

        return {
            "session_id": session_id,
            "debate_round_num": debate_round_num,
            "mode": mode,
            "arbiter": arbiter_name,
            "clusters": clusters,
            "positions": positions_by_model,
            "consensus_pct": consensus_pct,
        }

    async def _arbiter_rule_on_debate(self, arbiter_name: str, clusters: list, positions_by_model: dict,
                                       ratified_clusters: list, file_path: str, code_content: str) -> dict:
        """Arbiter rules on each cluster. Ratified clusters (already agreed pre-debate) get a
        mechanical ruling with no extra call; only genuinely contested clusters cost an
        arbiter prompt - this is the other half of arbiter mode's cost saving alongside
        skipping ratified clusters in the debate step itself."""
        rulings: dict = {}
        for c in ratified_clusters:
            agreed_severity = next(iter({m["issue"].get("severity") for m in c["members"]}))
            rulings[c["cluster_id"]] = {
                "verdict": "valid",
                "final_severity": agreed_severity,
                "reasoning": f"{len(c['members'])} reviewers independently agreed on this finding at the same severity - ratified without arbiter review.",
                "fix": next((m["issue"].get("recommendation", "") for m in c["members"]), ""),
            }

        contested = [c for c in clusters if c["cluster_id"] not in {rc["cluster_id"] for rc in ratified_clusters}]
        if not contested:
            return {"rulings": rulings}

        arbiter = self.reviewers[arbiter_name]
        code_preview = code_content[:3000] + "\n...(truncated)" if len(code_content) > 3000 else code_content

        positions_text = ""
        for c in contested:
            positions_text += f"\n### Cluster {c['cluster_id']}: {c['summary']}"
            for model, positions in positions_by_model.items():
                if "error" in positions:
                    continue
                pos = positions.get(c["cluster_id"])
                if pos:
                    positions_text += f"\n  - {model}: {pos.get('stance', '?')} - {pos.get('reasoning', '')}"

        prompt = f"""You are the arbiter reviewing a debate among independent AI reviewers on
{Path(file_path).name}. You did not review the code yourself - your job is to rule on each
cluster based on the debating reviewers' positions and your own read of the code below. State
what's true, not what's pleasant: rule against the majority if the majority is wrong.

## Code Preview
```
{code_preview}
```

## Debate positions by cluster
{positions_text}

Respond with ONLY this JSON:
{{
  "rulings": {{
    "<cluster_id>": {{"verdict": "valid|invalid|needs_more_info", "final_severity": "CRITICAL|HIGH|MEDIUM|LOW|INFO", "reasoning": "your ruling and why", "fix": "concrete grounded fix"}}
  }}
}}
Every cluster_id must have a ruling."""

        try:
            if HAS_CLI_TRANSPORT and isinstance(arbiter, CliReviewer):
                response, usage = await arbiter._call_api(prompt, mode="fix")
            else:
                response, usage = await arbiter._call_api(prompt)
            parsed = self._extract_wrapped_json(response, required_key="rulings")
            if parsed is None:
                return {"error": "Failed to parse arbiter ruling", "raw": response[:300]}
            rulings.update(parsed.get("rulings", {}))
            return {"rulings": rulings, "usage": usage}
        except Exception as e:
            return {"error": describe_exception(e)}

    @staticmethod
    def _resolve_cluster_state(cluster: dict, positions_by_model: dict) -> dict:
        """Reduces one cluster's debate outcome to a single resolved state: an arbiter ruling
        wins outright; otherwise, full agreement across positions settles it; anything else
        (real, unresolved disagreement) is flagged as open rather than papered over."""
        cluster_id = cluster["cluster_id"]
        arbiter_ruling = positions_by_model.get("_arbiter_ruling", {}).get(cluster_id)
        if arbiter_ruling:
            return {
                "status": "ruled" if arbiter_ruling.get("verdict") != "needs_more_info" else "open",
                "verdict": arbiter_ruling.get("verdict"),
                "severity": arbiter_ruling.get("final_severity"),
                "reasoning": arbiter_ruling.get("reasoning", ""),
                "fix": arbiter_ruling.get("fix", ""),
            }

        stances, severities, reasonings, fixes = [], set(), [], []
        for model, positions in positions_by_model.items():
            if model == "_arbiter_ruling" or "error" in positions:
                continue
            pos = positions.get(cluster_id)
            if not pos:
                continue
            stances.append(pos.get("stance"))
            severities.add(pos.get("suggested_severity") or next(
                (m["issue"].get("severity") for m in cluster["members"] if m["model"] == model), None
            ))
            if pos.get("reasoning"):
                reasonings.append(f"{model}: {pos['reasoning']}")
            if pos.get("suggested_fix"):
                fixes.append(pos["suggested_fix"])

        if not stances:
            # No seat took a debate position on this cluster at all (shouldn't normally
            # happen outside arbiter-mode ratification, which is handled above).
            member_severities = {m["issue"].get("severity") for m in cluster["members"]}
            return {
                "status": "ratified" if len(member_severities) <= 1 else "open",
                "severity": next(iter(member_severities)) if len(member_severities) <= 1 else None,
                "reasoning": f"{len(cluster['members'])} reviewers independently raised this at the same severity, no debate needed.",
                "fix": next((m["issue"].get("recommendation", "") for m in cluster["members"]), ""),
            }

        if all(s in ("agree", "refine") for s in stances) and len(severities) <= 1:
            return {
                "status": "settled",
                "severity": next(iter(severities)) if severities else None,
                "reasoning": " / ".join(reasonings),
                "fix": fixes[0] if fixes else "",
            }

        return {
            "status": "open",
            "severity": None,
            "reasoning": " / ".join(reasonings),
            "fix": "",
        }

    async def consolidate_debate(self, session_id: str, consolidator_name: str = None, force: bool = False) -> dict:
        """Turns a debate's raw clusters+positions into the pruned, grounded final review: one
        settled finding per resolved cluster (later/ruled judgment only, never both sides of a
        settled dispute), a genuinely-open list for anything the debate did NOT resolve, and a
        grounded fix for every settled finding - the artifact the user asked for: 'stripped of
        any irrelevant pandering or over-engineering... a fully grounded solution... for every
        question, all based on best and most secure coding practices... hyper efficient.'

        Cached per (session, debate_round_num): this is meant to BE the final answer, and an
        LLM call is not deterministic - without caching, calling this twice against the same
        debate round could silently return two different "final" reviews. Pass force=True to
        deliberately re-roll (e.g. a bad first attempt)."""
        debate_round = self.db.get_latest_debate_round(session_id)
        if not debate_round:
            return {"error": f"No debate round found for session {session_id} - run `debate` first"}

        if not force:
            cached = self.db.get_cached_consolidation(session_id, debate_round["debate_round_num"])
            if cached:
                cached["cached"] = True
                return cached

        clusters = debate_round["clusters"]
        positions_by_model = debate_round["positions"]

        resolved = []
        open_items = []
        for c in clusters:
            state = self._resolve_cluster_state(c, positions_by_model)
            entry = {
                "cluster_id": c["cluster_id"],
                "summary": c["summary"],
                "raised_by": sorted({m["model"] for m in c["members"]}),
                **state,
            }
            (open_items if state["status"] == "open" else resolved).append(entry)

        scoped_rounds = self.db.get_scoped_session(session_id)
        file_path = scoped_rounds[0]["file_path"] if scoped_rounds else None

        consolidator_key, consolidator = self._pick_seat(consolidator_name)
        if not consolidator:
            return {"error": "No AI available for consolidation"}

        print(f"[CONSOLIDATE] Building final review with {consolidator_key} ({len(resolved)} resolved, {len(open_items)} open)...", file=sys.stderr, flush=True)

        resolved_text = "\n".join(
            f"- [{e.get('severity', '?')}] {e['summary']} (raised by {', '.join(e['raised_by'])}, status={e['status']})\n"
            f"  Reasoning: {e['reasoning']}\n  Fix: {e['fix'] or '(none suggested)'}"
            for e in resolved
        ) or "(none)"
        open_text = "\n".join(
            f"- {e['summary']} (raised by {', '.join(e['raised_by'])})\n  Unresolved because: {e['reasoning']}"
            for e in open_items
        ) or "(none)"

        prompt = f"""You are consolidating a code review debate into ONE final, pruned review.
State what's true, not what's pleasant: strip padding, hedging, and anything one reviewer only
raised for the sake of appearing thorough. Every settled finding needs ONE concrete, grounded
fix using best and most secure coding practice - not a vague suggestion. Keep it efficient: no
restating the same point twice, no filler transitions.

## Settled findings from the debate (already resolved, do not re-litigate)
{resolved_text}

## Still-open items (the debate did NOT resolve these - do not silently pick a side)
{open_text}

Respond with ONLY this JSON:
{{
  "summary": "2-3 sentence overall assessment, no padding",
  "findings": [
    {{"severity": "CRITICAL|HIGH|MEDIUM|LOW|INFO", "description": "...", "fix": "concrete grounded fix"}}
  ],
  "open_questions": [
    {{"question": "what the user needs to decide or clarify", "why_unresolved": "..."}}
  ]
}}
Order findings by severity, most severe first. Do not include a finding or open question that
isn't backed by the debate material above."""

        try:
            if HAS_CLI_TRANSPORT and isinstance(consolidator, CliReviewer):
                response, usage = await consolidator._call_api(prompt, mode="fix")
            else:
                response, usage = await consolidator._call_api(prompt)
            parsed = self._extract_wrapped_json(response, required_key="findings")
            if parsed is None:
                return {"error": "Failed to parse consolidation response", "raw": response[:500]}
        except Exception as e:
            return {"error": f"Consolidation failed: {describe_exception(e)}"}

        print(f"[CONSOLIDATE] Done - {len(parsed.get('findings', []))} finding(s), {len(parsed.get('open_questions', []))} open question(s)", file=sys.stderr, flush=True)

        result = {
            "session_id": session_id,
            "file_path": file_path,
            "consolidated_by": consolidator_key,
            "debate_round_num": debate_round["debate_round_num"],
            "summary": parsed.get("summary", ""),
            "findings": parsed.get("findings", []),
            "open_questions": parsed.get("open_questions", []),
            "usage": {consolidator_key: usage},
        }
        self.db.save_consolidation(session_id, debate_round["debate_round_num"], consolidator_key, result)
        result["cached"] = False
        return result

    # API seat -> CLI seat, for providers where the names don't just differ by a "-cli" suffix
    _SEAT_COUNTERPART = {"gpt-4": "gpt-cli", "gpt-cli": "gpt-4"}

    async def fix_code(self, file_path: str, fixer_name: str, issues: list = None) -> str:
        """AI-powered code fixing based on review findings"""
        # Same-provider fallback: the picker offers "claude"/"gpt-4"/"grok" (API seats),
        # but a CLI-only setup only has "claude-cli"/"gpt-cli"/"grok-cli" enabled (and GPT's
        # CLI seat is "gpt-cli", not "gpt-4-cli"). Prefer the exact seat requested, then its
        # CLI/API counterpart, before giving up.
        counterpart = self._SEAT_COUNTERPART.get(fixer_name)
        if fixer_name in self.reviewers:
            resolved_name = fixer_name
        elif counterpart and counterpart in self.reviewers:
            resolved_name = counterpart
        elif f"{fixer_name}-cli" in self.reviewers:
            resolved_name = f"{fixer_name}-cli"
        elif fixer_name.endswith("-cli") and fixer_name[:-len("-cli")] in self.reviewers:
            resolved_name = fixer_name[:-len("-cli")]
        else:
            raise ValueError(f"Fixer '{fixer_name}' not available")

        fixer_name = resolved_name
        fixer = self.reviewers[fixer_name]
        filename = Path(file_path).name

        # Read the original code
        code_content = Path(file_path).read_text(encoding="utf-8", errors="ignore")

        # Format issues if provided
        issues_text = ""
        if issues:
            for i, issue in enumerate(issues, 1):
                sev = issue.get("severity", "INFO")
                line = issue.get("line", "?")
                desc = issue.get("description", "")
                rec = issue.get("recommendation", "")
                issues_text += f"{i}. [{sev}] Line {line}: {desc}"
                if rec:
                    issues_text += f" - Recommendation: {rec}"
                issues_text += "\n"
        else:
            issues_text = "Review the code for bugs, security issues, and improvements."

        fix_prompt = f"""You are an expert code fixer. Your task is to fix the issues found in this code.

## File: {filename}

## Issues to Fix:
{issues_text}

## Original Code:
```
{code_content}
```

## Instructions:
1. Fix ALL the issues listed above
2. Maintain the original code style and formatting
3. Add brief comments only where the fix is non-obvious
4. Return ONLY the complete fixed code, no explanations
5. Do not add markdown code fences or language tags

Return the complete fixed file content:"""

        print(f"[*] Fixing code with {fixer_name.upper()}...", file=sys.stderr)

        try:
            if HAS_CLI_TRANSPORT and isinstance(fixer, CliReviewer):
                # CLI transports default to the review JSON-schema pipeline; fix needs
                # free-text code back, not a JSON-constrained response.
                fixed_code, _usage = await fixer._call_api(fix_prompt, mode="fix")
            else:
                fixed_code, _usage = await fixer._call_api(fix_prompt)

            # Clean up the response - remove any markdown code fences
            fixed_code = fixed_code.strip()
            if fixed_code.startswith("```"):
                lines = fixed_code.split("\n")
                # Remove first line (```language) and last line (```)
                if lines[-1].strip() == "```":
                    lines = lines[1:-1]
                else:
                    lines = lines[1:]
                fixed_code = "\n".join(lines)

            return fixed_code
        except Exception as e:
            raise Exception(f"Fix failed: {describe_exception(e)}")

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


def generate_html_report(file_path: str, reviews: dict, output_path: str = None, power_mode: bool = False, synthesis: dict = None) -> str:
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
        .header-logo img {{ height: 86px; width: auto; border-radius: 8px; }}
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
        .score-card.ollama {{ border-top: 4px solid #ff6b35; }}
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
        .usage-model.ollama {{ color: #ff6b35; }}
        .usage-tokens {{ font-family: 'JetBrains Mono', monospace; font-size: 0.8rem; color: var(--text-secondary); }}
        .usage-cost {{ font-size: 0.85rem; font-weight: 600; color: var(--emerald-400); }}
        .usage-total {{ background: linear-gradient(135deg, var(--indigo-500), var(--purple-500)); border-radius: 8px; padding: 0.75rem; }}
        .usage-total .usage-model {{ color: white; }}
        .usage-total .usage-tokens {{ color: rgba(255,255,255,0.8); }}
        .usage-total .usage-cost {{ color: white; font-size: 1rem; }}
        .council-verdict {{
            background: linear-gradient(135deg, rgba(99, 102, 241, 0.15), rgba(168, 85, 247, 0.15));
            border: 2px solid var(--indigo-500); border-radius: 16px;
            padding: 2rem; margin-bottom: 2rem; position: relative; overflow: hidden;
        }}
        .council-verdict::before {{
            content: ''; position: absolute; top: 0; left: 0; right: 0; height: 4px;
            background: linear-gradient(90deg, var(--indigo-500), var(--purple-500), var(--cyan-500));
        }}
        .council-verdict h2 {{
            font-size: 1.5rem; font-weight: 700; margin-bottom: 1.5rem;
            background: linear-gradient(135deg, var(--indigo-400), var(--purple-500));
            -webkit-background-clip: text; -webkit-text-fill-color: transparent;
            display: flex; align-items: center; gap: 0.75rem;
        }}
        .verdict-score {{
            display: flex; align-items: center; justify-content: center; gap: 2rem;
            background: var(--zinc-900); border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem;
        }}
        .verdict-score-number {{
            font-size: 4rem; font-weight: 800;
            background: linear-gradient(135deg, var(--emerald-400), var(--cyan-400));
            -webkit-background-clip: text; -webkit-text-fill-color: transparent;
        }}
        .verdict-score-label {{ color: var(--zinc-400); font-size: 1rem; font-weight: 500; }}
        .verdict-summary {{ color: var(--text-secondary); line-height: 1.8; margin-bottom: 1.5rem; font-size: 1rem; }}
        .verdict-section {{ margin-bottom: 1.5rem; }}
        .verdict-section h3 {{ font-size: 1rem; font-weight: 600; color: var(--indigo-400); margin-bottom: 0.75rem; display: flex; align-items: center; gap: 0.5rem; }}
        .verdict-list {{ list-style: none; padding: 0; }}
        .verdict-list li {{
            background: var(--zinc-900); border-radius: 8px; padding: 0.75rem 1rem;
            margin-bottom: 0.5rem; color: var(--text-secondary); font-size: 0.9rem;
            border-left: 3px solid var(--zinc-600);
        }}
        .verdict-list li.priority {{ border-left-color: var(--rose-500); }}
        .verdict-list li.disputed {{ border-left-color: var(--amber-500); }}
        .verdict-list li.false-positive {{ border-left-color: var(--emerald-400); }}
        .synthesizer {{ font-size: 0.8rem; color: var(--zinc-500); text-align: right; margin-top: 1rem; }}
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
            model_class = "gpt" if "gpt" in model.lower() else ("grok" if "grok" in model.lower() else ("claude" if "claude" in model.lower() else ("ollama" if "ollama" in model.lower() else "gemini")))
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
            model_class = "gpt" if "gpt" in model.lower() else ("grok" if "grok" in model.lower() else ("claude" if "claude" in model.lower() else ("ollama" if "ollama" in model.lower() else "gemini")))
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

    # Add Council Verdict section if synthesis is available
    if synthesis and not synthesis.get("error"):
        final_score = synthesis.get("final_score", "?")
        verdict = synthesis.get("council_verdict", "")
        priority_ranking = synthesis.get("priority_ranking", [])
        disputed_findings = synthesis.get("disputed_findings", [])
        false_positives = synthesis.get("false_positives", [])
        synthesizer = synthesis.get("synthesized_by", "AI")

        html += f'''
        <div class="council-verdict">
            <h2>⚖️ Council Verdict</h2>
            <div class="verdict-score">
                <div>
                    <div class="verdict-score-number">{final_score}/10</div>
                    <div class="verdict-score-label">Final Score</div>
                </div>
            </div>
            <div class="verdict-summary">{verdict}</div>
'''

        if priority_ranking:
            html += '''
            <div class="verdict-section">
                <h3>🎯 Priority Ranking</h3>
                <ol class="verdict-list" style="list-style: decimal; padding-left: 1.5rem;">
'''
            for item in priority_ranking[:5]:  # Top 5 priorities
                # Handle both string items and dict items with rank/issue keys
                if isinstance(item, dict):
                    issue_text = item.get("issue", str(item))
                else:
                    issue_text = str(item)
                html += f'                    <li class="priority">{issue_text}</li>\n'
            html += '''                </ol>
            </div>
'''

        if disputed_findings:
            html += '''
            <div class="verdict-section">
                <h3>⚠️ Disputed Findings</h3>
                <ul class="verdict-list">
'''
            for item in disputed_findings:
                if isinstance(item, dict):
                    item_text = item.get("description", item.get("issue", str(item)))
                else:
                    item_text = str(item)
                html += f'                    <li class="disputed">{item_text}</li>\n'
            html += '''                </ul>
            </div>
'''

        if false_positives:
            html += '''
            <div class="verdict-section">
                <h3>✅ Likely False Positives</h3>
                <ul class="verdict-list">
'''
            for item in false_positives:
                if isinstance(item, dict):
                    item_text = item.get("description", item.get("issue", str(item)))
                else:
                    item_text = str(item)
                html += f'                    <li class="false-positive">{item_text}</li>\n'
            html += '''                </ul>
            </div>
'''

        html += f'''
            <div class="synthesizer">Synthesized by {synthesizer.upper()}</div>
        </div>
'''

    # Add per-model sections
    for model, review in reviews.items():
        if not isinstance(review, dict):
            continue
        model_class = "gpt" if "gpt" in model.lower() else ("grok" if "grok" in model.lower() else ("claude" if "claude" in model.lower() else ("ollama" if "ollama" in model.lower() else "gemini")))
        emoji = "🧠" if "gpt" in model.lower() else ("⚡" if "grok" in model.lower() else ("🔮" if "claude" in model.lower() else ("🦙" if "ollama" in model.lower() else "💎")))

        if review.get("error"):
            # The score grid only shows "ERR/10" - surface the real failure text here too.
            html += f'''
        <div class="section">
            <h2>{emoji} {model.upper()} Review</h2>
            <div class="issue critical">
                <div class="issue-header">
                    <span class="badge critical">ERROR</span>
                </div>
                <div class="issue-desc">{review["error"]}</div>
            </div>
        </div>
'''
            continue

        issues = review.get("issues", [])
        summary = review.get("summary", "")

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
    parser.add_argument("--db", help="Path to reviews database (default: script directory)")
    # Global model flags - work for all commands
    parser.add_argument("--ollama", action="store_true", help="Include Ollama (self-hosted) in review")
    parser.add_argument("--ollama-url", help="Ollama server URL")
    parser.add_argument("--ollama-model", help="Ollama model to use")
    
    parser.add_argument("--transport-claude", choices=["api", "cli", "auto"], default=None,
                        help="Claude auth transport: api key, claude CLI, or auto")
    parser.add_argument("--transport-gpt", choices=["api", "cli", "auto"], default=None,
                        help="GPT auth transport: api key, codex CLI, or auto")
    parser.add_argument("--transport-grok", choices=["api", "cli", "auto"], default=None,
                        help="Grok auth transport: api key, grok CLI, or auto (legacy)")
    parser.add_argument("--claude-cli", action="store_true",
                        help="Add Claude CLI seat (subscription) alongside any Claude API seat")
    parser.add_argument("--gpt-cli", action="store_true",
                        help="Add Codex/GPT CLI seat (subscription) alongside any GPT API seat")
    parser.add_argument("--grok-cli", action="store_true",
                        help="Add Grok CLI seat (subscription) alongside any Grok API seat")
    parser.add_argument("--claude-cli-model", default=None, help="Model for Claude CLI seat (subscription)")
    parser.add_argument("--gpt-cli-model", default=None, help="Model for Codex/GPT CLI seat (subscription)")
    parser.add_argument("--grok-cli-model", default=None, help="Model for Grok CLI seat (subscription)")

    subparsers = parser.add_subparsers(dest="command", help="Commands")

    # Status command
    subparsers.add_parser("status", help="Show current status")

    # Review command
    review_parser = subparsers.add_parser("review", help="Review a file")
    review_parser.add_argument("file", help="File to review")
    review_parser.add_argument("--force", "-f", action="store_true", help="Force re-review")
    review_parser.add_argument("--gemini", "-g", action="store_true", help="Include Gemini in review")
    review_parser.add_argument("--no-gpt", action="store_true", help="Disable GPT-4 reviewer")
    review_parser.add_argument("--no-claude", action="store_true", help="Disable Claude reviewer")
    review_parser.add_argument("--no-grok", action="store_true", help="Disable Grok reviewer")
    review_parser.add_argument("--power", "-p", action="store_true", help="Use premium models (higher cost, better results)")
    review_parser.add_argument("--html", action="store_true", help="Generate HTML report")
    review_parser.add_argument("--output", "-o", help="Output path for HTML report")
    review_parser.add_argument("--issues", action="store_true", help="Create GitHub issues for consensus findings")
    review_parser.add_argument("--issues-all", action="store_true", help="Create GitHub issues for ALL findings")
    review_parser.add_argument("--repo", help="Target repo for issues (default: current git repo)")
    review_parser.add_argument("--synthesize", "-s", action="store_true", help="AI-powered synthesis of all reviews (Council Verdict)")
    review_parser.add_argument("--synthesizer", choices=['claude', 'claude-cli', 'gpt-4', 'gpt-cli', 'gemini', 'grok', 'grok-cli', 'ollama'], help="Specific AI to use for synthesis (default: auto)")

    # Scoped review command (round 0 of a "Review with Scope" session)
    scoped_review_parser = subparsers.add_parser("scoped-review", help="Start a scoped review session with a custom focus")
    scoped_review_parser.add_argument("file", help="File to review")
    scoped_review_parser.add_argument("--scope", required=True, help="What the council should focus on (layer 3)")
    scoped_review_parser.add_argument("--power", "-p", action="store_true", help="Use premium models (higher cost, better results)")
    scoped_review_parser.add_argument("--gemini", "-g", action="store_true", help="Include Gemini in review")
    scoped_review_parser.add_argument("--no-gpt", action="store_true", help="Disable GPT-4 reviewer")
    scoped_review_parser.add_argument("--no-claude", action="store_true", help="Disable Claude reviewer")
    scoped_review_parser.add_argument("--no-grok", action="store_true", help="Disable Grok reviewer")
    scoped_review_parser.add_argument("--html", action="store_true", help="Generate HTML report")
    scoped_review_parser.add_argument("--output", "-o", help="Output path for HTML report")
    scoped_review_parser.add_argument("--json-output", help="Write the JSON result to this file (stdout still carries live progress, like `review` does)")

    # Scoped follow-up command (round 1+ of a "Review with Scope" session). Same model-selection
    # flags as scoped-review: AICouncil is constructed fresh per process invocation, from
    # whatever flags this specific command line carries - it has no memory of round 0's seat
    # selection unless the caller passes the same flags again on every round.
    scoped_followup_parser = subparsers.add_parser("scoped-followup", help="Ask the council a follow-up in an existing scoped review session")
    scoped_followup_parser.add_argument("--session", required=True, help="Session ID from scoped-review")
    scoped_followup_parser.add_argument("--question", required=True, help="Follow-up question for the council")
    scoped_followup_parser.add_argument("--power", "-p", action="store_true", help="Use premium models (higher cost, better results)")
    scoped_followup_parser.add_argument("--gemini", "-g", action="store_true", help="Include Gemini in review")
    scoped_followup_parser.add_argument("--no-gpt", action="store_true", help="Disable GPT-4 reviewer")
    scoped_followup_parser.add_argument("--no-claude", action="store_true", help="Disable Claude reviewer")
    scoped_followup_parser.add_argument("--no-grok", action="store_true", help="Disable Grok reviewer")
    scoped_followup_parser.add_argument("--html", action="store_true", help="Generate HTML report")
    scoped_followup_parser.add_argument("--output", "-o", help="Output path for HTML report")
    scoped_followup_parser.add_argument("--json-output", help="Write the JSON result to this file (stdout still carries live progress, like `review` does)")

    # Scoped finalize command (write the session up as a review doc). Same reasoning as
    # scoped-followup above - needs the seat flags so the writer resolution (self.reviewers)
    # reflects the same seats the session actually ran with, not whatever defaults apply
    # to a bare invocation with no seat flags at all.
    scoped_finalize_parser = subparsers.add_parser("scoped-finalize", help="Have a nominated AI write up a scoped review session as a review document")
    scoped_finalize_parser.add_argument("--session", required=True, help="Session ID from scoped-review")
    scoped_finalize_parser.add_argument("--writer", choices=['claude', 'claude-cli', 'gpt-4', 'gpt-cli', 'gemini', 'grok', 'grok-cli', 'ollama'], help="AI to write the doc (default: auto/best available)")
    scoped_finalize_parser.add_argument("--output", "-o", help="Output path for the review doc (default: .ai-council/reports/scoped-review-<file>-<timestamp>.md)")
    scoped_finalize_parser.add_argument("--power", "-p", action="store_true", help="Use premium models (higher cost, better results)")
    scoped_finalize_parser.add_argument("--gemini", "-g", action="store_true", help="Include Gemini in review")
    scoped_finalize_parser.add_argument("--no-gpt", action="store_true", help="Disable GPT-4 reviewer")
    scoped_finalize_parser.add_argument("--no-claude", action="store_true", help="Disable Claude reviewer")
    scoped_finalize_parser.add_argument("--no-grok", action="store_true", help="Disable Grok reviewer")
    scoped_finalize_parser.add_argument("--json", action="store_true", help="Print a single JSON result object instead of human-readable output")

    # Debate command (cross-seat exchange over a scoped review session's clustered findings)
    debate_parser = subparsers.add_parser("debate", help="Run one debate round over a scoped review session's findings")
    debate_parser.add_argument("--session", required=True, help="Session ID from scoped-review")
    debate_parser.add_argument("--mode", choices=["all_to_all", "arbiter"], help="Debate mode (default: auto from seat count - 3 seats = all_to_all, 4+ = arbiter)")
    debate_parser.add_argument("--arbiter", help="Seat that rules on disputes instead of debating (required for --mode arbiter or when auto-selecting arbiter mode with 4+ seats)")
    debate_parser.add_argument("--json", action="store_true", help="Print a single JSON result object instead of human-readable output")

    # Consolidate command (pruned final review from the latest debate round)
    consolidate_parser = subparsers.add_parser("consolidate", help="Produce the pruned, grounded final review from a session's latest debate round")
    consolidate_parser.add_argument("--session", required=True, help="Session ID from scoped-review")
    consolidate_parser.add_argument("--consolidator", choices=['claude', 'claude-cli', 'gpt-4', 'gpt-cli', 'gemini', 'grok', 'grok-cli', 'ollama'], help="AI to write the consolidated review (default: auto/best available)")
    consolidate_parser.add_argument("--force", "-f", action="store_true", help="Re-run consolidation even if this debate round already has a cached result")
    consolidate_parser.add_argument("--json", action="store_true", help="Print a single JSON result object instead of human-readable output")

    # Fix command
    fix_parser = subparsers.add_parser("fix", help="Fix code based on review findings")
    fix_parser.add_argument("file", help="File to fix")
    fix_parser.add_argument("--fixer", choices=['claude', 'claude-cli', 'gpt-4', 'gpt-cli', 'gemini', 'grok', 'grok-cli', 'ollama'], required=True, help="AI to use for fixing")
    fix_parser.add_argument("--report", help="Path to HTML report with issues")

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
    enable_ollama = getattr(args, 'ollama', False)
    disable_gpt = getattr(args, 'no_gpt', False)
    disable_claude = getattr(args, 'no_claude', False)
    disable_grok = getattr(args, 'no_grok', False)
    power_mode = getattr(args, 'power', False)
    db_path = getattr(args, 'db', None)
    ollama_url = getattr(args, 'ollama_url', None)
    ollama_model = getattr(args, 'ollama_model', None)
    transports = {}
    if getattr(args, "transport_claude", None):
        transports["claude"] = args.transport_claude
    if getattr(args, "transport_gpt", None):
        transports["gpt-4"] = args.transport_gpt
    if getattr(args, "transport_grok", None):
        transports["grok"] = args.transport_grok

    # Optional CLI model overrides via flags -> env consumed by CliReviewer
    if getattr(args, "claude_cli_model", None):
        os.environ["AI_COUNCIL_CLI_MODEL_ANTHROPIC"] = args.claude_cli_model
    if getattr(args, "gpt_cli_model", None):
        os.environ["AI_COUNCIL_CLI_MODEL_OPENAI"] = args.gpt_cli_model
    if getattr(args, "grok_cli_model", None):
        os.environ["AI_COUNCIL_CLI_MODEL_XAI"] = args.grok_cli_model

    enable_claude_cli = bool(getattr(args, "claude_cli", False))
    enable_gpt_cli = bool(getattr(args, "gpt_cli", False))
    enable_grok_cli = bool(getattr(args, "grok_cli", False))
    # Legacy: --transport-X cli enables that CLI seat
    if transports.get("claude") == "cli":
        enable_claude_cli = True
    if transports.get("gpt-4") == "cli":
        enable_gpt_cli = True
    if transports.get("grok") == "cli":
        enable_grok_cli = True

    # In --json mode (scoped-* commands, consumed programmatically by the VS Code extension),
    # setup's informational prints ("[+] Claude reviewer enabled...") must not land on stdout -
    # they'd corrupt the single JSON line the caller expects. Redirect to stderr for construction.
    json_mode = bool(getattr(args, "json", False))
    _stdout_for_setup = sys.stderr if json_mode else sys.stdout
    _real_stdout = sys.stdout
    sys.stdout = _stdout_for_setup
    try:
        council = AICouncil(
            enable_gemini=enable_gemini,
            enable_gpt=not disable_gpt,
            enable_claude=not disable_claude,
            enable_grok=not disable_grok,
            enable_ollama=enable_ollama,
            enable_gpt_cli=enable_gpt_cli,
            enable_claude_cli=enable_claude_cli,
            enable_grok_cli=enable_grok_cli,
            ollama_url=ollama_url,
            ollama_model=ollama_model,
            power_mode=power_mode,
            db_path=db_path,
            transports=transports or None,
        )
    finally:
        sys.stdout = _real_stdout

    if args.command == "status":
        print("\n=== AI Council Status ===")
        print(f"Database: {council.config['db_path']}")
        # Show reviewers with model names
        reviewer_info = []
        for name, reviewer in council.reviewers.items():
            model = getattr(reviewer, 'model', '')
            if model and name == 'ollama':
                reviewer_info.append(f"{name} ({model})")
            else:
                reviewer_info.append(name)
        print(f"Reviewers: {', '.join(reviewer_info) or 'None configured'}")
        pending = council.db.get_pending(100)
        print(f"Pending reviews: {len(pending)}")

    elif args.command == "review":
        # Get actual model names being used
        mode = "power" if power_mode else "standard"
        model_names = MODEL_CONFIGS[mode]
        active_models = []
        for k, reviewer in council.reviewers.items():
            display = getattr(reviewer, "model", None) or model_names.get(k, k)
            active_models.append((k, display))

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

            total_models = len(result["reviews"])
            completed = 0
            for model, review in result["reviews"].items():
                completed += 1
                reviews_data[model] = review
                if "error" in review:
                    print(f"[!] {model.upper()} ERROR")
                    print(f"  [{model.upper()}] ERROR: {review['error'][:80]}")
                else:
                    issues = review.get("issues", [])
                    score = review.get('quality_score', '?')
                    # Output in format that VS Code extension can parse
                    print(f"[+] {model.upper()} Score: {score}/10 (0.0s) [{completed}/{total_models}]")
                    print(f"  [{model.upper()}] Score: {score}/10 | Issues: {len(issues)}")

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

        # Run synthesis if --synthesize flag is passed and we have 2+ successful models
        synthesis_result = None
        do_synthesize = getattr(args, 'synthesize', False)
        successful_reviews = {k: v for k, v in reviews_data.items() if "error" not in v}
        if do_synthesize and len(successful_reviews) >= 2:
            # Read file content for synthesis
            try:
                code_content = Path(args.file).read_text(encoding="utf-8", errors="ignore")
                preferred_synth = getattr(args, 'synthesizer', None)
                synthesis_result = asyncio.run(council.synthesize_reviews(args.file, code_content, successful_reviews, preferred_synth))

                if "error" not in synthesis_result:
                    print(f"\n{'='*60}")
                    print("  Council Verdict (Synthesized by " + synthesis_result.get("synthesized_by", "AI").upper() + ")")
                    print(f"{'='*60}")
                    print(f"\n  Final Score: {synthesis_result.get('final_score', '?')}/10")
                    print(f"  {synthesis_result.get('council_verdict', 'No verdict available.')}")

                    priority = synthesis_result.get('priority_ranking', [])
                    if priority:
                        print(f"\n  Priority Fixes:")
                        for item in priority[:3]:
                            print(f"    {item.get('rank', '?')}. {item.get('issue', '')[:50]}...")
                else:
                    print(f"\n[!] Synthesis failed: {synthesis_result.get('error', 'Unknown error')}")
            except Exception as e:
                print(f"\n[!] Synthesis error: {describe_exception(e)}")

        # Generate HTML report if --html flag is passed
        if getattr(args, 'html', False) and reviews_data:
            output_path = getattr(args, 'output', None)
            report_path = generate_html_report(args.file, reviews_data, output_path, power_mode, synthesis_result)
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

    elif args.command == "scoped-review":
        # Progress always prints live to stdout, exactly like `review` - JSON (when requested)
        # goes to a separate file so the VS Code extension can stream progress AND get
        # structured output, instead of one or the other.
        result = asyncio.run(council.review_file_scoped(args.file, args.scope, show_progress=True))
        result.pop("_tracker", None)

        if "error" in result:
            print(f"[!] {result['error']}", file=sys.stderr)
        else:
            print(f"\n{'='*60}")
            print(f"  Scoped Review Session: {result['session_id']}")
            print(f"{'='*60}")
            print_scoped_round_results(result)

            if getattr(args, 'html', False):
                report_path = generate_html_report(args.file, result["reviews"], getattr(args, 'output', None), power_mode)
                result["report_path"] = report_path
                print(f"\n[+] HTML report generated: {report_path}")

            print(f"\n[*] Session ID: {result['session_id']} (use with scoped-followup / scoped-finalize)")

        if getattr(args, 'json_output', None):
            Path(args.json_output).write_text(json.dumps(result), encoding="utf-8")

        if "error" in result:
            sys.exit(1)

    elif args.command == "scoped-followup":
        result = asyncio.run(council.review_file_scoped_followup(args.session, args.question, show_progress=True))
        result.pop("_tracker", None)

        if "error" in result:
            print(f"[!] {result['error']}", file=sys.stderr)
        else:
            print(f"\n{'='*60}")
            print(f"  Scoped Review Session: {result['session_id']} - Round {result['round_num']}")
            print(f"{'='*60}")
            print_scoped_round_results(result)

            if getattr(args, 'html', False):
                # The followup round's file_path isn't on args - read it back from the session.
                session_rows = council.db.get_scoped_session(args.session)
                file_path = session_rows[0]["file_path"] if session_rows else args.session
                report_path = generate_html_report(file_path, result["reviews"], getattr(args, 'output', None), power_mode)
                result["report_path"] = report_path
                print(f"\n[+] HTML report generated: {report_path}")

            print(f"\n[*] Session ID: {result['session_id']} (use with scoped-followup / scoped-finalize)")

        if getattr(args, 'json_output', None):
            Path(args.json_output).write_text(json.dumps(result), encoding="utf-8")

        if "error" in result:
            sys.exit(1)

    elif args.command == "scoped-finalize":
        result = asyncio.run(council.finalize_scoped_review(args.session, args.writer, args.output))

        if args.json:
            print(json.dumps(result))
        elif "error" in result:
            print(f"[!] {result['error']}", file=sys.stderr)
        else:
            print(f"[+] Review doc written by {result['writer'].upper()}: {result['output_path']}")

        if "error" in result:
            sys.exit(1)

    elif args.command == "debate":
        result = asyncio.run(council.run_debate_round(args.session, mode=args.mode, arbiter_name=args.arbiter))

        if args.json:
            print(json.dumps(result))
        elif "error" in result:
            print(f"[!] {result['error']}", file=sys.stderr)
        else:
            print(f"\n{'='*60}")
            print(f"  Debate Round {result['debate_round_num']} ({result['mode']}" +
                  (f", arbiter={result['arbiter']}" if result.get('arbiter') else "") + ")")
            print(f"{'='*60}")
            for c in result["clusters"]:
                print(f"\n[{c['cluster_id']}] {c['summary']}")
                for m in c["members"]:
                    print(f"  raised by {m['model']}: [{m['issue'].get('severity', '?')}] {m['issue'].get('description', '')[:80]}")
                for model, positions in result["positions"].items():
                    if model == "_arbiter_ruling":
                        continue
                    if "error" in positions:
                        continue
                    pos = positions.get(c["cluster_id"])
                    if pos:
                        print(f"  {model}: {pos.get('stance', '?')} - {pos.get('reasoning', '')[:100]}")
                ruling = result["positions"].get("_arbiter_ruling", {}).get(c["cluster_id"])
                if ruling:
                    print(f"  ARBITER RULING: {ruling.get('verdict', '?')} ({ruling.get('final_severity', '?')}) - {ruling.get('reasoning', '')[:100]}")
            print(f"\n{'='*60}")
            print(f"  Consensus: {result['consensus_pct']}%")
            print(f"{'='*60}")

        if "error" in result:
            sys.exit(1)

    elif args.command == "consolidate":
        result = asyncio.run(council.consolidate_debate(args.session, args.consolidator, force=args.force))

        if args.json:
            print(json.dumps(result))
        elif "error" in result:
            print(f"[!] {result['error']}", file=sys.stderr)
        else:
            print(f"\n{'='*60}")
            cached_note = " [cached]" if result.get("cached") else ""
            print(f"  Consolidated Review (by {result['consolidated_by'].upper()}, debate round {result['debate_round_num']}){cached_note}")
            print(f"{'='*60}")
            print(f"\n{result['summary']}\n")
            print("  Findings:")
            for f in result["findings"]:
                print(f"\n  [{f.get('severity', '?')}] {f.get('description', '')}")
                print(f"    Fix: {f.get('fix', '')}")
            if result["open_questions"]:
                print("\n  Open Questions:")
                for q in result["open_questions"]:
                    print(f"\n  - {q.get('question', '')}")
                    print(f"    Why unresolved: {q.get('why_unresolved', '')}")

        if "error" in result:
            sys.exit(1)

    elif args.command == "fix":
        # Parse issues from HTML report if provided
        issues = []
        if args.report:
            try:
                from bs4 import BeautifulSoup
                report_html = Path(args.report).read_text(encoding="utf-8", errors="ignore")
                soup = BeautifulSoup(report_html, 'html.parser')

                # Extract issues from the report
                for issue_div in soup.select('.issue'):
                    severity_badge = issue_div.select_one('.badge')
                    line_span = issue_div.select_one('.issue-line')
                    desc_div = issue_div.select_one('.issue-desc')
                    rec_div = issue_div.select_one('.issue-rec')

                    issue = {
                        "severity": severity_badge.get_text(strip=True) if severity_badge else "INFO",
                        "line": line_span.get_text(strip=True).replace("Line ", "") if line_span else "?",
                        "description": desc_div.get_text(strip=True) if desc_div else "",
                        "recommendation": rec_div.get_text(strip=True).replace("💡 ", "") if rec_div else ""
                    }
                    issues.append(issue)
            except ImportError:
                print("[!] beautifulsoup4 not installed, fixing without issue context", file=sys.stderr)
            except Exception as e:
                print(f"[!] Could not parse report: {e}", file=sys.stderr)

        try:
            fixed_code = asyncio.run(council.fix_code(args.file, args.fixer, issues if issues else None))
            # Output the fixed code to stdout (extension will capture it)
            print(fixed_code)
        except Exception as e:
            print(f"Error: {describe_exception(e)}", file=sys.stderr)
            sys.exit(1)

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
