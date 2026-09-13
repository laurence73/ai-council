"""CLI subscription transport for AI Council reviewers."""
from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Optional

# Layer 1: permanent integrity rule. Kept in sync with ai_council.py's copy - never exposed
# as a setting, never overridden by the rubric or by scope text.
REVIEW_INTEGRITY_RULE = """You are a senior code reviewer. State what's true, not what's pleasant:
- If a category has no genuine issues, say so plainly. Do not invent a finding to appear thorough.
- Rate severity by real-world impact, not to seem more useful or more careful than the code warrants.
- Form your own independent judgment. Do not agree with another reviewer's finding merely for
  consensus, and do not soften disagreement with a co-reviewer's assessment if your analysis differs."""

# Layer 2: the rubric - what to actually look for. Default text kept in sync with
# ai_council.py's DEFAULT_REVIEW_RUBRIC; overridable via the same AI_COUNCIL_REVIEW_RUBRIC env var.
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

REVIEW_JSON_SCHEMA = {
    "type": "object",
    "properties": {
        "issues": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "severity": {"type": "string"},
                    "line": {},
                    "description": {"type": "string"},
                    "recommendation": {"type": "string"},
                    "confidence": {"type": "number"},
                },
                "required": ["severity", "description"],
            },
        },
        "summary": {"type": "string"},
        "quality_score": {"type": "number"},
    },
    "required": ["issues", "summary", "quality_score"],
}

# Sensible subscription defaults / picker options
CLI_MODEL_CHOICES = {
    "anthropic": ["sonnet", "opus", "haiku", "claude-sonnet-4-5", "claude-opus-4-5"],
    "xai": ["grok-4.6", "grok-4.5"],
    "openai": ["gpt-5.2", "gpt-5", "o3", "o4-mini", "codex"],
}

CLI_MODEL_DEFAULTS = {
    "anthropic": "sonnet",
    "xai": "grok-4.6",
    # No default: valid model names are gated by the ChatGPT account's entitlement,
    # and a hardcoded guess (e.g. "gpt-5.2") errors as "not supported when using
    # Codex with a ChatGPT account" for accounts that don't have it. Omitting -m
    # lets codex exec pick a model the account can actually use.
    "openai": "",
}

PROVIDER_CLI = {
    "openai": ("codex", "AI_COUNCIL_TRANSPORT_OPENAI", "gpt-4"),
    "anthropic": ("claude", "AI_COUNCIL_TRANSPORT_ANTHROPIC", "claude"),
    "xai": ("grok", "AI_COUNCIL_TRANSPORT_XAI", "grok"),
}

API_KEY_ENV = {
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "xai": "XAI_API_KEY",
}

CLI_MODEL_ENV = {
    "openai": "AI_COUNCIL_CLI_MODEL_OPENAI",
    "anthropic": "AI_COUNCIL_CLI_MODEL_ANTHROPIC",
    "xai": "AI_COUNCIL_CLI_MODEL_XAI",
}


def find_cli(name: str) -> Optional[str]:
    if sys.platform == "win32":
        cmd = shutil.which(f"{name}.cmd") or shutil.which(name)
        if cmd:
            return cmd
    return shutil.which(name)


