#!/usr/bin/env python3
"""
AI Council - lightweight scoped-review session query tool.

DELIBERATE DUPLICATION, NOT DEAD CODE - keep in sync with ai_council.py.
ai_council.py's ReviewDatabase class has list_scoped_sessions/get_scoped_session/
get_latest_debate_round/get_latest_consolidation (and the module-level
scoped_session_report_path function) - this script re-implements exactly those, using only
sqlite3/json/pathlib from the standard library. It exists because importing ai_council.py at
all costs ~2.5s just from its top-level `import openai` / `import anthropic` (measured via
`python -X importtime`), even when nothing that needs those SDKs is being touched - session
list/resume is a pure SQLite read with zero AI calls involved, and paying that import cost on
every sidebar click was the actual "too much background processing" complaint this script fixes.

A native Node SQLite binding (better-sqlite3) was tried instead, reading reviews.db directly
from the VS Code extension host - reverted (see design-decisions.md) because it required
Node >=22 while the extension's declared VS Code floor (^1.85.0) embeds a much older Node/
Electron, and a failed native module load at module-import time would have broken the WHOLE
extension's activation, not just session-list. This script keeps the speed goal without a
native dependency: plain sqlite3, Python's own interpreter start is on the order of tens of
milliseconds, not seconds.

If you change scoped_reviews/debate_rounds/debate_consolidations' schema, or the query/assembly
logic in ai_council.py's ReviewDatabase.list_scoped_sessions / get_scoped_session /
get_latest_debate_round / get_latest_consolidation / scoped_session_report_path, or the
"scoped-sessions"/"scoped-resume" CLI handlers in ai_council.py's main() - update this file to
match. sidePanel.ts's _listScopedSessions/_resumeScopedSession call THIS script, not
ai_council.py, for those two operations.
"""

import argparse
import json
import sqlite3
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


# Mirrors ai_council.py's scoped_session_report_path exactly - see that function's own
# docstring for why the path is deterministic (session_id alone, no timestamp/counter).
def scoped_session_report_path(db_path: str, file_path: str, session_id: str) -> str:
    reports_dir = Path(db_path).parent / "reports"
    clean_name = Path(file_path).stem[:30]
    return str(reports_dir / f"scoped-review-{clean_name}-{session_id}.html")


# Mirrors ai_council.py's ReviewDatabase.list_scoped_sessions exactly.
def list_scoped_sessions(conn: sqlite3.Connection, file_path: str = None, limit: int = 50) -> list:
    where = "WHERE file_path = ?" if file_path else ""
    params = (file_path,) if file_path else ()
    cursor = conn.execute(f"""
        SELECT s.session_id, s.file_path, s.content, s.created_at,
               (SELECT MAX(round_num) FROM scoped_reviews WHERE session_id = s.session_id) AS max_round
        FROM scoped_reviews s
        INNER JOIN (
            SELECT session_id, MIN(id) AS min_id
            FROM scoped_reviews
            WHERE role = 'user' AND round_num = 0
            GROUP BY session_id
        ) first_round ON first_round.min_id = s.id
        {where}
        ORDER BY s.created_at DESC
        LIMIT ?
    """, params + (limit,))
    results = []
    for row in cursor:
        content = json.loads(row[2])
        results.append({
            "session_id": row[0],
            "file_path": row[1],
            "scope": content.get("scope", ""),
            "created_at": row[3],
            "max_round": row[4],
        })
    return results


