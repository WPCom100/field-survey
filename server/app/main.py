from fastapi import FastAPI

app = FastAPI(title="Field Survey")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
