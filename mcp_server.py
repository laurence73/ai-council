#!/usr/bin/env python3
"""
AI Council MCP Server
Allows Claude Code to query reviews from other AI models

To use with Claude Code, add to ~/.claude/settings.json:
{
  "mcpServers": {
    "ai-council": {
      "command": "python",
      "args": ["/absolute/path/to/your/ai-council/checkout/mcp_server.py"],
      "env": {
        "AI_COUNCIL_WORKSPACE": "C:/path/to/your/project",
        "OPENAI_API_KEY": "your-key",
        "XAI_API_KEY": "your-key"
      }
    }
  }
}

AI_COUNCIL_WORKSPACE must point at the same project folder you review from the VS Code
extension - the extension always stores reviews in
"<workspace>/.ai-council/reviews.db", and this server reads that same file (falling back
to the current working directory if the variable isn't set) so get_reviews/get_consensus
can actually see extension-made reviews instead of a separate, empty database.
"""

import asyncio
import json
import os
import sys
from pathlib import Path

# ai_council.py only lives in vscode-extension/ now - add that to the import path.
sys.path.insert(0, str(Path(__file__).parent / "vscode-extension"))

from ai_council import AICouncil, ReviewDatabase

_WORKSPACE_ROOT = Path(os.environ.get("AI_COUNCIL_WORKSPACE", os.getcwd())).resolve()
_WORKSPACE_DB_PATH = str(_WORKSPACE_ROOT / ".ai-council" / "reviews.db")

# Same extension allowlist ai_council.py's own watch_patterns / the VS Code extension's
# SUPPORTED_REVIEW_EXTENSIONS use - kept in sync manually since this is a separate process
# with no import path to the TS constant.
_SUPPORTED_EXTENSIONS = {".cs", ".razor", ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".cpp", ".c"}


def _canonicalize_path(file_path: str) -> Path:
    """Resolves file_path (relative paths are taken as relative to the workspace root) to the
    same absolute, symlink-resolved form review_file() now canonicalizes to before storing a
    review - get_reviews/get_consensus's exact-string WHERE file_path = ? database lookup only
    matches a review recorded under this same shape, so a caller handing in a relative path
    (the natural thing to pass) must be normalized the same way the write path is, or a lookup
    for a file that plainly has reviews silently returns none. Does not require the file to
    exist or be in-workspace - unlike _resolve_workspace_file, this only shapes a string for a
    read-only database query, it never touches the filesystem or a reviewer."""
    candidate = Path(file_path)
    return (_WORKSPACE_ROOT / candidate).resolve() if not candidate.is_absolute() else candidate.resolve()


def _resolve_workspace_file(file_path: str) -> Path:
    """request_review is a directly MCP-callable tool - an MCP client (or an agent acting on
    hostile instructions it encountered elsewhere) could otherwise ask it to review an
    arbitrary readable local file (an SSH key, a .env, browser credential storage) and have
    its content sent to every configured reviewer, API and CLI alike. Every reviewed path must
    resolve (following symlinks - resolve() does that) to somewhere inside the configured
    workspace root and carry a supported source extension, or this raises ValueError."""
    candidate = _canonicalize_path(file_path)
    try:
        candidate.relative_to(_WORKSPACE_ROOT)
    except ValueError:
        raise ValueError(f"'{file_path}' is outside the configured workspace ({_WORKSPACE_ROOT})")
    if candidate.suffix.lower() not in _SUPPORTED_EXTENSIONS:
        raise ValueError(f"'{file_path}' is not a supported source file type")
    return candidate

# MCP stdio framing permits protocol messages only on stdout. ai_council.py's reviewer setup
# (and plenty of other code in it) calls plain print() throughout its lifetime, not just at
# construction - capture the real stdout once, before AICouncil() can print anything to it,
# then redirect sys.stdout to stderr for the rest of the process so any of those prints can
# never desync a client's JSON-RPC stream. The two places that must actually speak the
# protocol write to _RPC_STDOUT explicitly instead of using print().
_RPC_STDOUT = sys.stdout
sys.stdout = sys.stderr


def _write_rpc(obj: dict):
    _RPC_STDOUT.write(json.dumps(obj) + "\n")
    _RPC_STDOUT.flush()


