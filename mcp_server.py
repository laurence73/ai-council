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
                        "description": "Get consensus summary from all AI reviewers for recent changes",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "file_path": {"type": "string", "description": "Optional file path to get consensus for"}
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
                result = await self._get_consensus(tool_args.get("file_path"))
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

    async def _get_consensus(self, file_path: str = None) -> dict:
        if file_path:
            reviews = self.council.db.get_reviews(str(_canonicalize_path(file_path)), limit=10)
            if not reviews:
                return {"message": "No reviews found"}

            # get_reviews returns newest-first; keep only the first (newest) row seen per
            # model - a plain dict comprehension would let a later, OLDER row for the same
            # model overwrite the newer one, since dict construction keeps the LAST key seen.
            review_dict = {}
            for r in reviews:
                review_dict.setdefault(r["model"], r["review"])
            consensus = self.council.aggregate_reviews(review_dict)
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
