"""Test-only HTTP/1.1 and Server-Sent Events client for the P-7 Nginx checks. Standard library only.

A raw socket, because the checks need what a high-level client hides: the time each event reaches the client, whether
the response is chunked, the exact response headers, and the moment the server closes the connection. Every read has a
deadline, so no check can hang.
"""
from __future__ import annotations

import json
import socket
import time


class Response:
    """One request on its own connection (`Connection: close`). Events are read lazily with `events(until)`."""

    def __init__(self, host: str, port: int, path: str, method: str = "GET", headers: dict | None = None, timeout: float = 10.0):
        self.sock = socket.create_connection((host, port), timeout=timeout)
        self.sent_at = time.time()
        lines = [f"{method} {path} HTTP/1.1", f"Host: {host}:{port}", "Accept: text/event-stream", "Connection: close"]
        lines += [f"{k}: {v}" for k, v in (headers or {}).items()]
        self.sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
        self.buf = b""
        self.eof = False
        self.closed_at: float | None = None
        self.status = 0
        self.headers: dict[str, str] = {}
        self.headers_at: float | None = None
        self._read_headers(timeout)
        self._chunked = self.headers.get("transfer-encoding", "").lower() == "chunked"
        self._raw = self.buf  # bytes after the headers
        self.buf = b""
        self._text = b""
        self._pending_chunks = self._raw

    # ---- low level -----------------------------------------------------------------------------------------------
    def _recv(self, wait: float) -> bytes:
        if self.eof:
            return b""
        self.sock.settimeout(max(wait, 0.001))
        try:
            data = self.sock.recv(65536)
        except socket.timeout:
            return b""
        except OSError:
            data = b""
        if data == b"":
            self.eof = True
            self.closed_at = time.time()
        return data

    def _read_headers(self, timeout):
        deadline = time.time() + timeout
        while b"\r\n\r\n" not in self.buf and time.time() < deadline and not self.eof:
            self.buf += self._recv(min(0.5, deadline - time.time()))
        if b"\r\n\r\n" not in self.buf:
            raise TimeoutError("no response headers")
        head, _, self.buf = self.buf.partition(b"\r\n\r\n")
        self.headers_at = time.time()
        first, *rest = head.decode("latin-1").split("\r\n")
        self.status = int(first.split()[1])
        for line in rest:
            k, _, v = line.partition(":")
            self.headers[k.strip().lower()] = v.strip()

    def _decode(self, data: bytes) -> bytes:
        """Decode as much chunked (or identity) body as `data` completes; keep the remainder."""
        self._pending_chunks += data
        if not self._chunked:
            out, self._pending_chunks = self._pending_chunks, b""
            return out
        out = b""
        while True:
            line, sep, rest = self._pending_chunks.partition(b"\r\n")
            if not sep:
                break
            size = int(line.split(b";")[0] or b"0", 16)
            if size == 0:
                self._pending_chunks = b""
                self.eof = True
                self.closed_at = self.closed_at or time.time()
                break
            if len(rest) < size + 2:
                break
            out += rest[:size]
            self._pending_chunks = rest[size + 2:]
        return out

    # ---- public --------------------------------------------------------------------------------------------------
    def events(self, until: float, stop_after: int | None = None):
        """Yield (arrival_time, event_name, data) for each complete event until `until`, EOF or `stop_after` events."""
        first = self._decode(b"")
        self._text += first
        count = 0
        while True:
            while b"\n\n" in self._text.replace(b"\r\n", b"\n"):
                text = self._text.replace(b"\r\n", b"\n")
                block, _, rest = text.partition(b"\n\n")
                self._text = rest
                name, data = "message", []
                for line in block.decode("utf-8").split("\n"):
                    if line.startswith(":"):
                        continue
                    k, _, v = line.partition(":")
                    v = v[1:] if v.startswith(" ") else v
                    if k == "event":
                        name = v
                    elif k == "data":
                        data.append(v)
                yield time.time(), name, "\n".join(data)
                count += 1
                if stop_after is not None and count >= stop_after:
                    return
            if self.eof or time.time() >= until:
                return
            self._text += self._decode(self._recv(min(0.25, until - time.time())))

    def body(self, timeout: float = 10.0) -> bytes:
        """The whole (non-stream) body, until EOF or the deadline."""
        deadline = time.time() + timeout
        out = self._decode(b"")
        while not self.eof and time.time() < deadline:
            out += self._decode(self._recv(min(0.25, deadline - time.time())))
        return out

    def json(self, timeout: float = 10.0):
        return json.loads(self.body(timeout))

    def wait_closed(self, until: float) -> float | None:
        """Block (bounded) until the server ends the connection; return the time it did, else None."""
        while not self.eof and time.time() < until:
            self._decode(self._recv(min(0.25, until - time.time())))
        return self.closed_at

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def get_json(host, port, path, headers=None, timeout=10.0):
    with Response(host, port, path, headers=headers, timeout=timeout) as r:
        return r.status, r.headers, r.json(timeout)
