"""FastAPI app: serves the dashboard + the JSON contract + feedback writes.

  uvicorn engine.api:app --reload --port 8000   ->  open http://localhost:8000

Keeping the backend in Python means the feedback loop writes straight to the same
SQLite ledger the scoring engine reads — no second runtime, no sync layer.
"""
from __future__ import annotations

import json

import shutil

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import ledger
from .config import DASHBOARD_JSON, ROOT

app = FastAPI(title="Global Index Valuation Agent")
DASHBOARD_DIR = ROOT / "dashboard"


@app.get("/api/dashboard")
def dashboard():
    if not DASHBOARD_JSON.exists():
        return JSONResponse({"error": "No data yet. Run: python -m engine.cli refresh"}, status_code=404)
    return JSONResponse(json.loads(DASHBOARD_JSON.read_text()))


@app.get("/api/accuracy")
def accuracy():
    return ledger.accuracy_summary()


class Feedback(BaseModel):
    kind: str            # 'market' | 'insight'
    target: str          # market key or insight title
    signal: str          # 'pin' | 'dismiss' | 'up' | 'down'
    note: str = ""


@app.post("/api/feedback")
def feedback(fb: Feedback):
    ledger.add_feedback(fb.kind, fb.target, fb.signal, fb.note)
    return {"ok": True, "weights": ledger.feedback_weights()}


class RefreshReq(BaseModel):
    use_cache: bool = True
    with_llm: bool = True


@app.post("/api/refresh")
def refresh(req: RefreshReq):
    from .pipeline import run

    payload = run(use_cache=req.use_cache, with_llm=req.with_llm)
    # Mirror the fresh snapshot into the static dir so the hosted site picks it up.
    try:
        shutil.copyfile(DASHBOARD_JSON, DASHBOARD_DIR / "dashboard_data.json")
    except Exception:
        pass
    return {"ok": True, "asof": payload["asof"], "universe_size": payload["universe_size"]}


# Serve the dashboard from root so the SAME relative asset paths work both here
# and on Vercel static hosting. API routes above are matched first.
if DASHBOARD_DIR.exists():
    app.mount("/", StaticFiles(directory=str(DASHBOARD_DIR), html=True), name="dashboard")
