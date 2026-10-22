"""Wake jobs: a command an MCP server config runs when Restart is pressed (e.g. bring up the GPU server it draws on).

The command runs in a background thread (subprocess, output read line by line). It reports progress with lines

    ##progress <percent> <eta_seconds> <stage text>

and anything else it prints is kept as the tail. Without progress lines, the estimate is the duration of the last
successful runs (kept per server). When the command exits 0 the server's on_done callback reconnects it.
"""

from __future__ import annotations

import asyncio
import collections
import json
import logging
import os
import re
import statistics
import subprocess
import sys
import threading
import time
from typing import Any, Awaitable, Callable, Optional

log = logging.getLogger("missile.wake")

PROGRESS = re.compile(r"^##progress\s+(\d{1,3})\s+(-?\d+)\s*(.*)$")
HISTORY_KEEP = 5


class WakeJob:
    def __init__(self, server: str, command: str, cwd: str, timeout: float, expected_s: Optional[float]):
        self.server = server
        self.command = command
        self.cwd = cwd
        self.timeout = timeout
        self.expected_s = expected_s  # from earlier successful runs, None the first time
        self.state = "running"  # running | reconnecting | done | failed | cancelled
        self.started_at = time.time()
        self.finished_at: Optional[float] = None
        self.pct: Optional[int] = None
        self.eta_s: Optional[int] = None
        self.eta_at: float = 0.0
        self.stage = "starting"
        self.tail: collections.deque = collections.deque(maxlen=40)
        self.rc: Optional[int] = None
        self.proc: Optional[subprocess.Popen] = None
        self.saw_progress = False

    def view(self) -> dict:
        now = self.finished_at or time.time()
        elapsed = now - self.started_at
        pct, eta = self.pct, None
        if self.state == "running":
            if self.eta_s is not None:  # the command's own estimate, counted down since it was printed
                eta = max(0, int(self.eta_s - (now - self.eta_at)))
            elif self.expected_s:
                eta = max(0, int(self.expected_s - elapsed))
                if pct is None:
                    pct = min(95, int(100 * elapsed / self.expected_s))
        elif self.state in ("done", "reconnecting"):
            pct, eta = 100, 0
        return {
            "server": self.server, "state": self.state, "stage": self.stage, "pct": pct, "eta_s": eta,
            "elapsed_s": int(elapsed), "expected_s": int(self.expected_s) if self.expected_s else None,
            "started_at": self.started_at, "finished_at": self.finished_at, "rc": self.rc, "tail": list(self.tail)[-12:],
        }


class WakeManager:
    def __init__(self, get_setting: Callable[[str, Any], Any], set_setting: Callable[[str, Any], None],
                 on_done: Callable[[str, bool], Awaitable[None]]):
        self.get_setting = get_setting
        self.set_setting = set_setting
        self.on_done = on_done
        self.jobs: dict[str, WakeJob] = {}
        self.loop: Optional[asyncio.AbstractEventLoop] = None

    # ------------------------------------------------------------ history (what to expect next time)
    def _history(self, server: str) -> list[float]:
        raw = self.get_setting(f"wake_history:{server}", None)
        try:
            vals = json.loads(raw) if isinstance(raw, str) else (raw or [])
            return [float(v) for v in vals][-HISTORY_KEEP:]
        except Exception:
            return []

    def expected(self, server: str) -> Optional[float]:
        h = self._history(server)
        return statistics.median(h) if h else None

    def _remember(self, server: str, seconds: float) -> None:
        h = (self._history(server) + [round(seconds, 1)])[-HISTORY_KEEP:]
        self.set_setting(f"wake_history:{server}", h)  # the store JSON-encodes values itself

    # ------------------------------------------------------------ jobs
    def start(self, server: str, command: str, cwd: str = "", timeout: float = 2400.0) -> WakeJob:
        cur = self.jobs.get(server)
        if cur and cur.state in ("running", "reconnecting"):
            return cur  # pressing Restart again while waking just shows the same job
        self.loop = asyncio.get_running_loop()
        job = WakeJob(server, command, cwd, timeout, self.expected(server))
        self.jobs[server] = job
        threading.Thread(target=self._run, args=(job,), name=f"wake-{server}", daemon=True).start()
        return job

    def cancel(self, server: str) -> bool:
        job = self.jobs.get(server)
        if not job or job.state != "running":
            return False
        job.state = "cancelled"
        self._kill(job)
        return True

    def status(self) -> list[dict]:
        return [j.view() for j in self.jobs.values()]

    def _kill(self, job: WakeJob) -> None:
        p = job.proc
        if not p or p.poll() is not None:
            return
        try:
            if os.name == "nt":  # the shell's children (python …) too, not just cmd.exe
                subprocess.run(["taskkill", "/T", "/F", "/PID", str(p.pid)], capture_output=True, timeout=20)
            else:
                p.kill()
        except Exception:  # pragma: no cover
            pass

    def _run(self, job: WakeJob) -> None:
        env = {**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
        try:
            job.proc = subprocess.Popen(job.command, shell=True, cwd=job.cwd or None, env=env, stdin=subprocess.DEVNULL,
                                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        except Exception as e:
            job.state, job.stage, job.finished_at = "failed", f"could not start: {e}", time.time()
            self._finish(job, False)
            return
        timer = threading.Timer(job.timeout, lambda: (job.tail.append(f"[timeout after {int(job.timeout)}s]"), self._kill(job)))
        timer.daemon = True
        timer.start()
        try:
            assert job.proc.stdout is not None
            for raw in iter(job.proc.stdout.readline, b""):
                line = raw.decode("utf-8", "replace").rstrip()
                if not line:
                    continue
                m = PROGRESS.match(line)
                if m:
                    job.saw_progress = True
                    job.pct = max(0, min(100, int(m.group(1))))
                    job.eta_s, job.eta_at = int(m.group(2)), time.time()
                    if m.group(3).strip():
                        job.stage = m.group(3).strip()[:200]
                else:
                    job.tail.append(line[:400])
                    if job.pct is None:  # no progress protocol: the latest line is the best stage we have
                        job.stage = line[:200]
            job.rc = job.proc.wait()
        finally:
            timer.cancel()
        job.finished_at = time.time()
        if job.state != "cancelled":
            # exit 0 → "reconnecting" until on_done has reconnected the server, then "done"
            job.state = "reconnecting" if job.rc == 0 else "failed"
            if job.rc != 0 and not job.stage.startswith("exit"):
                job.stage = f"exit {job.rc}: {job.stage}"[:200]
        ok = job.state == "reconnecting"
        if ok and not job.saw_progress:
            # only commands without progress lines need our estimate; one that reports its own progress keeps its
            # own history (and a quick "already awake" run would otherwise make the next cold wake look like seconds)
            self._remember(job.server, job.finished_at - job.started_at)
        self._finish(job, ok)

    def _finish(self, job: WakeJob, ok: bool) -> None:
        if self.loop is None:
            return
        try:
            asyncio.run_coroutine_threadsafe(self._after(job, ok), self.loop)
        except Exception:  # pragma: no cover
            log.exception("wake on_done failed")

    async def _after(self, job: WakeJob, ok: bool) -> None:
        try:
            await self.on_done(job.server, ok)
        finally:
            if job.state == "reconnecting":
                job.state = "done"


def python_cmd(script: str, *args: str) -> str:
    """A shell command line running a Python script with this interpreter (handy for tests and docs)."""
    q = lambda s: f'"{s}"' if " " in s else s  # noqa: E731
    return " ".join([q(sys.executable), "-u", q(script), *map(q, args)])