# Mirrors ai_council.py's ReviewDatabase.get_scoped_session exactly.
def get_scoped_session(conn: sqlite3.Connection, session_id: str) -> list:
    cursor = conn.execute("""
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


# Mirrors ai_council.py's ReviewDatabase.get_latest_debate_round (via get_debate_rounds) exactly.
def get_latest_debate_round(conn: sqlite3.Connection, session_id: str) -> dict:
    cursor = conn.execute("""
        SELECT debate_round_num, mode, arbiter, clusters_json, positions_json, consensus_pct, token_usage_json, created_at
        FROM debate_rounds
        WHERE session_id = ?
        ORDER BY debate_round_num ASC
    """, (session_id,))
    rows = list(cursor)
    if not rows:
        return None
    r = rows[-1]
    return {
        "debate_round_num": r[0],
        "mode": r[1],
        "arbiter": r[2],
        "clusters": json.loads(r[3]),
        "positions": json.loads(r[4]),
        "consensus_pct": r[5],
        "token_usage": json.loads(r[6]) if r[6] else None,
        "created_at": r[7],
    }


# Mirrors ai_council.py's ReviewDatabase.get_latest_consolidation exactly.
def get_latest_consolidation(conn: sqlite3.Connection, session_id: str, debate_round_num: int) -> dict:
    cursor = conn.execute("""
        SELECT consolidated_by, result_json FROM debate_consolidations
        WHERE session_id = ? AND debate_round_num = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1
    """, (session_id, debate_round_num))
    row = cursor.fetchone()
    if not row:
        return None
    result = json.loads(row[1])
    result["consolidated_by"] = row[0]
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    subparsers = parser.add_subparsers(dest="command", required=True)

    sessions_parser = subparsers.add_parser("scoped-sessions")
    sessions_parser.add_argument("--file")
    sessions_parser.add_argument("--limit", type=int, default=50)

    resume_parser = subparsers.add_parser("scoped-resume")
    resume_parser.add_argument("--session", required=True)

    args = parser.parse_args()

    # A first-ever open of the Scope panel in a workspace that has never run a scoped review has
    # no reviews.db at all yet - that is a completely normal, expected state ("no sessions exist
    # yet"), not an error. sqlite3.connect() on a path that doesn't exist SILENTLY CREATES an
    # empty (schema-less) database file as a side effect of merely trying to read it, and the
    # query that follows then crashes with "no such table: scoped_reviews" - reproduced live: a
    # fresh workspace ended up with a 4096-byte reviews.db on disk after nothing but opening the
    # Scope panel, having never actually run a review. Checking existence first avoids creating
    # that file at all; the mode=ro URI connection below is belt-and-suspenders (this script must
    # never be able to write to reviews.db under any circumstance, only ai_council.py's own
    # ReviewDatabase does that).
    db_file = Path(args.db)
    if not db_file.exists():
        if args.command == "scoped-sessions":
            print(json.dumps({"sessions": []}))
        else:
            print(json.dumps({"error": f"No session found with ID {args.session}"}))
        return

    conn = sqlite3.connect(f"file:{db_file.as_posix()}?mode=ro", uri=True)
    try:
        # A reviews.db can exist (created by ai_council.py's ReviewDatabase.setup on first
        # actual review) but not yet have ever run a SCOPED review - scoped_reviews/
        # debate_rounds/debate_consolidations are created by the same setup() as every other
        # table, so this is only reachable with an unusually old/partial database, but it's the
        # same "no such table" crash as the missing-file case above and gets the same graceful
        # empty-result treatment rather than an uncaught traceback.
        try:
            # Mirrors ai_council.py's "scoped-sessions"/"scoped-resume" CLI handlers exactly.
            if args.command == "scoped-sessions":
                sessions = list_scoped_sessions(conn, args.file, args.limit)
                print(json.dumps({"sessions": sessions}))

            elif args.command == "scoped-resume":
                scoped_rounds = get_scoped_session(conn, args.session)
                if not scoped_rounds:
                    print(json.dumps({"error": f"No session found with ID {args.session}"}))
                    sys.exit(1)

                file_path = scoped_rounds[0]["file_path"]
                first_round = next((r for r in scoped_rounds if r["role"] == "user" and r["round_num"] == 0), None)
                nominated_arbiter = (first_round["content"].get("nominated_arbiter") if first_round else None)
                latest_council_round = max(
                    (r for r in scoped_rounds if r["role"] == "council"), key=lambda r: r["round_num"], default=None
                )
                debate_round = get_latest_debate_round(conn, args.session)
                consolidation_result = None
                if debate_round:
                    consolidation_result = get_latest_consolidation(conn, args.session, debate_round["debate_round_num"])

                report_path = None
                if latest_council_round:
                    report_path = scoped_session_report_path(args.db, file_path, args.session)
                    if not Path(report_path).exists():
                        report_path = None

                print(json.dumps({
                    "session_id": args.session,
                    "file_path": file_path,
                    "scope": first_round["content"].get("scope", "") if first_round else "",
                    "arbiter": nominated_arbiter,
                    "rounds": scoped_rounds,
                    "latest_reviews": latest_council_round["content"]["reviews"] if latest_council_round else None,
                    "latest_consensus": latest_council_round["content"]["consensus"] if latest_council_round else None,
                    "debate_round": debate_round,
                    "consolidation": consolidation_result,
                    "report_path": report_path,
                }))
        except sqlite3.OperationalError as e:
            if "no such table" in str(e):
                if args.command == "scoped-sessions":
                    print(json.dumps({"sessions": []}))
                else:
                    print(json.dumps({"error": f"No session found with ID {args.session}"}))
            else:
                # A real query error (corrupt db, locked file, etc.) - surface it rather than
                # silently discarding it as an empty result, per the review's explicit ask.
                print(json.dumps({"error": str(e)}))
                sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
