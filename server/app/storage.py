"""S3-compatible object storage: MinIO in local dev, Cloudflare R2 everywhere else (D67).

`python -m app.storage check` writes, reads and deletes one object to prove the
credentials and bucket in `.env` work (docs/ops.md, provisioning step).
"""

import sys
import uuid

import boto3
from botocore.config import Config

from app.config import settings


def client():
    return boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint,
        aws_access_key_id=settings.s3_access_key,
        aws_secret_access_key=settings.s3_secret_key,
        region_name=settings.s3_region,
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
    )


def check() -> None:
    s3 = client()
    key = f"_health/{uuid.uuid4()}"
    body = b"field-survey storage check"
    s3.put_object(Bucket=settings.s3_bucket, Key=key, Body=body)
    got = s3.get_object(Bucket=settings.s3_bucket, Key=key)["Body"].read()
    s3.delete_object(Bucket=settings.s3_bucket, Key=key)
    if got != body:
        raise SystemExit("storage check: read-back mismatch")
    print(f"storage ok: {settings.s3_endpoint} bucket={settings.s3_bucket}")


if __name__ == "__main__":
    if sys.argv[1:] != ["check"]:
        raise SystemExit("usage: python -m app.storage check")
    check()