# MCP protocol implementation
class MCPServer:
    def __init__(self):
        self.council = AICouncil(db_path=_WORKSPACE_DB_PATH)

    async def handle_message(self, message: dict) -> dict:
        method = message.get("method")
        params = message.get("params", {})
        msg_id = message.get("id")

        if method == "initialize":
            return self._response(msg_id, {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "ai-council", "version": "1.0.0"}
            })

        elif method == "tools/list":
            return self._response(msg_id, {
                "tools": [
                    {
                        "name": "get_reviews",
                        "description": "Get AI council reviews for a file. Returns reviews from every enabled seat (GPT-4, Claude, Grok, Gemini, CLI seats, Ollama).",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "file_path": {"type": "string", "description": "Path to the file to get reviews for"}
                            },
                            "required": ["file_path"]
                        }
                    },
                    {
                        "name": "request_review",
                        "description": "Request the AI council to review a file immediately",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "file_path": {"type": "string", "description": "Path to the file to review"},
                                "force": {"type": "boolean", "description": "Force re-review even if cached", "default": False}
                            },
                            "required": ["file_path"]
                        }
                    },
                    {
                        "name": "get_consensus",
                        "description": "Group a file's cached reviews (from every seat that reviewed its CURRENT revision) into consensus/unique findings, using one AI seat to do the grouping. Cached per (file revision, contributing reviewers) - a repeat call for an unchanged file with no new reviews returns the same cached result at no extra cost; pass force to re-run the grouping anyway.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "file_path": {"type": "string", "description": "Optional file path to get consensus for"},
                                "force": {"type": "boolean", "description": "Re-run the consensus grouping even if a cached result for this exact file revision and reviewer set already exists", "default": False}
                            }
                        }
                    },
                    {
                        "name": "council_status",
                        "description": "Get AI council status - active reviewers, pending queue, etc.",
                        "inputSchema": {"type": "object", "properties": {}}
                    }
                ]
            })

        elif method == "tools/call":
            tool_name = params.get("name")
            tool_args = params.get("arguments", {})

            if tool_name == "get_reviews":
                result = await self._get_reviews(tool_args.get("file_path"))
            elif tool_name == "request_review":
                result = await self._request_review(
                    tool_args.get("file_path"),
                    tool_args.get("force", False)
                )
            elif tool_name == "get_consensus":
                result = await self._get_consensus(tool_args.get("file_path"), tool_args.get("force", False))
            elif tool_name == "council_status":
                result = self._get_status()
            else:
                result = {"error": f"Unknown tool: {tool_name}"}

            return self._response(msg_id, {
                "content": [{"type": "text", "text": json.dumps(result, indent=2)}]
            })

        return self._response(msg_id, {})

    def _response(self, msg_id, result):
        return {"jsonrpc": "2.0", "id": msg_id, "result": result}

    async def _get_reviews(self, file_path: str) -> dict:
        canonical = str(_canonicalize_path(file_path))
        reviews = self.council.db.get_reviews(canonical, limit=5)
        if not reviews:
            return {"message": f"No reviews found for {file_path}", "reviews": []}

        formatted = []
        for r in reviews:
            review = r["review"]
            formatted.append({
                "model": r["model"],
                "created_at": r["created_at"],
                "quality_score": review.get("quality_score"),
                "summary": review.get("summary"),
                "issues": review.get("issues", []),
                "error": review.get("error")
            })

        return {"file": file_path, "reviews": formatted}

    async def _request_review(self, file_path: str, force: bool) -> dict:
        try:
            resolved_path = _resolve_workspace_file(file_path)
        except ValueError as e:
            return {"error": str(e)}

        result = await self.council.review_file(str(resolved_path), force=force)

        if result.get("cached") and not force:
            return {"message": "Using cached review", "cached": True, "reviews": result.get("reviews", {})}

        reviews = result.get("reviews", {})
        summary = []
        for model, review in reviews.items():
            if "error" in review:
                summary.append(f"{model}: Error - {review['error']}")
            else:
                score = review.get("quality_score", "?")
                issues = len(review.get("issues", []))
                summary.append(f"{model}: Score {score}/10, {issues} issues")

        return {
            "message": "Review complete",
            "summary": summary,
            "reviews": reviews
        }

    async def _get_consensus(self, file_path: str = None, force: bool = False) -> dict:
        if file_path:
            # Read the file FIRST, both because aggregate_reviews' synthesis prompt needs its
            # current content and because the current content's hash is what selects WHICH
            # stored reviews are even eligible below - get_reviews has no file_hash column in
            # its default query, so filtering only by file_path can combine one model's review
            # of an old revision with another model's review of a newer one, then hand the
            # synthesizer a THIRD (current) revision's code - a "consensus" that doesn't
            # describe any single real revision. Passing file_hash restricts to reviews that
            # were actually run against the exact code being synthesized now.
            try:
                resolved_path = _resolve_workspace_file(file_path)
                code_content = resolved_path.read_text(encoding="utf-8", errors="ignore")
            except (ValueError, OSError) as e:
                return {"file": file_path, "error": f"Cannot read file for consensus grouping: {e}"}

            current_hash = self.council.get_file_hash(code_content)
            # get_latest_reviews_by_hash (NOT the bounded-history get_reviews(limit=N)) - a
            # global LIMIT is a history window, not "one row per model": after several
            # force-reviews of some seats, ten rows can be "three seats x several retries" with
            # a fourth seat's only review pushed past the window and silently absent from
            # consensus - reproduced exactly that. This query guarantees one (the latest) row
            # per model with no cap on how many distinct models can appear.
            reviews = self.council.db.get_latest_reviews_by_hash(str(resolved_path), current_hash)
            if not reviews:
                return {"message": "No reviews found for the current revision of this file - it may have changed since it was last reviewed. Re-review it to get a current consensus."}

            # Track each selected row's own id alongside its content - the cache fingerprint
            # below needs the ACTUAL row identity, not just which model names are present, so a
            # forced re-review (new row, new id, same model name, same file hash) correctly
            # invalidates the old cache instead of silently reusing it.
            review_dict = {r["model"]: r["review"] for r in reviews}
            selected_rows = [{"model": r["model"], "id": r["id"]} for r in reviews]

            # Grouping the SAME reviews for the SAME file revision is the same answer every
            # time - re-running the synthesis seat call on every poll would be pure re-spend
            # for an identical result, not a refresh. Resolve the seat ahead of the actual
            # call (same priority order aggregate_reviews/synthesize_reviews would use) so the
            # cache can be checked before spending anything, and pass that same seat through
            # explicitly so a cache miss can't silently synthesize with a DIFFERENT seat than
            # the one just checked.
            synthesizer_key, _ = self.council._pick_seat(None)
            if not synthesizer_key:
                return {"file": file_path, "error": "No AI available for synthesis"}

            cached = None
            if not force:
                cached = self.council.db.get_cached_file_consensus(
                    str(resolved_path), current_hash, synthesizer_key, selected_rows
                )
            if cached is not None:
                return {"file": file_path, "consensus": cached, "cached": True}

            consensus = await self.council.aggregate_reviews(
                str(resolved_path), code_content, review_dict, preferred_synthesizer=synthesizer_key
            )
            # Only a genuinely-completed synthesis is worth caching - aggregate_reviews sets
            # synthesized_by ONLY on that success path (absent both when synthesis outright
            # failed and when it never ran at all, e.g. <2 successful reviews to group). Caching
            # the "nothing to synthesize yet" shape under this synthesizer_key would wrongly
            # keep serving it later even after a second reviewer's review makes real synthesis
            # possible - reproduced and confirmed this exact failure while testing the cache.
            if consensus.get("synthesized_by"):
                self.council.db.save_file_consensus(
                    str(resolved_path), current_hash, synthesizer_key, selected_rows, consensus
                )
            return {
                "file": file_path,
                "consensus": consensus
            }

        # Get recent reviews if no file specified
        return {"message": "Specify a file path to get consensus"}

    def _get_status(self) -> dict:
        pending = self.council.db.get_pending(100)
        return {
            "active_reviewers": list(self.council.reviewers.keys()),
            "pending_reviews": len(pending),
            "database": str(self.council.config["db_path"])
        }

    async def run(self):
        """Main loop - reads from stdin, writes to stdout"""
        while True:
            try:
                line = await asyncio.get_event_loop().run_in_executor(None, sys.stdin.readline)
                if not line:
                    break

                message = json.loads(line)
                response = await self.handle_message(message)
                _write_rpc(response)

            except json.JSONDecodeError:
                continue
            except Exception as e:
                _write_rpc({
                    "jsonrpc": "2.0",
                    "error": {"code": -32603, "message": str(e)}
                })


if __name__ == "__main__":
    server = MCPServer()
    asyncio.run(server.run())
