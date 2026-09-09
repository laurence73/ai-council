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
        "gemini": {"enabled": False, "api_key_env": "GOOGLE_API_KEY"}
    }
}

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

    def __init__(self, api_key: str):
        if not HAS_OPENAI:
            raise ImportError("openai package not installed. Run: pip install openai")
        self.client = openai.OpenAI(api_key=api_key)

    async def review(self, code: str, file_path: str) -> dict:
        try:
            response = self.client.chat.completions.create(
                model="gpt-4-turbo",
                messages=[
                    {"role": "system", "content": REVIEW_SYSTEM_PROMPT},
                    {"role": "user", "content": f"File: {file_path}\n\n```\n{code}\n```"}
                ],
                response_format={"type": "json_object"},
                temperature=0.3
            )
            return json.loads(response.choices[0].message.content)
        except Exception as e:
            return {"error": str(e), "issues": [], "quality_score": 0}


class GrokReviewer:
    """xAI Grok reviewer - uses grok-build (code-optimized model)"""

    def __init__(self, api_key: str):
        if not HAS_HTTPX:
            raise ImportError("httpx package not installed. Run: pip install httpx")
        self.api_key = api_key
        self.base_url = "https://api.x.ai/v1"

    async def review(self, code: str, file_path: str) -> dict:
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{self.base_url}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
                        "Content-Type": "application/json"
                    },
                    json={
                        "model": "grok-build-0.1",  # Code-optimized Grok model
                        "messages": [
                            {"role": "system", "content": REVIEW_SYSTEM_PROMPT},
                            {"role": "user", "content": f"File: {file_path}\n\n```\n{code}\n```"}
                        ]
                    },
                    timeout=90.0
                )
                data = response.json()
                # Handle API errors
                if "error" in data:
                    return {"error": data.get("error", "Unknown API error"), "issues": [], "quality_score": 0}
                content = data["choices"][0]["message"]["content"]
                # Try to extract JSON from response
                if "```json" in content:
                    content = content.split("```json")[1].split("```")[0]
                elif "```" in content:
                    content = content.split("```")[1].split("```")[0]
                return json.loads(content)
        except Exception as e:
            return {"error": str(e), "issues": [], "quality_score": 0}


class GeminiReviewer:
    """Google Gemini reviewer"""

    def __init__(self, api_key: str):
        if not HAS_HTTPX:
            raise ImportError("httpx package not installed. Run: pip install httpx")
        self.api_key = api_key
        self.base_url = "https://generativelanguage.googleapis.com/v1beta"

    async def review(self, code: str, file_path: str) -> dict:
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{self.base_url}/models/gemini-1.5-flash:generateContent?key={self.api_key}",
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
                # Try to extract JSON from response
                if "```json" in content:
                    content = content.split("```json")[1].split("```")[0]
                elif "```" in content:
                    content = content.split("```")[1].split("```")[0]
                return json.loads(content)
        except Exception as e:
            return {"error": str(e), "issues": [], "quality_score": 0}


class AICouncil:
    """Main orchestrator for multi-model reviews"""

    def __init__(self, config: dict = None, enable_gemini: bool = False):
        self.config = config or DEFAULT_CONFIG.copy()
        # Override gemini setting if requested
        if enable_gemini:
            self.config["models"]["gemini"]["enabled"] = True
        self.db = ReviewDatabase(self.config["db_path"])
        self.reviewers = {}
        self._setup_reviewers()

    def _setup_reviewers(self):
        models = self.config.get("models", {})

        if models.get("gpt-4", {}).get("enabled"):
            api_key = os.environ.get(models["gpt-4"]["api_key_env"])
            if api_key:
                try:
                    self.reviewers["gpt-4"] = GPTReviewer(api_key)
                    print("[+] GPT-4 reviewer enabled")
                except ImportError as e:
                    print(f"[-] GPT-4 disabled: {e}")

        if models.get("grok", {}).get("enabled"):
            api_key = os.environ.get(models["grok"]["api_key_env"])
            if api_key:
                try:
                    self.reviewers["grok"] = GrokReviewer(api_key)
                    print("[+] Grok reviewer enabled")
                except ImportError as e:
                    print(f"[-] Grok disabled: {e}")

        if models.get("gemini", {}).get("enabled"):
            api_key = os.environ.get(models["gemini"]["api_key_env"])
            if api_key:
                try:
                    self.reviewers["gemini"] = GeminiReviewer(api_key)
                    print("[+] Gemini reviewer enabled")
                except ImportError as e:
                    print(f"[-] Gemini disabled: {e}")

        if not self.reviewers:
            print("[!] No reviewers configured. Set API keys in environment.")

    def get_file_hash(self, content: str) -> str:
        return hashlib.sha256(content.encode()).hexdigest()[:16]

    async def review_file(self, file_path: str, force: bool = False) -> dict:
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

        # Run reviews in parallel
        results = {}
        tasks = []

        for model_name, reviewer in self.reviewers.items():
            tasks.append(self._review_with_model(model_name, reviewer, content, file_path))

        if tasks:
            completed = await asyncio.gather(*tasks)
            for model_name, review in completed:
                results[model_name] = review
                self.db.add_review(str(file_path), file_hash, model_name, review)

        return {"cached": False, "reviews": results}

    async def _review_with_model(self, model_name: str, reviewer, content: str, file_path: str):
        print(f"  [{model_name}] Reviewing...")
        review = await reviewer.review(content, file_path)
        print(f"  [{model_name}] Done - Score: {review.get('quality_score', '?')}/10")
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


