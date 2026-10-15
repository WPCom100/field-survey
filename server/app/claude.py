"""The Claude API for extraction (PLAN §7.1, D21, D189): one structured-output call per crop.

The key comes from the server `.env` only (`ANTHROPIC_API_KEY`, never the repo, CI or the iPad);
the model is `CLAUDE_MODEL` (Opus 5.5 by default). Every call logs its tokens and cost from
`response.usage` (`claude_call` events) and the caller sums them per job.

Tests never call the API: a `Recorder` replays committed answers keyed by a hash of the request
(model, system, prompt, schema, image bytes). With `RISER_RECORD=1` and a key in `.env`, a missing
answer is fetched live and written to the recording so it can be committed (D189 (1): CI runs
against committed golden outputs and skips live calls when the key is absent).
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.config import settings

log = logging.getLogger("claude")

PRICES_PER_MTOK: dict[str, tuple[float, float]] = {
    "claude-opus-5-5": (4.0, 20.0),
    "claude-fable-5-1": (10.0, 50.0),
    "claude-sonnet-5-5": (2.0, 10.0),
    "claude-haiku-5-5": (0.10, 0.50),
}
"""Input / output USD per million tokens (D189; Phase 1f §5 sources, 2026-10-09)."""

DEFAULT_MAX_TOKENS = 16000
EFFORT = "high"
"""Extraction is intelligence-sensitive and short: the skill's floor for such work."""


class ClaudeError(Exception):
    """The API refused, returned no JSON, or is not configured."""


@dataclass
class Answer:
    data: dict[str, Any]
    model: str
    input_tokens: int
    output_tokens: int
    cost_usd: float | None
    request_id: str | None
    replayed: bool

    def out(self) -> dict[str, Any]:
        return {
            "model": self.model,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cost_usd": self.cost_usd,
            "replayed": self.replayed,
        }


def cost_of(model: str, input_tokens: int, output_tokens: int) -> float | None:
    prices = PRICES_PER_MTOK.get(model)
    if prices is None:
        return None
    return round((input_tokens * prices[0] + output_tokens * prices[1]) / 1_000_000, 6)


def request_key(
    model: str, system: str, prompt: str, schema: dict[str, Any], images: list[bytes]
) -> str:
    h = hashlib.sha256()
    h.update(
        json.dumps(
            {"model": model, "system": system, "prompt": prompt, "schema": schema},
            sort_keys=True,
        ).encode()
    )
    for img in images:
        h.update(hashlib.sha256(img).digest())
    return h.hexdigest()


class Recorder:
    """Recorded answers: `{key: {data, model, input_tokens, output_tokens, label}}`."""

    def __init__(self, path: Path, record: bool = False):
        self.path = path
        self.record = record
        self.entries: dict[str, dict[str, Any]] = {}
        self.dirty = False
        if path.exists():
            self.entries = json.loads(path.read_text(encoding="utf-8"))

    def get(self, key: str) -> dict[str, Any] | None:
        return self.entries.get(key)

    def put(self, key: str, entry: dict[str, Any]) -> None:
        self.entries[key] = entry
        self.dirty = True

    def save(self) -> None:
        if self.dirty:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(
                json.dumps(self.entries, indent=1, sort_keys=True) + "\n", encoding="utf-8"
            )
            self.dirty = False


