"""Rule parameters on the server (T102, D176, D211).

The rules run on the iPad only (D24); the server stores `rule_param` rows like any record and
does one thing with them: project creation copies the app-level defaults (and a source
project's values) into the new project (`projects._copy`). Row ids are a hash of (scope,
rule_id, key), the same function as `ruleParamId` in `packages/rules/src/params.ts`, so a copied
row and a row an iPad creates for the same parameter are one row (D169).
"""

import hashlib
import uuid


def rule_param_id(project_id: uuid.UUID | str | None, rule_id: str, key: str) -> uuid.UUID:
    """RFC 9562 version 8 from the first 122 bits of SHA-256 (as `hashUuid` in packages/rules)."""
    scope = str(project_id) if project_id is not None else "app"
    text = "\0".join(["field-survey:rule_param", scope, rule_id, key])
    b = list(hashlib.sha256(text.encode("utf-8")).hexdigest()[:32])
    b[12] = "8"
    b[16] = "89ab"[int(b[16], 16) & 3]
    return uuid.UUID("".join(b))
