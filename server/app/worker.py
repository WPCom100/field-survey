import json
import logging
import time

from app.config import settings

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("worker")


def main() -> None:
    while True:
        log.info(json.dumps({"event": "heartbeat", "concurrency": settings.worker_concurrency}))
        time.sleep(60)


if __name__ == "__main__":
    main()