class Claude:
    """Structured extraction calls. `available()` is false without a key (and no recording)."""

    def __init__(
        self,
        api_key: str | None = None,
        model: str | None = None,
        recorder: Recorder | None = None,
    ):
        self.api_key = settings.anthropic_api_key if api_key is None else api_key
        self.model = model or settings.claude_model
        self.recorder = recorder
        self._client: Any = None
        self.calls = 0
        self.input_tokens = 0
        self.output_tokens = 0
        self.cost_usd = 0.0
        self.replayed = 0

    def available(self) -> bool:
        return bool(self.api_key) or self.recorder is not None

    def totals(self) -> dict[str, Any]:
        return {
            "model": self.model,
            "calls": self.calls,
            "replayed": self.replayed,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cost_usd": round(self.cost_usd, 4),
        }

    def _sdk(self) -> Any:
        if self._client is None:
            import anthropic

            self._client = anthropic.Anthropic(api_key=self.api_key, max_retries=3)
        return self._client

    def extract(
        self,
        *,
        system: str,
        prompt: str,
        schema: dict[str, Any],
        images: list[bytes] | None = None,
        label: str = "",
        max_tokens: int = DEFAULT_MAX_TOKENS,
    ) -> Answer:
        """One request → the JSON object the schema describes. PNG images go before the text."""
        images = images or []
        key = request_key(self.model, system, prompt, schema, images)
        if self.recorder is not None and (hit := self.recorder.get(key)) is not None:
            answer = Answer(
                data=hit["data"],
                model=hit.get("model", self.model),
                input_tokens=int(hit.get("input_tokens", 0)),
                output_tokens=int(hit.get("output_tokens", 0)),
                cost_usd=cost_of(
                    hit.get("model", self.model),
                    int(hit.get("input_tokens", 0)),
                    int(hit.get("output_tokens", 0)),
                ),
                request_id=None,
                replayed=True,
            )
            self._count(answer, label)
            return answer
        if not self.api_key:
            raise ClaudeError(
                "no ANTHROPIC_API_KEY in the server .env"
                + (" and no recorded answer" if self.recorder is not None else "")
            )
        if self.recorder is not None and not self.recorder.record:
            raise ClaudeError(
                f"no recorded answer for {label or key[:12]} (RISER_RECORD=1 records)"
            )
        answer = self._call(system, prompt, schema, images, max_tokens)
        if self.recorder is not None:
            self.recorder.put(
                key,
                {
                    "label": label,
                    "model": answer.model,
                    "input_tokens": answer.input_tokens,
                    "output_tokens": answer.output_tokens,
                    "data": answer.data,
                },
            )
            self.recorder.save()  # write-through: a paid answer is never lost to a later failure
        self._count(answer, label)
        return answer

    def _count(self, answer: Answer, label: str) -> None:
        self.calls += 1
        self.replayed += int(answer.replayed)
        self.input_tokens += answer.input_tokens
        self.output_tokens += answer.output_tokens
        self.cost_usd += answer.cost_usd or 0.0
        log.info(
            json.dumps(
                {
                    "event": "claude_call",
                    "label": label,
                    "request_id": answer.request_id,
                    **answer.out(),
                }
            )
        )

    def _call(
        self, system: str, prompt: str, schema: dict[str, Any], images: list[bytes], max_tokens: int
    ) -> Answer:
        import anthropic

        content: list[dict[str, Any]] = [
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/png",
                    "data": base64.standard_b64encode(img).decode("ascii"),
                },
            }
            for img in images
        ]
        content.append({"type": "text", "text": prompt})
        try:
            response = self._sdk().messages.create(
                model=self.model,
                max_tokens=max_tokens,
                system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
                messages=[{"role": "user", "content": content}],
                output_config={
                    "effort": EFFORT,
                    "format": {"type": "json_schema", "schema": schema},
                },
            )
        except anthropic.AuthenticationError as e:
            raise ClaudeError(f"the Claude API key was refused: {e.message}") from e
        except anthropic.RateLimitError as e:
            raise ClaudeError(f"Claude API rate limit: {e.message}") from e
        except anthropic.APIStatusError as e:
            raise ClaudeError(f"Claude API error {e.status_code}: {e.message}") from e
        except anthropic.APIConnectionError as e:
            raise ClaudeError(f"Claude API unreachable: {e}") from e
        if response.stop_reason == "refusal":
            detail = getattr(response, "stop_details", None)
            raise ClaudeError(f"Claude refused the crop: {detail}")
        if response.stop_reason == "max_tokens":
            raise ClaudeError("Claude's answer was cut off at max_tokens")
        text = next((b.text for b in response.content if b.type == "text"), None)
        if text is None:
            raise ClaudeError("Claude returned no text block")
        try:
            data = json.loads(text)
        except ValueError as e:
            raise ClaudeError(f"Claude returned invalid JSON: {e}") from e
        usage = response.usage
        cached = (usage.cache_read_input_tokens or 0) + (usage.cache_creation_input_tokens or 0)
        input_tokens = usage.input_tokens + cached
        return Answer(
            data=data,
            model=response.model,
            input_tokens=input_tokens,
            output_tokens=usage.output_tokens,
            cost_usd=cost_of(self.model, input_tokens, usage.output_tokens),
            request_id=getattr(response, "_request_id", None),
            replayed=False,
        )


def recorder_from_env(path: Path) -> Recorder:
    """The test recorder: replay the committed file; record new answers when `RISER_RECORD=1`."""
    return Recorder(path, record=os.environ.get("RISER_RECORD") == "1")
