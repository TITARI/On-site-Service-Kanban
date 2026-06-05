#!/usr/bin/env python
"""Small wxauto REST shim for the local watchtower bridge.

It exposes the subset used by scripts/wxauto-rest-bridge.mjs:
- POST /v1/wechat/initialize
- POST /v1/wechat/getnextnewmessage
- POST /v1/wechat/send
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

from wxauto import WeChat

try:
    import pythoncom
except ImportError:  # pragma: no cover - pywin32 is a wxauto dependency on Windows.
    pythoncom = None


wx: WeChat | None = None


def get_wx() -> WeChat:
    global wx
    if wx is None:
        wx = WeChat()
    return wx


def message_to_dict(message: Any, chat_name: str) -> dict[str, Any]:
    content = str(getattr(message, "content", "") or "")
    sender = str(getattr(message, "sender", "") or chat_name)
    message_id = str(getattr(message, "id", "") or "")
    message_type = str(getattr(message, "type", "") or "message")
    is_group = bool(sender and sender != chat_name)
    sender_id = "" if is_group else f"wechat-direct:{chat_name}"
    is_self = sender.lower() == "self"
    is_system = sender.upper() in {"SYS", "SYSTEM"}
    return {
        "id": message_id or f"{chat_name}-{sender}-{hash(content)}-{int(time.time() * 1000)}",
        "msg_id": message_id,
        "type": message_type,
        "sender": sender,
        "sender_id": sender_id,
        "sender_name": sender,
        "is_self": is_self,
        "is_system": is_system,
        "content": content,
        "text": content,
        "time": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "chat_name": chat_name,
        "source_conversation_id": chat_name,
        "is_group": is_group,
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "WxautoLocalRest/0.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stdout.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))
        sys.stdout.flush()

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length") or "0")
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def write_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authorized(self) -> bool:
        token = os.environ.get("WXAUTO_REST_TOKEN", "")
        if not token:
            return True
        authorization = self.headers.get("authorization", "")
        return authorization == f"Bearer {token}"

    def do_GET(self) -> None:
        if self.path in {"/", "/health"}:
            self.write_json(200, {"success": True, "message": "ok"})
            return
        self.write_json(404, {"success": False, "message": "not found"})

    def do_POST(self) -> None:
        if not self.authorized():
            self.write_json(401, {"success": False, "message": "unauthorized"})
            return

        try:
            body = self.read_json()
            if self.path == "/v1/wechat/initialize":
                get_wx()
                self.write_json(200, {"success": True, "message": "initialized"})
                return

            if self.path == "/v1/wechat/getnextnewmessage":
                timeout = float(body.get("timeout", 1))
                raw = get_wx().GetNextNewMessage(timeout=timeout)
                messages: list[dict[str, Any]] = []
                chat_info: dict[str, Any] = {}
                if isinstance(raw, dict):
                    for chat_name, chat_messages in raw.items():
                        chat_info = {"chat_name": chat_name, "who": chat_name, "name": chat_name}
                        for message in chat_messages or []:
                            item = message_to_dict(message, chat_name)
                            messages.append(item)
                self.write_json(200, {"success": True, "data": {"messages": messages, "chat_info": chat_info}})
                return

            if self.path == "/v1/wechat/send":
                who = str(body.get("who") or "").strip()
                msg = str(body.get("msg") or body.get("text") or "").strip()
                clear = bool(body.get("clear", True))
                if not who or not msg:
                    self.write_json(400, {"success": False, "message": "who and msg are required"})
                    return
                get_wx().SendMsg(msg, who=who, clear=clear)
                self.write_json(200, {"success": True, "data": {"who": who}})
                return

            self.write_json(404, {"success": False, "message": "not found"})
        except Exception as error:
            traceback.print_exc()
            self.write_json(500, {"success": False, "message": str(error)})


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.environ.get("WXAUTO_REST_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("WXAUTO_REST_PORT", "8001")))
    args = parser.parse_args()

    if pythoncom is not None:
        pythoncom.CoInitialize()

    server = HTTPServer((args.host, args.port), Handler)
    print(f"[wxauto-local-rest] listening on http://{args.host}:{args.port}")
    sys.stdout.flush()
    server.serve_forever()


if __name__ == "__main__":
    main()
