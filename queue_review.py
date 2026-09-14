#!/usr/bin/env python3
"""
Quick queue script for Claude Code hooks
Usage: python queue_review.py "path/to/file.cs"

Set AI_COUNCIL_WORKSPACE to the project folder you review from the VS Code extension - the
extension always stores its data in "<workspace>/.ai-council/reviews.db", and this script
writes to that same file (falling back to the current working directory if unset) so a queued
file actually lands in a database the extension/CLI can see.
"""

import os
import sys
import sqlite3
from pathlib import Path
from datetime import datetime

DB_PATH = Path(os.environ.get("AI_COUNCIL_WORKSPACE", os.getcwd())) / ".ai-council" / "reviews.db"

def queue_file(file_path: str, priority: str = "normal"):
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))

    # Create table if not exists
    conn.execute("""
        CREATE TABLE IF NOT EXISTS queue (
            id INTEGER PRIMARY KEY,
            file_path TEXT NOT NULL,
            priority TEXT DEFAULT 'normal',
            status TEXT DEFAULT 'pending',
            queued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # Insert
    conn.execute(
        "INSERT INTO queue (file_path, priority, status, queued_at) VALUES (?, ?, 'pending', ?)",
        (file_path, priority, datetime.now().isoformat())
    )
    conn.commit()
    conn.close()

    print(f"[AI Council] Queued: {file_path}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python queue_review.py <file_path> [priority]")
        sys.exit(1)

    file_path = sys.argv[1]
    priority = sys.argv[2] if len(sys.argv) > 2 else "normal"

    # Only queue code files
    ext = Path(file_path).suffix.lower()
    if ext in [".cs", ".razor", ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".cpp", ".c"]:
        queue_file(file_path, priority)
    else:
        print(f"[AI Council] Skipped (not code): {file_path}")