def extract_json_object(text: str) -> Optional[dict]:
    """Pull review JSON from CLI stdout (raw, fenced, envelopes, nested text)."""
    if not text:
        return None
    text = text.strip()

    def from_dict(data):
        if not isinstance(data, dict):
            return None
        if "issues" in data or "quality_score" in data or "council_verdict" in data:
            return data
        if isinstance(data.get("structured_output"), dict):
            return from_dict(data["structured_output"]) or data["structured_output"]
        # Claude envelope
        if isinstance(data.get("result"), str):
            inner = extract_json_object(data["result"])
            if inner:
                return inner
        # Grok often wraps: {"text": "{...json...}"}
        # Codex --json wraps: {"type": "item.completed", "item": {"text": "{...json...}"}}
        for key in ("text", "output", "message", "content", "response", "last_message", "item"):
            val = data.get(key)
            if isinstance(val, str):
                inner = extract_json_object(val)
                if inner:
                    return inner
            if isinstance(val, dict):
                inner = from_dict(val)
                if inner:
                    return inner
        return None

    try:
        data = json.loads(text)
        got = from_dict(data) if isinstance(data, dict) else None
        if got:
            return got
    except json.JSONDecodeError:
        pass

    # JSONL (codex --json): take last object with text/result. The whole blob is
    # rarely valid JSON on its own (that's the case above), so this must not be
    # gated behind the first json.loads succeeding.
    if "\n" in text:
        last = None
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            cand = from_dict(obj) if isinstance(obj, dict) else None
            if cand:
                last = cand
            elif isinstance(obj, dict) and isinstance(obj.get("text"), str):
                cand = extract_json_object(obj["text"])
                if cand:
                    last = cand
        if last:
            return last

    fence = re.search(r"```(?:json)?\s*(\{[\s\S]*?\})\s*```", text)
    if fence:
        try:
            got = from_dict(json.loads(fence.group(1)))
            if got:
                return got
        except json.JSONDecodeError:
            pass

    match = re.search(r"\{[\s\S]*\}", text)
    if match:
        try:
            got = from_dict(json.loads(match.group(0)))
            if got:
                return got
        except json.JSONDecodeError:
            pass

    # Brace-depth scan: finds the first balanced {...} object rather than greedily grabbing
    # from the first "{" to the LAST "}" in the whole text - handles trailing prose that
    # itself contains braces (e.g. "the code {shown above} looks fine"), which both the
    # regex above and a naive find('{')/rfind('}') slice get wrong.
    start = text.find("{")
    if start != -1:
        depth = 0
        in_string = False
        escape = False
        for i in range(start, len(text)):
            ch = text[i]
            if escape:
                escape = False
                continue
            if ch == "\\":
                escape = True
                continue
            if ch == '"':
                in_string = not in_string
                continue
            if in_string:
                continue
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        got = from_dict(json.loads(text[start:i + 1]))
                        if got:
                            return got
                    except json.JSONDecodeError:
                        pass
                    break
    return None


def resolve_transport(provider: str, explicit: Optional[str] = None) -> str:
    env_name = PROVIDER_CLI.get(provider, (None, None, None))[1]
    raw = (explicit or (os.environ.get(env_name) if env_name else None) or "auto").strip().lower()
    if raw not in ("api", "cli", "auto"):
        raw = "auto"
    cli_name = PROVIDER_CLI[provider][0]
    has_cli = bool(find_cli(cli_name))
    has_key = bool(os.environ.get(API_KEY_ENV[provider], "").strip())
    if raw == "cli":
        return "cli" if has_cli else "none"
    if raw == "api":
        return "api" if has_key else "none"
    if has_cli:
        return "cli"
    if has_key:
        return "api"
    return "none"


def resolve_cli_model(provider: str, explicit: Optional[str] = None) -> str:
    env_name = CLI_MODEL_ENV.get(provider)
    raw = (explicit or (os.environ.get(env_name) if env_name else None) or "").strip()
    return raw or CLI_MODEL_DEFAULTS.get(provider, "")


