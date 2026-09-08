#!/usr/bin/env python3
"""
AI Council MCP Server
Allows Claude Code to query reviews from other AI models

To use with Claude Code, add to ~/.claude/settings.json:
{
  "mcpServers": {
    "ai-council": {
      "command": "python",
      "args": ["C:/AI COUNCIL/mcp_server.py"],
      "env": {
        "OPENAI_API_KEY": "your-key",
        "XAI_API_KEY": "your-key"
      }
    }
  }
}
"""

import asyncio
import json
import sys
from pathlib import Path

# Add parent to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from ai_council import AICouncil, ReviewDatabase

# MCP protocol implementation
class MCPServer:
    def __init__(self):
        self.council = AICouncil()

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
                        "description": "Get AI council reviews for a file. Returns reviews from GPT-4 and Grok.",
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
        reviews = self.council.db.get_reviews(file_path, limit=5)
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
        result = await self.council.review_file(file_path, force=force)

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
            reviews = self.council.db.get_reviews(file_path, limit=10)
            if not reviews:
                return {"message": "No reviews found"}

            review_dict = {r["model"]: r["review"] for r in reviews}
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
                print(json.dumps(response), flush=True)

            except json.JSONDecodeError:
                continue
            except Exception as e:
                print(json.dumps({
                    "jsonrpc": "2.0",
                    "error": {"code": -32603, "message": str(e)}
                }), flush=True)


if __name__ == "__main__":
    server = MCPServer()
    asyncio.run(server.run())
