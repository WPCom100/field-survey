"""The worker loop: queued jobs every few seconds, backups and a heartbeat once a minute.

One job at a time (`WORKER_CONCURRENCY=1`, D67). A job that fails is recorded on its batch and
never stops the loop (CLAUDE.md §5: fail loudly in tests, degrade quietly in the field).
"""

import json
import logging
import time

from app import backup
from app.config import settings
from app.db import SessionLocal
from app.jobs import bom, exports, plans, riser, runner
from app.storage import get_object_store

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("worker")

JOB_POLL_SECONDS = 5
HEARTBEAT_EVERY = 12  # polls → once a minute


def main() -> None:
    tick = 0
    exports.recover_interrupted(SessionLocal)  # a deploy restarted a running export (T93)
    while True:
        if tick % HEARTBEAT_EVERY == 0:
            log.info(json.dumps({"event": "heartbeat", "concurrency": settings.worker_concurrency}))
            backup.tick()
            exports.daily_tick(SessionLocal, get_object_store())  # D149 daily export backup
        try:
            runner.run_queued(SessionLocal, get_object_store(), limit=settings.worker_concurrency)
            plans.run_queued(SessionLocal, get_object_store(), limit=settings.worker_concurrency)
            bom.run_queued(SessionLocal, get_object_store(), limit=settings.worker_concurrency)
            riser.run_queued(SessionLocal, get_object_store(), limit=settings.worker_concurrency)
            exports.run_queued(SessionLocal, get_object_store(), limit=settings.worker_concurrency)
        except Exception as e:  # noqa: BLE001 - the loop must survive a bad database moment
            log.error(json.dumps({"event": "jobs_tick_failed", "error": repr(e)}))
        time.sleep(JOB_POLL_SECONDS)
        tick += 1


if __name__ == "__main__":
    main()
