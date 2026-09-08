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
    """xAI Grok reviewer"""

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
                        "model": "grok-beta",
                        "messages": [
                            {"role": "system", "content": REVIEW_SYSTEM_PROMPT},
                            {"role": "user", "content": f"File: {file_path}\n\n```\n{code}\n```"}
                        ]
                    },
                    timeout=60.0
                )
                data = response.json()
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
        self.api_key = api_key

    async def review(self, code: str, file_path: str) -> dict:
        # TODO: Implement Gemini API
        return {"error": "Gemini not implemented yet", "issues": [], "quality_score": 0}


class AICouncil:
    """Main orchestrator for multi-model reviews"""

    def __init__(self, config: dict = None):
        self.config = config or DEFAULT_CONFIG
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

    council = AICouncil()

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
        if "reviews" in result:
            for model, review in result["reviews"].items():
                print(f"\n[{model.upper()}]")
                if "error" in review:
                    print(f"  Error: {review['error']}")
                else:
                    print(f"  Score: {review.get('quality_score', '?')}/10")
                    print(f"  Issues: {len(review.get('issues', []))}")

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