class CliReviewer:
    def __init__(self, provider: str, binary: str, model: str = None, timeout: int = 240):
        self.provider = provider
        self.binary = binary
        self.cli_model = model or resolve_cli_model(provider)
        self.model = f"{PROVIDER_CLI[provider][0]}-cli:{self.cli_model}" if self.cli_model else f"{PROVIDER_CLI[provider][0]}-cli"
        self.timeout = timeout

    @staticmethod
    def _normalize_usage(raw_usage: dict) -> dict:
        """Each CLI's usage envelope uses different key names - normalize to one shape."""
        if not isinstance(raw_usage, dict):
            return {"input_tokens": 0, "output_tokens": 0}
        input_tokens = raw_usage.get("input_tokens", raw_usage.get("prompt_tokens", 0)) or 0
        output_tokens = raw_usage.get("output_tokens", raw_usage.get("completion_tokens", 0)) or 0
        return {"input_tokens": input_tokens, "output_tokens": output_tokens}

    async def _run(self, argv: list, cwd: Path, stdin_text: Optional[str] = None, plain_text: bool = False) -> tuple:
        """Returns (text, usage_dict). usage_dict is {"input_tokens": N, "output_tokens": N},
        zeroed if the CLI's envelope didn't carry usage (or stdout wasn't JSON at all)."""
        env = os.environ.copy()
        if self.provider == "anthropic":
            env.pop("ANTHROPIC_API_KEY", None)
        if self.provider == "xai":
            env.pop("XAI_API_KEY", None)
        if self.provider == "openai":
            env.pop("OPENAI_API_KEY", None)

        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.PIPE if stdin_text is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            cwd=str(cwd),
        )
        try:
            in_bytes = stdin_text.encode("utf-8") if stdin_text is not None else None
            stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(input=in_bytes), timeout=self.timeout)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.communicate()
            raise TimeoutError(f"{self.model} CLI timed out after {self.timeout}s")

        stdout = (stdout_b or b"").decode("utf-8", errors="replace")
        stderr = (stderr_b or b"").decode("utf-8", errors="replace")
        if proc.returncode not in (0, None) and not stdout.strip():
            raise RuntimeError(f"{self.model} CLI exited {proc.returncode}: {(stderr or stdout)[:500]}")

        no_usage = {"input_tokens": 0, "output_tokens": 0}

        # plain_text (fix mode): unwrap straight to the model's actual reply text,
        # rather than leaving JSON extraction (extract_json_object) to the caller.
        if plain_text:
            # codex --json streams one JSON object per line; the reply is the last
            # agent_message item's text, and usage is on a separate turn.completed line.
            if "\n" in stdout.strip():
                last_text = None
                usage = no_usage
                for line in stdout.splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    item = obj.get("item") if isinstance(obj, dict) else None
                    if isinstance(item, dict) and isinstance(item.get("text"), str):
                        last_text = item["text"]
                    if isinstance(obj, dict) and isinstance(obj.get("usage"), dict):
                        usage = self._normalize_usage(obj["usage"])
                if last_text is not None:
                    return last_text, usage
            try:
                envelope = json.loads(stdout.strip())
                if isinstance(envelope, dict):
                    usage = self._normalize_usage(envelope.get("usage", {}))
                    if isinstance(envelope.get("result"), str):
                        return envelope["result"], usage
                    if isinstance(envelope.get("text"), str):
                        return envelope["text"], usage
            except json.JSONDecodeError:
                pass
            if not stdout.strip() and stderr.strip():
                return stderr, no_usage
            return stdout, no_usage

        # codex --json streams one JSON object per line in review mode too (same shape as
        # plain_text above) - a single json.loads(whole stdout) always throws on multi-line
        # JSONL and falls straight to no_usage, discarding the real usage that's sitting on
        # a turn.completed line. The review body itself is still returned as raw stdout for
        # extract_json_object to unwrap (it already walks JSONL), so only usage needs scanning
        # here.
        if "\n" in stdout.strip():
            usage = no_usage
            for line in stdout.splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(obj, dict) and isinstance(obj.get("usage"), dict):
                    usage = self._normalize_usage(obj["usage"])
            if usage is not no_usage:
                return stdout, usage

        try:
            envelope = json.loads(stdout.strip())
            if isinstance(envelope, dict):
                usage = self._normalize_usage(envelope.get("usage", {}))
                if isinstance(envelope.get("structured_output"), (dict, list)):
                    return json.dumps(envelope["structured_output"]), usage
                if isinstance(envelope.get("result"), str):
                    return envelope["result"], usage
                # Keep full Grok envelope so extract_json_object can unwrap .text
                if "text" in envelope or "issues" in envelope:
                    return stdout, usage
        except json.JSONDecodeError:
            pass

        if not stdout.strip() and stderr.strip():
            return stderr, no_usage
        return stdout, no_usage

    async def _call_api(self, prompt: str, mode: str = "review") -> tuple:
        """Returns (text, usage_dict) - usage_dict is {"input_tokens": N, "output_tokens": N},
        zeroed when the underlying CLI's envelope didn't carry usage for that call shape."""
        work_dir = Path(tempfile.mkdtemp(prefix="ai-council-cli-"))
        prompt_path = work_dir / "prompt.txt"
        try:
            prompt_path.write_text(prompt, encoding="utf-8")
            plain_text = mode != "review"

            if self.provider == "anthropic":
                argv = [
                    self.binary, "-p",
                    "--output-format", "json",
                    "--permission-mode", "bypassPermissions",
                    "--allowedTools", "Read",
                ]
                if plain_text:
                    user = (
                        "Read prompt.txt in the current working directory and follow its "
                        "instructions exactly. Respond with exactly what it asks for."
                    )
                    argv[2:2] = [user]
                else:
                    schema = json.dumps(REVIEW_JSON_SCHEMA, separators=(",", ":"))
                    user = (
                        "Read prompt.txt in the current working directory and follow it exactly. "
                        "It contains the code to review and the required JSON schema. "
                        "Return ONLY the JSON object."
                    )
                    argv[2:2] = [user]
                    argv.extend(["--json-schema", schema])
                if self.cli_model:
                    argv.extend(["--model", self.cli_model])
                return await self._run(argv, work_dir, plain_text=plain_text)

            if self.provider == "xai":
                argv = [
                    self.binary,
                    "--prompt-file", str(prompt_path),
                    "--output-format", "json",
                    "--always-approve",
                    "--cwd", str(work_dir),
                ]
                if self.cli_model:
                    argv.extend(["-m", self.cli_model])
                return await self._run(argv, work_dir, plain_text=plain_text)

            # openai / codex
            argv = [self.binary, "exec", "--skip-git-repo-check", "--json"]
            if self.cli_model:
                argv.extend(["-m", self.cli_model])
            argv.append("-")
            return await self._run(argv, work_dir, stdin_text=prompt, plain_text=plain_text)
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)

    async def review(self, code: str, file_path: str, scope: str = None) -> dict:
        max_chars = 40000
        body = code if len(code) <= max_chars else code[:max_chars] + "\n...(truncated for CLI review)..."
        prompt = (
            f"{build_review_prompt(scope)}\n\n"
            f"File: {file_path}\n\n"
            f"```\n{body}\n```\n\n"
            "IMPORTANT: Respond with ONLY valid JSON matching the schema above. "
            "No markdown fences, no preamble."
        )
        try:
            raw, usage = await self._call_api(prompt)
            parsed = extract_json_object(raw)
            if not parsed or "issues" not in parsed:
                return {
                    "error": f"CLI returned unparseable review ({self.model})",
                    "issues": [],
                    "quality_score": 0,
                    "raw_preview": (raw or "")[:500],
                }
            parsed.setdefault("summary", "")
            parsed.setdefault("quality_score", 5)
            parsed["_transport"] = "cli"
            parsed["_cli_model"] = self.cli_model
            # Key names match every API-based reviewer's _usage shape (input_tokens/
            # output_tokens) - this used to be {"input", "output", "cost"} instead, which
            # generate_html_report's usage_by_model reader (input_tokens/output_tokens) never
            # matched, so every CLI seat's real, captured usage silently rendered as 0 in the
            # report despite being correctly recorded in the database the whole time.
            parsed["_usage"] = {"input_tokens": usage["input_tokens"], "output_tokens": usage["output_tokens"]}
            return parsed
        except Exception as e:
            return {"error": str(e), "issues": [], "quality_score": 0, "_transport": "cli"}