def generate_html_report(file_path: str, reviews: dict, output_path: str = None) -> str:
    """Generate a beautiful HTML report for the review results"""
    from datetime import datetime

    filename = Path(file_path).name
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # Calculate consensus
    all_issues = []
    scores = []
    for model, review in reviews.items():
        if isinstance(review, dict) and "error" not in review:
            scores.append(review.get("quality_score", 0))
            for issue in review.get("issues", []):
                issue["model"] = model
                all_issues.append(issue)

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
        .container {{ max-width: 900px; margin: 0 auto; }}
        .header {{
            background: linear-gradient(135deg, var(--zinc-900), var(--zinc-800));
            border: 1px solid var(--zinc-700); border-radius: 16px;
            padding: 2rem; margin-bottom: 2rem; position: relative; overflow: hidden;
        }}
        .header::before {{
            content: ''; position: absolute; top: 0; left: 0; right: 0; height: 4px;
            background: linear-gradient(90deg, var(--indigo-500), var(--purple-500), var(--cyan-500));
        }}
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
        .issue-desc {{ color: var(--text-secondary); font-size: 0.9rem; }}
        .issue-rec {{ color: var(--emerald-400); font-size: 0.85rem; margin-top: 0.5rem; font-style: italic; }}
        .model-tag {{
            font-size: 0.65rem; padding: 0.15em 0.4em; border-radius: 3px;
            background: var(--zinc-700); color: var(--zinc-400);
        }}
        .summary {{ color: var(--text-secondary); font-size: 0.9rem; margin-bottom: 1rem; }}
        .footer {{ text-align: center; margin-top: 2rem; color: var(--zinc-500); font-size: 0.8rem; }}
        code {{ font-family: 'JetBrains Mono', monospace; background: var(--zinc-900); padding: 0.1em 0.3em; border-radius: 3px; font-size: 0.85em; }}
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🤖 AI Council Review</h1>
            <div class="meta">
                <strong>{filename}</strong> &bull; {timestamp}
            </div>
        </div>

        <div class="score-grid">
'''

    # Add score cards for each model
    for model, review in reviews.items():
        if isinstance(review, dict):
            score = review.get("quality_score", 0) if "error" not in review else "ERR"
            issues_count = len(review.get("issues", [])) if "error" not in review else 0
            model_class = "gpt" if "gpt" in model.lower() else ("grok" if "grok" in model.lower() else "gemini")
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
            model_class = "gpt" if "gpt" in model.lower() else ("grok" if "grok" in model.lower() else "gemini")
            emoji = "🧠" if "gpt" in model.lower() else ("⚡" if "grok" in model.lower() else "💎")

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
    review_parser.add_argument("--html", action="store_true", help="Generate HTML report")
    review_parser.add_argument("--output", "-o", help="Output path for HTML report")

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

    # Enable gemini if --gemini flag is passed on review command
    enable_gemini = getattr(args, 'gemini', False)
    council = AICouncil(enable_gemini=enable_gemini)

    if args.command == "status":
        print("\n=== AI Council Status ===")
        print(f"Database: {council.config['db_path']}")
        print(f"Reviewers: {', '.join(council.reviewers.keys()) or 'None configured'}")
        pending = council.db.get_pending(100)
        print(f"Pending reviews: {len(pending)}")

    elif args.command == "review":
        print(f"\nReviewing: {args.file}")
        result = asyncio.run(council.review_file(args.file, force=args.force))
        if result.get("cached"):
            print("[*] Using cached review")

        reviews_data = {}
        if "reviews" in result:
            for model, review in result["reviews"].items():
                reviews_data[model] = review
                print(f"\n[{model.upper()}]")
                if "error" in review:
                    print(f"  Error: {review['error']}")
                else:
                    print(f"  Score: {review.get('quality_score', '?')}/10")
                    print(f"  Issues: {len(review.get('issues', []))}")

        # Generate HTML report if --html flag is passed
        if getattr(args, 'html', False) and reviews_data:
            output_path = getattr(args, 'output', None)
            report_path = generate_html_report(args.file, reviews_data, output_path)
            print(f"\n[+] HTML report generated: {report_path}")

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
