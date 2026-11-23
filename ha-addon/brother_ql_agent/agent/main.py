"""Brother QL print agent.

Opens an *outbound* WebSocket to the label server (through Cloudflare, authenticated with an
Access service token plus a shared agent token), waits for print jobs and prints them on a
locally attached Brother QL printer. No inbound ports are needed on this network.
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import os
import random
import signal
import socket
import sys

from PIL import Image

# brother_ql 0.9.x still references Image.ANTIALIAS, which Pillow 10 removed.
if not hasattr(Image, "ANTIALIAS"):
    Image.ANTIALIAS = Image.LANCZOS  # type: ignore[attr-defined]

from brother_ql.backends.helpers import send  # noqa: E402
from brother_ql.conversion import convert  # noqa: E402
from brother_ql.raster import BrotherQLRaster  # noqa: E402
from websockets.asyncio.client import connect  # noqa: E402
from websockets.exceptions import ConnectionClosed, InvalidStatus  # noqa: E402

VERSION = "1.0.0"
OPTIONS_PATH = os.environ.get("OPTIONS_PATH", "/data/options.json")
STATUS_INTERVAL = 30

log = logging.getLogger("agent")

# USB product IDs (vendor 0x04f9) for the printers people are most likely to have.
USB_PIDS = {
    "QL-500": 0x2015, "QL-550": 0x2016, "QL-560": 0x2027, "QL-570": 0x2028, "QL-580N": 0x2029,
    "QL-650TD": 0x201B, "QL-700": 0x2042, "QL-710W": 0x2043, "QL-720NW": 0x2044,
    "QL-800": 0x209B, "QL-810W": 0x209C, "QL-820NWB": 0x209D, "QL-1050": 0x2020,
    "QL-1060N": 0x202A, "QL-1100": 0x20A7, "QL-1110NWB": 0x20A8,
}


def load_options() -> dict:
    """Home Assistant writes add-on options to /data/options.json; env vars work for standalone use."""
    opts: dict = {}
    if os.path.exists(OPTIONS_PATH):
        with open(OPTIONS_PATH, encoding="utf-8") as fh:
            opts = json.load(fh)
    env_map = {
        "server_url": "SERVER_URL", "agent_token": "AGENT_TOKEN", "agent_id": "AGENT_ID",
        "agent_name": "AGENT_NAME", "cf_access_client_id": "CF_ACCESS_CLIENT_ID",
        "cf_access_client_secret": "CF_ACCESS_CLIENT_SECRET", "printer_model": "PRINTER_MODEL",
        "printer": "PRINTER", "log_level": "LOG_LEVEL",
    }
    for key, env in env_map.items():
        if os.environ.get(env):
            opts[key] = os.environ[env]
    opts.setdefault("agent_id", socket.gethostname())
    opts.setdefault("agent_name", opts["agent_id"])
    opts.setdefault("printer_model", "QL-700")
    opts.setdefault("printer", "")
    opts.setdefault("log_level", "info")
    return opts


class Printer:
    def __init__(self, model: str, identifier: str):
        self.model = model
        if not identifier:
            pid = USB_PIDS.get(model)
            if pid is None:
                raise SystemExit(f"Set 'printer' explicitly: no known USB id for {model}")
            identifier = f"usb://0x04f9:{pid:04x}"
        self.identifier = identifier
        if identifier.startswith("usb://"):
            self.backend = "pyusb"
        elif identifier.startswith("tcp://"):
            self.backend = "network"
        else:  # file:///dev/usb/lp0 or /dev/usb/lp0
            self.backend = "linux_kernel"
            if identifier.startswith("/"):
                self.identifier = f"file://{identifier}"
        self.lock = asyncio.Lock()

    def is_connected(self) -> bool | None:
        try:
            if self.backend == "pyusb":
                import usb.core  # pyusb

                ids = self.identifier[len("usb://"):].split("/")[0].split(":")
                vid, pid = int(ids[0], 16), int(ids[1], 16)
                return usb.core.find(idVendor=vid, idProduct=pid) is not None
            if self.backend == "linux_kernel":
                return os.path.exists(self.identifier.replace("file://", ""))
        except Exception as err:  # noqa: BLE001
            log.debug("printer detection failed: %s", err)
            return False
        return None  # network printers: unknown without probing

    def info(self) -> dict:
        return {"model": self.model, "identifier": self.identifier, "backend": self.backend,
                "connected": self.is_connected()}

    def print_png(self, png: bytes, label: str, copies: int, cut: bool) -> dict:
        image = Image.open(io.BytesIO(png))
        image.load()
        qlr = BrotherQLRaster(self.model)
        qlr.exception_on_warning = True
        instructions = convert(
            qlr=qlr,
            images=[image] * copies,
            label=label,
            rotate="0",          # the server already supplies the image in printer orientation
            threshold=70.0,
            dither=False,
            compress=False,      # QL-700 does not support compression
            red=False,
            dpi_600=False,
            hq=True,
            cut=cut,
        )
        status = send(
            instructions=instructions,
            printer_identifier=self.identifier,
            backend_identifier=self.backend,
            blocking=True,
        )
        outcome = status.get("outcome")
        if outcome == "error" or (outcome not in ("printed", "sent") and not status.get("did_print")):
            errors = (status.get("printer_state") or {}).get("errors") or []
            detail = ", ".join(errors) if errors else f"outcome={outcome}"
            raise RuntimeError(f"Printer reported a problem: {detail}")
        return {"outcome": outcome}


async def handle_print(ws, printer: Printer, msg: dict) -> None:
    job_id = msg.get("jobId")
    try:
        copies = max(1, min(int(msg.get("copies", 1)), 50))
        png = base64.b64decode(msg["image"])
        await ws.send(json.dumps({"type": "job", "jobId": job_id, "status": "printing"}))
        async with printer.lock:  # one job at a time on the USB device
            log.info("Printing job %s: %s× on %s", job_id, copies, msg.get("label"))
            detail = await asyncio.to_thread(
                printer.print_png, png, str(msg["label"]), copies, bool(msg.get("cut", True)))
        await ws.send(json.dumps({"type": "job", "jobId": job_id, "status": "done", "detail": detail}))
        log.info("Job %s done (%s)", job_id, detail.get("outcome"))
    except ConnectionClosed:
        log.warning("Connection closed while finishing job %s", job_id)
    except Exception as err:  # noqa: BLE001
        log.error("Job %s failed: %s", job_id, err)
        try:
            await ws.send(json.dumps({"type": "job", "jobId": job_id, "status": "error", "error": str(err)}))
        except ConnectionClosed:
            pass


async def status_loop(ws, printer: Printer) -> None:
    last = None
    while True:
        await asyncio.sleep(STATUS_INTERVAL)
        info = await asyncio.to_thread(printer.info)
        if info != last:
            log.info("Printer connected: %s", info["connected"])
        last = info
        await ws.send(json.dumps({"type": "status", "printer": info}))


async def session(ws, opts: dict, printer: Printer) -> None:
    await ws.send(json.dumps({
        "type": "hello", "agentId": opts["agent_id"], "name": opts["agent_name"],
        "version": VERSION, "printer": await asyncio.to_thread(printer.info),
    }))
    log.info("Connected to %s as '%s'", opts["server_url"], opts["agent_id"])
    status_task = asyncio.create_task(status_loop(ws, printer))
    jobs: set[asyncio.Task] = set()
    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            if msg.get("type") == "print":
                task = asyncio.create_task(handle_print(ws, printer, msg))
                jobs.add(task)
                task.add_done_callback(jobs.discard)
    finally:
        status_task.cancel()


def explain(err: Exception) -> str:
    if isinstance(err, InvalidStatus):
        code = err.response.status_code
        if code in (301, 302, 303, 307, 308):
            return (f"HTTP {code} redirect – Cloudflare Access sent us to a login page. Check the service "
                    "token ID/secret and that the /agent Access application uses a 'Service Auth' policy.")
        if code == 401:
            return "HTTP 401 – the label server rejected agent_token. Make sure it matches AGENT_TOKEN."
        if code == 403:
            return "HTTP 403 – Cloudflare Access denied the service token (or the server's JWT check failed)."
        if code == 404:
            return "HTTP 404 – wrong server_url path (expected .../agent)."
        return f"HTTP {code} during WebSocket handshake"
    return f"{type(err).__name__}: {err}"


async def run(opts: dict) -> None:
    printer = Printer(opts["printer_model"], opts.get("printer") or "")
    log.info("Brother QL agent %s – printer %s via %s (%s)", VERSION, printer.model, printer.identifier, printer.backend)
    log.info("Printer detected: %s", printer.is_connected())

    headers = {"Authorization": f"Bearer {opts['agent_token']}", "User-Agent": f"brother-ql-agent/{VERSION}"}
    if opts.get("cf_access_client_id"):
        headers["CF-Access-Client-Id"] = opts["cf_access_client_id"]
        headers["CF-Access-Client-Secret"] = opts.get("cf_access_client_secret", "")

    backoff = 2
    while True:
        try:
            async with connect(
                opts["server_url"],
                additional_headers=headers,
                ping_interval=20,
                ping_timeout=20,
                open_timeout=20,
                max_size=8 * 1024 * 1024,
            ) as ws:
                backoff = 2
                await session(ws, opts, printer)
                log.warning("Server closed the connection (%s %s)", ws.close_code, ws.close_reason)
        except asyncio.CancelledError:
            raise
        except Exception as err:  # noqa: BLE001
            log.error("Connection failed: %s", explain(err))
        delay = backoff + random.uniform(0, 1)
        log.info("Reconnecting in %.0fs", delay)
        await asyncio.sleep(delay)
        backoff = min(backoff * 2, 60)


def main() -> None:
    opts = load_options()
    logging.basicConfig(
        level=getattr(logging, str(opts["log_level"]).upper(), logging.INFO),
        format="%(asctime)s %(levelname)-7s %(message)s",
        stream=sys.stdout,
    )
    logging.getLogger("websockets").setLevel(logging.WARNING)
    missing = [k for k in ("server_url", "agent_token") if not opts.get(k)]
    if missing:
        log.error("Missing required option(s): %s – set them on the add-on Configuration tab.", ", ".join(missing))
        sys.exit(1)
    if not str(opts["server_url"]).startswith(("ws://", "wss://")):
        log.error("server_url must start with wss:// (e.g. wss://labels.example.com/agent)")
        sys.exit(1)

    loop = asyncio.new_event_loop()
    main_task = loop.create_task(run(opts))
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, main_task.cancel)
    try:
        loop.run_until_complete(main_task)
    except asyncio.CancelledError:
        log.info("Stopping")


if __name__ == "__main__":
    main()
