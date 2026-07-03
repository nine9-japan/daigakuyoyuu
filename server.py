from __future__ import annotations

import json
import io
import base64
import mimetypes
import os
import ipaddress
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import textwrap
import uuid
import webbrowser
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib import error, parse, request


ROOT_DIR = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
RESOURCE_DIR = Path(getattr(sys, "_MEIPASS", ROOT_DIR))
PUBLIC_DIR = RESOURCE_DIR / "public"
DATA_DIR = ROOT_DIR / "data"
AUDIO_DIR = DATA_DIR / "recordings"
RECORDS_FILE = DATA_DIR / "recordings.json"
RETENTION_DAYS = 7
RETENTION = timedelta(days=RETENTION_DAYS)
RETRY_TRANSCRIPT_DAILY_LIMIT = 3
MAX_AUDIO_BYTES = 100 * 1024 * 1024
MAX_JSON_BYTES = 2 * 1024 * 1024
MAX_REMOTE_AI_JSON_BYTES = 150 * 1024 * 1024


class RequestHandled(Exception):
    pass


def main() -> None:
    load_env_file()
    ensure_storage()
    cleanup_expired_audio()

    threading.Thread(target=cleanup_loop, daemon=True).start()

    if should_run_desktop_window():
        run_desktop_window()
        return

    run_http_server()


def run_http_server() -> None:
    host = os.environ.get("HOST", "127.0.0.1" if is_frozen_app() else "0.0.0.0")
    port = int(os.environ.get("PORT", "5177"))
    server = create_http_server(host, port, allow_port_fallback=is_frozen_app())
    urls = access_urls(str(server.server_address[0]), int(server.server_address[1]))
    print(f"Recording AI Notes is running at {urls['local']}", flush=True)
    should_open_browser = os.environ.get("OPEN_BROWSER", "1" if is_frozen_app() else "").strip()
    if should_open_browser == "1":
        threading.Timer(0.8, lambda: webbrowser.open(urls["local"])).start()
    server.serve_forever()


def run_desktop_window() -> None:
    os.environ.setdefault("APP_VARIANT", "windows")
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "5177"))
    server = create_http_server(host, port, allow_port_fallback=True)
    urls = access_urls(str(server.server_address[0]), int(server.server_address[1]))
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()

    try:
        if launch_app_window(urls["local"]):
            return

        raise RuntimeError("アプリ表示に使えるEdge/Chromeが見つかりません。")
    except Exception as exc:
        print(f"App window failed: {exc}", flush=True)
        webbrowser.open(urls["local"])
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
    finally:
        server.shutdown()
        server.server_close()


def launch_app_window(url: str) -> bool:
    browser_path = find_desktop_browser()

    if not browser_path:
        return False

    profile_dir = ROOT_DIR / "browser-profile"
    profile_dir.mkdir(parents=True, exist_ok=True)
    process = subprocess.Popen(
        [
            str(browser_path),
            f"--app={url}",
            f"--user-data-dir={profile_dir}",
            "--no-first-run",
            "--disable-features=Translate",
            "--autoplay-policy=no-user-gesture-required",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    process.wait()
    return True


def find_desktop_browser() -> Path | None:
    candidates = [
        Path(os.environ.get("PROGRAMFILES", "")) / "Google" / "Chrome" / "Application" / "chrome.exe",
        Path(os.environ.get("PROGRAMFILES(X86)", "")) / "Google" / "Chrome" / "Application" / "chrome.exe",
        Path(os.environ.get("LOCALAPPDATA", "")) / "Google" / "Chrome" / "Application" / "chrome.exe",
        Path(os.environ.get("PROGRAMFILES(X86)", "")) / "Microsoft" / "Edge" / "Application" / "msedge.exe",
        Path(os.environ.get("PROGRAMFILES", "")) / "Microsoft" / "Edge" / "Application" / "msedge.exe",
        Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "Edge" / "Application" / "msedge.exe",
    ]

    for candidate in candidates:
        if candidate.is_file():
            return candidate

    return None


def create_http_server(host: str, port: int, allow_port_fallback: bool = False) -> ThreadingHTTPServer:
    try:
        return ThreadingHTTPServer((host, port), AppHandler)
    except OSError:
        if not allow_port_fallback:
            raise

        return ThreadingHTTPServer((host, 0), AppHandler)


class AppHandler(BaseHTTPRequestHandler):
    server_version = "RecordingAINotes/1.0"

    def do_GET(self) -> None:
        self.route()

    def do_HEAD(self) -> None:
        self.route(head_only=True)

    def do_POST(self) -> None:
        self.route()

    def do_PATCH(self) -> None:
        self.route()

    def do_DELETE(self) -> None:
        self.route()

    def log_message(self, format: str, *args: object) -> None:
        print(f"{self.address_string()} - {format % args}")

    def route(self, head_only: bool = False) -> None:
        try:
            ensure_storage()
            url = parse.urlparse(self.path)

            if url.path.startswith("/api/"):
                self.handle_api(url, head_only)
                return

            self.serve_static(url, head_only)
        except RequestHandled:
            return
        except Exception as exc:
            print(exc)
            self.send_json({"error": "Server error"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def handle_api(self, url: parse.ParseResult, head_only: bool) -> None:
        if url.path == "/api/health" and self.command == "GET":
            bound_host, bound_port = self.server.server_address[:2]
            urls = access_urls(str(bound_host), int(bound_port))
            self.send_json(
                {
                    "ok": True,
                    "retentionDays": RETENTION_DAYS,
                    "aiEnabled": has_admin_ai(),
                    "remoteAdminEnabled": has_remote_admin(),
                    "appVariant": app_variant(),
                    "historyEnabled": history_enabled(),
                    "exportEnabled": export_enabled(),
                    "storagePath": str(DATA_DIR.resolve()) if export_enabled() else "",
                    "localUrl": urls["local"],
                    "networkUrls": urls["network"],
                }
            )
            return

        if url.path == "/api/recordings" and self.command == "GET":
            records = cleanup_expired_audio()
            self.send_json([public_record(record) for record in records])
            return

        if url.path == "/api/recordings" and self.command == "POST":
            self.create_recording(url)
            return

        if url.path == "/api/pdf" and self.command == "POST":
            self.create_pdf()
            return

        if url.path == "/api/ai/process" and self.command == "POST":
            self.process_remote_ai()
            return

        process_match = re.fullmatch(r"/api/recordings/([^/]+)/process", url.path)
        if process_match and self.command == "POST":
            self.process_recording(process_match.group(1))
            return

        export_match = re.fullmatch(r"/api/recordings/([^/]+)/export", url.path)
        if export_match and self.command == "POST":
            self.export_recording(export_match.group(1))
            return

        audio_match = re.fullmatch(r"/api/recordings/([^/]+)/audio", url.path)
        if audio_match and self.command in {"GET", "HEAD"}:
            self.serve_audio(audio_match.group(1), head_only)
            return

        record_match = re.fullmatch(r"/api/recordings/([^/]+)", url.path)
        if record_match and self.command == "PATCH":
            self.update_recording(record_match.group(1))
            return

        if record_match and self.command == "DELETE":
            self.delete_recording(record_match.group(1))
            return

        self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)

    def create_recording(self, url: parse.ParseResult) -> None:
        body = self.read_body(MAX_AUDIO_BYTES)

        if not body:
            self.send_json({"error": "録音データが空です。"}, HTTPStatus.BAD_REQUEST)
            return

        query = parse.parse_qs(url.query)
        now = utc_now()
        recording_id = str(uuid.uuid4())
        mime = normalize_mime(self.headers.get("Content-Type"))
        extension = extension_for_mime(mime)
        audio_file_name = f"{recording_id}.{extension}"
        title = clean_title(first(query.get("title"))) or default_title(now)

        (AUDIO_DIR / audio_file_name).write_bytes(body)

        records = read_records()
        record = {
            "id": recording_id,
            "title": title,
            "createdAt": iso(now),
            "expiresAt": iso(now + RETENTION),
            "audioFileName": audio_file_name,
            "audioMime": mime,
            "audioBytes": len(body),
            "transcript": "",
            "note": "",
            "status": "uploaded",
            "transcriptSource": None,
            "noteSource": None,
            "processingMessage": "",
        }
        records.insert(0, record)
        write_records(records)
        self.send_json(public_record(record), HTTPStatus.CREATED)

    def process_recording(self, recording_id: str) -> None:
        payload = self.read_json(MAX_JSON_BYTES)
        records = cleanup_expired_audio()
        record = find_record(records, recording_id)

        if not record:
            self.send_json({"error": "録音が見つかりません。"}, HTTPStatus.NOT_FOUND)
            return

        retry_transcript = bool(payload.get("retryTranscript"))
        if retry_transcript:
            if not record.get("audioFileName"):
                self.send_json({"error": "音声ファイルが残っていないため、再文字起こしできません。"}, HTTPStatus.GONE)
                return

            if not consume_retry_transcript_attempt(record):
                write_records(records)
                self.send_json({"error": "再文字起こしは1日3回までです。明日また試してください。"}, HTTPStatus.TOO_MANY_REQUESTS)
                return

        record["status"] = "processing"
        record["processingMessage"] = ""
        write_records(records)

        warnings: list[str] = []
        transcript = clean_text(payload.get("browserTranscript") or ("" if retry_transcript else record.get("transcript") or ""))
        transcript_source = "browser" if transcript else None
        note_mode = clean_note_mode(payload.get("noteMode") or record.get("noteMode"))
        note = ""
        api_key = request_api_key(payload)
        has_api_key = bool(api_key)
        key_source = "user" if clean_text(payload.get("userApiKey")) else "admin"

        if should_use_remote_admin(payload):
            try:
                remote = process_with_remote_admin(record, transcript, note_mode)
                transcript = clean_text(remote.get("transcript") or transcript)
                note = clean_text(remote.get("note") or "")
                transcript_source = remote.get("transcriptSource") or "openai"
                note_source = remote.get("noteSource") or "openai"
                key_source = "remote-admin"
            except Exception as exc:
                warnings.append(f"管理者AIサーバー: {exc}")
        elif has_api_key and record.get("audioFileName"):
            try:
                transcript = clean_text(transcribe_with_openai(record, api_key))
                transcript_source = "openai"
            except Exception as exc:
                warnings.append(f"文字起こしAPI: {exc}")

        if not transcript:
            record["status"] = "needs_transcript"
            record["processingMessage"] = (
                "文字起こしが空です。OpenAI APIキーを設定するか、対応ブラウザで録音してください。"
            )
            write_records(records)
            self.send_json(public_record(record), HTTPStatus.UNPROCESSABLE_ENTITY)
            return

        note_source = "openai" if note else "local"

        if note:
            pass
        elif has_api_key:
            try:
                note = clean_text(summarize_with_openai(transcript, api_key, note_mode))
                note_source = "openai"
            except Exception as exc:
                warnings.append(f"ノート生成API: {exc}")
                note = make_fallback_note(transcript, "AIノート生成に失敗したため、簡易ノートを作成しました。", note_mode)
        else:
            note = make_fallback_note(transcript, "OpenAI APIキー未設定のため、簡易ノートを作成しました。", note_mode)

        record["transcript"] = transcript
        record["note"] = note
        record["noteMode"] = note_mode
        record["status"] = "ready"
        record["processedAt"] = iso(utc_now())
        record["transcriptSource"] = transcript_source
        record["noteSource"] = note_source
        record["apiKeySource"] = key_source if has_api_key else None
        record["processingMessage"] = " / ".join(warnings)

        write_records(records)
        self.send_json(public_record(record))

    def process_remote_ai(self) -> None:
        if not authorized_remote_ai_request(self.headers.get("Authorization")):
            self.send_json({"error": "管理者AIサーバーの認証に失敗しました。"}, HTTPStatus.UNAUTHORIZED)
            return

        payload = self.read_json(MAX_REMOTE_AI_JSON_BYTES)
        api_key = request_api_key(payload)

        if not api_key:
            self.send_json({"error": "管理者APIキーが未設定です。"}, HTTPStatus.SERVICE_UNAVAILABLE)
            return

        transcript = clean_text(payload.get("browserTranscript") or "")
        transcript_source = "browser" if transcript else None
        note_mode = clean_note_mode(payload.get("noteMode"))
        audio_base64 = clean_text(payload.get("audioBase64") or "")

        if audio_base64:
            try:
                audio_bytes = base64.b64decode(audio_base64, validate=True)
                filename = clean_title(str(payload.get("audioFileName") or "recording.webm")) or "recording.webm"
                audio_mime = normalize_mime(str(payload.get("audioMime") or "audio/webm"))
                transcript = clean_text(transcribe_audio_bytes(filename, audio_mime, audio_bytes, api_key))
                transcript_source = "openai"
            except Exception as exc:
                self.send_json({"error": f"文字起こしAPI: {exc}"}, HTTPStatus.UNPROCESSABLE_ENTITY)
                return

        if not transcript:
            self.send_json({"error": "文字起こしが空です。"}, HTTPStatus.UNPROCESSABLE_ENTITY)
            return

        try:
            note = clean_text(summarize_with_openai(transcript, api_key, note_mode))
        except Exception as exc:
            self.send_json({"error": f"ノート生成API: {exc}"}, HTTPStatus.UNPROCESSABLE_ENTITY)
            return

        self.send_json(
            {
                "transcript": transcript,
                "note": note,
                "noteMode": note_mode,
                "transcriptSource": transcript_source or "openai",
                "noteSource": "openai",
            }
        )

    def update_recording(self, recording_id: str) -> None:
        payload = self.read_json(MAX_JSON_BYTES)
        records = cleanup_expired_audio()
        record = find_record(records, recording_id)

        if not record:
            self.send_json({"error": "録音が見つかりません。"}, HTTPStatus.NOT_FOUND)
            return

        if isinstance(payload.get("title"), str):
            record["title"] = clean_title(payload["title"]) or record.get("title") or "無題"

        if isinstance(payload.get("transcript"), str):
            record["transcript"] = clean_text(payload["transcript"])

        if isinstance(payload.get("note"), str):
            record["note"] = clean_text(payload["note"])

        if isinstance(payload.get("noteMode"), str):
            record["noteMode"] = clean_note_mode(payload["noteMode"])

        record["updatedAt"] = iso(utc_now())
        write_records(records)
        self.send_json(public_record(record))

    def delete_recording(self, recording_id: str) -> None:
        records = cleanup_expired_audio()
        record = find_record(records, recording_id)

        if not record:
            self.send_json({"error": "録音が見つかりません。"}, HTTPStatus.NOT_FOUND)
            return

        audio_file_name = record.get("audioFileName")
        if audio_file_name:
            remove_audio_file(AUDIO_DIR / Path(audio_file_name).name)

        records = [item for item in records if item.get("id") != recording_id]
        write_records(records)
        self.send_json({"ok": True, "id": recording_id})

    def create_pdf(self) -> None:
        payload = self.read_json(MAX_JSON_BYTES)

        try:
            pdf = build_note_pdf(payload)
        except MissingPdfLibrary as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        title = clean_title(str(payload.get("title") or "録音ノート")) or "録音ノート"
        self.send_binary(
            pdf,
            "application/pdf",
            f"{safe_path_part(title)}.pdf",
        )

    def export_recording(self, recording_id: str) -> None:
        if not export_enabled():
            self.send_json({"error": "Web版ではファイル保存を使えません。"}, HTTPStatus.FORBIDDEN)
            return

        records = cleanup_expired_audio()
        record = find_record(records, recording_id)

        if not record:
            self.send_json({"error": "録音が見つかりません。"}, HTTPStatus.NOT_FOUND)
            return

        export_path = write_record_export(record)
        self.send_json(
            {
                "ok": True,
                "path": str(export_path.resolve()),
            }
        )

    def serve_audio(self, recording_id: str, head_only: bool) -> None:
        records = cleanup_expired_audio()
        record = find_record(records, recording_id)

        if not record or not record.get("audioFileName"):
            self.send_json({"error": "音声ファイルはありません。"}, HTTPStatus.NOT_FOUND)
            return

        audio_path = AUDIO_DIR / Path(record["audioFileName"]).name

        if not audio_path.exists():
            record["audioFileName"] = None
            record["audioDeletedAt"] = iso(utc_now())
            write_records(records)
            self.send_json({"error": "音声ファイルは削除済みです。"}, HTTPStatus.NOT_FOUND)
            return

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", record.get("audioMime") or "audio/webm")
        self.send_header("Content-Length", str(audio_path.stat().st_size))
        self.send_header("Cache-Control", "private, max-age=0")
        self.end_headers()

        if not head_only:
            with audio_path.open("rb") as audio_file:
                shutil.copyfileobj(audio_file, self.wfile)

    def serve_static(self, url: parse.ParseResult, head_only: bool) -> None:
        if self.command not in {"GET", "HEAD"}:
            self.send_json({"error": "Method not allowed"}, HTTPStatus.METHOD_NOT_ALLOWED)
            return

        relative_path = parse.unquote(url.path.lstrip("/")) or "index.html"
        file_path = (PUBLIC_DIR / relative_path).resolve()
        public_root = PUBLIC_DIR.resolve()

        try:
            if os.path.commonpath([str(public_root), str(file_path)]) != str(public_root):
                self.send_json({"error": "Forbidden"}, HTTPStatus.FORBIDDEN)
                return
        except ValueError:
            self.send_json({"error": "Forbidden"}, HTTPStatus.FORBIDDEN)
            return

        if file_path.is_dir():
            file_path = file_path / "index.html"

        if not file_path.is_file():
            self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
            return

        content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        if file_path.suffix in {".html", ".css", ".js", ".json"}:
            content_type = f"{content_type}; charset=utf-8"

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(file_path.stat().st_size))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

        if not head_only:
            with file_path.open("rb") as static_file:
                shutil.copyfileobj(static_file, self.wfile)

    def read_body(self, limit: int) -> bytes:
        length = int(self.headers.get("Content-Length") or "0")

        if length > limit:
            self.send_json({"error": "データが大きすぎます。"}, HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            raise RequestHandled

        return self.rfile.read(length)

    def read_json(self, limit: int) -> dict:
        body = self.read_body(limit)

        if not body:
            return {}

        try:
            parsed = json.loads(body.decode("utf-8"))
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            self.send_json({"error": "JSONを読み取れませんでした。"}, HTTPStatus.BAD_REQUEST)
            raise RequestHandled

    def send_json(self, payload: object, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()

        if self.command != "HEAD":
            self.wfile.write(body)

    def send_binary(self, body: bytes, content_type: str, filename: str) -> None:
        encoded_name = parse.quote(filename)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header(
            "Content-Disposition",
            f"attachment; filename=\"note.pdf\"; filename*=UTF-8''{encoded_name}",
        )
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

        if self.command != "HEAD":
            self.wfile.write(body)


class MissingPdfLibrary(Exception):
    pass


def build_note_pdf(payload: dict) -> bytes:
    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.cidfonts import UnicodeCIDFont
        from reportlab.pdfgen import canvas
    except Exception as exc:
        raise MissingPdfLibrary(
            "PDF生成ライブラリがありません。requirements.txt の reportlab を入れてください。"
        ) from exc

    register_pdf_font(pdfmetrics, UnicodeCIDFont, "HeiseiMin-W3")
    register_pdf_font(pdfmetrics, UnicodeCIDFont, "HeiseiKakuGo-W5")

    title = clean_title(str(payload.get("title") or "録音ノート")) or "録音ノート"
    created_at = clean_text(payload.get("createdAt") or "")
    note = clean_text(payload.get("note") or "")
    transcript = clean_text(payload.get("transcript") or "")
    note_mode = clean_note_mode(payload.get("noteMode"))
    note_mode_label = "詳細" if note_mode == "detailed" else "簡易"

    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=A4)
    width, height = A4
    margin = 42
    y = height - margin

    def ensure_space(required: int = 18) -> None:
        nonlocal y
        if y >= margin + required:
            return

        pdf.showPage()
        y = height - margin

    def draw_wrapped(text: str, font: str = "HeiseiMin-W3", size: int = 10, leading: int = 15, indent: int = 0) -> None:
        nonlocal y
        available_width = width - margin * 2 - indent
        max_chars = max(18, int(available_width / max(size * 0.58, 1)))
        raw_lines = str(text or "").splitlines() or [""]
        pdf.setFont(font, size)

        for raw in raw_lines:
            if not raw.strip():
                ensure_space(leading)
                y -= leading
                continue

            chunks = textwrap.wrap(
                raw,
                width=max_chars,
                break_long_words=True,
                replace_whitespace=False,
                drop_whitespace=False,
            ) or [raw]

            for chunk in chunks:
                ensure_space(leading)
                pdf.drawString(margin + indent, y, chunk)
                y -= leading

    def draw_section_heading(label: str) -> None:
        nonlocal y
        ensure_space(28)
        y -= 6
        pdf.setFont("HeiseiKakuGo-W5", 13)
        pdf.drawString(margin, y, label)
        y -= 8
        pdf.line(margin, y, width - margin, y)
        y -= 14

    pdf.setTitle(title)
    pdf.setAuthor("録音ノート")
    pdf.setFont("HeiseiKakuGo-W5", 18)
    pdf.drawString(margin, y, title)
    y -= 24
    pdf.setFont("HeiseiMin-W3", 9)
    pdf.drawString(margin, y, f"{created_at} / ノート形式: {note_mode_label}".strip(" /"))
    y -= 18

    draw_section_heading("AIノート")
    draw_wrapped(note or "ノートはまだありません。")

    draw_section_heading("文字起こし")
    draw_wrapped(transcript or "文字起こしはまだありません。")

    pdf.save()
    return buffer.getvalue()


def transcribe_with_openai(record: dict, api_key: str) -> str:
    audio_path = AUDIO_DIR / Path(record["audioFileName"]).name
    return transcribe_audio_bytes(
        record["audioFileName"],
        record.get("audioMime") or "audio/webm",
        audio_path.read_bytes(),
        api_key,
    )


def transcribe_audio_bytes(filename: str, audio_mime: str, audio_bytes: bytes, api_key: str) -> str:
    fields = {
        "model": os.environ.get("OPENAI_TRANSCRIBE_MODEL", "gpt-4o-mini-transcribe"),
        "response_format": "json",
    }
    files = {
        "file": (
            Path(filename).name or "recording.webm",
            normalize_mime(audio_mime),
            audio_bytes,
        )
    }
    data, content_type = encode_multipart(fields, files)
    response = openai_request(
        "https://api.openai.com/v1/audio/transcriptions",
        api_key,
        data,
        content_type,
    )
    return str(response.get("text") or "")


def process_with_remote_admin(record: dict, browser_transcript: str, note_mode: str) -> dict:
    base_url = remote_admin_base()

    if not base_url:
        raise RuntimeError("ADMIN_API_BASE が未設定です。")

    payload = {
        "browserTranscript": browser_transcript,
        "noteMode": note_mode,
        "audioMime": record.get("audioMime") or "audio/webm",
        "audioFileName": record.get("audioFileName") or "recording.webm",
    }

    audio_file_name = record.get("audioFileName")
    if audio_file_name:
        audio_path = AUDIO_DIR / Path(audio_file_name).name
        if audio_path.exists():
            payload["audioBase64"] = base64.b64encode(audio_path.read_bytes()).decode("ascii")

    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    endpoint = f"{base_url}/api/ai/process"
    response = url_json_request(endpoint, body, "application/json")

    if not isinstance(response, dict):
        raise RuntimeError("管理者AIサーバーの応答を読めませんでした。")

    return response


def detailed_note_rules() -> str:
    return "\n".join(
        [
            "ノート形式: 詳細",
            "次の形式と雰囲気を必ず参考にしてください。",
            "",
            "# タイトル",
            "",
            "***",
            "",
            "## 1. 大きなテーマ名",
            "",
            "### 背景",
            "",
            "* 重要な前提を箇条書き",
            "* 重要語句は **太字** にする",
            "",
            "### 結果",
            "",
            "* 結論や影響を箇条書き",
            "",
            "***",
            "",
            "## 2. 次のテーマ名",
            "",
            "### ポイント",
            "",
            "* 内容を整理",
            "",
            "***",
            "",
            "## 全体まとめ",
            "",
            "1. 重要条件",
            "2. 結果",
            "3. 意義",
            "",
            "詳細ルール:",
            "* 見出し番号は内容に合わせて増減する",
            "* 歴史・社会・理科などの授業なら、背景、方法、結果、意義を優先する",
            "* 復習に必要な説明を省略しすぎない",
        ]
    )


def simple_note_rules() -> str:
    return "\n".join(
        [
            "ノート形式: 簡易",
            "短く読み返せる要点ノートにしてください。",
            "",
            "# タイトル",
            "",
            "## 要点",
            "",
            "* 重要な内容を5〜8個に絞る",
            "* 重要語句は **太字** にする",
            "",
            "## 重要語句",
            "",
            "* 用語: 意味を短く",
            "",
            "## まとめ",
            "",
            "* 最後に全体を2〜3行でまとめる",
            "",
            "簡易ルール:",
            "* 細かい背景説明は必要最小限にする",
            "* 長い章立てにしない",
            "* 重要な用語と結論を優先する",
        ]
    )


def summarize_with_openai(transcript: str, api_key: str, note_mode: str = "detailed") -> str:
    mode_rules = detailed_note_rules() if note_mode == "detailed" else simple_note_rules()
    prompt = "\n".join(
        [
            "次の文字起こしを、授業用の日本語ノートとして整理してください。",
            mode_rules,
            "",
            "共通ルール:",
            "* 会話や雑談は要点に変換する",
            "* 文字起こしにないことは推測で断定しない",
            "* TODO形式ではなく、復習しやすい学習ノートにする",
            "",
            "文字起こし:",
            transcript,
        ]
    )
    payload = json.dumps(
        {
            "model": os.environ.get("OPENAI_NOTE_MODEL", "gpt-4o-mini"),
            "input": [
                {
                    "role": "system",
                    "content": "あなたは会議・講義・作業メモを、読み返しやすいノートに整えるアシスタントです。",
                },
                {"role": "user", "content": prompt},
            ],
        },
        ensure_ascii=False,
    ).encode("utf-8")
    response = openai_request(
        "https://api.openai.com/v1/responses",
        api_key,
        payload,
        "application/json",
    )

    if isinstance(response.get("output_text"), str):
        return response["output_text"]

    parts: list[str] = []
    for output_item in response.get("output", []):
        for content_item in output_item.get("content", []):
            text = content_item.get("text")
            if isinstance(text, str):
                parts.append(text)

    return "\n".join(parts).strip()


def openai_request(url: str, api_key: str, data: bytes, content_type: str) -> dict:
    req = request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": content_type,
        },
    )

    try:
        with request.urlopen(req, timeout=120) as res:
            body = res.read().decode("utf-8")
    except error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(body)
            message = parsed.get("error", {}).get("message") or body
        except json.JSONDecodeError:
            message = body
        raise RuntimeError(message) from exc

    return json.loads(body or "{}")


def url_json_request(url: str, data: bytes, content_type: str) -> dict:
    headers = {"Content-Type": content_type}
    token = admin_api_token()
    if token:
        headers["Authorization"] = f"Bearer {token}"

    req = request.Request(
        url,
        data=data,
        method="POST",
        headers=headers,
    )

    try:
        with request.urlopen(req, timeout=180) as res:
            body = res.read().decode("utf-8")
    except error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(body)
            message = parsed.get("error") or parsed.get("processingMessage") or body
        except json.JSONDecodeError:
            message = body
        raise RuntimeError(message) from exc

    try:
        parsed = json.loads(body or "{}")
        return parsed if isinstance(parsed, dict) else {}
    except json.JSONDecodeError as exc:
        raise RuntimeError("JSON応答ではありません。") from exc


def encode_multipart(fields: dict[str, str], files: dict[str, tuple[str, str, bytes]]) -> tuple[bytes, str]:
    boundary = f"----recording-ai-notes-{uuid.uuid4().hex}"
    body = bytearray()

    for name, value in fields.items():
        body.extend(f"--{boundary}\r\n".encode())
        body.extend(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
        body.extend(str(value).encode("utf-8"))
        body.extend(b"\r\n")

    for name, (filename, content_type, content) in files.items():
        safe_name = Path(filename).name
        body.extend(f"--{boundary}\r\n".encode())
        body.extend(
            f'Content-Disposition: form-data; name="{name}"; filename="{safe_name}"\r\n'.encode()
        )
        body.extend(f"Content-Type: {content_type}\r\n\r\n".encode())
        body.extend(content)
        body.extend(b"\r\n")

    body.extend(f"--{boundary}--\r\n".encode())
    return bytes(body), f"multipart/form-data; boundary={boundary}"


def make_fallback_note(transcript: str, reason: str, note_mode: str = "detailed") -> str:
    normalized = re.sub(r"\s+", " ", transcript).strip()
    sentences = [item.strip() for item in re.split(r"(?<=[。.!?！？])\s*", normalized) if item.strip()]
    highlights = sentences[:6] or ["文字起こしを確認してください。"]
    keywords = extract_keywords(normalized)

    if note_mode == "simple":
        lines = [
            "# 講義ノート",
            "",
            "## 要点",
            "",
        ]
        lines.extend(f"* {item}" for item in highlights[:5])
        lines.extend(["", "## 重要語句", ""])
        lines.extend(f"* **{item}**" for item in keywords[:6] or ["なし"])
        lines.extend(
            [
                "",
                "## まとめ",
                "",
                "* 文字起こしから主要な内容を短く整理しました。",
                f"* {reason}",
            ]
        )
        return "\n".join(lines)

    lines = [
        "# 講義ノート",
        "",
        "***",
        "",
        "## 1. 要点",
        "",
    ]
    lines.extend(f"* {item}" for item in highlights)
    lines.extend(["", "***", "", "## 2. 重要語句", ""])
    lines.extend(f"* **{item}**" for item in keywords[:8] or ["なし"])
    lines.extend(
        [
            "",
            "***",
            "",
            "## 3. 内容整理",
            "",
            "### 背景",
            "",
            "* 授業・録音内で説明された前提を文字起こしから整理してください。",
            "",
            "### 流れ",
            "",
        ]
    )
    lines.extend(f"* {item}" for item in highlights[:4])
    lines.extend(
        [
            "",
            "### 結果・意義",
            "",
            "* 重要な結論や意味づけを、必要に応じて追記してください。",
            "",
            "***",
            "",
            "## 4. 全体まとめ",
            "",
            "* 重要な内容を見出しごとに復習しやすい形へ整理しました。",
            f"* {reason}",
        ]
    )
    return "\n".join(lines)


def extract_keywords(text: str) -> list[str]:
    matches = re.findall(r"[一-龥々ァ-ヶーA-Za-z0-9]{3,}", text)
    keywords: list[str] = []

    for item in matches:
        if item not in keywords:
            keywords.append(item)

    return keywords


def cleanup_loop() -> None:
    while True:
        time.sleep(60 * 60)
        try:
            cleanup_expired_audio()
        except Exception as exc:
            print(exc)


def cleanup_expired_audio(records: list[dict] | None = None) -> list[dict]:
    stored_records = records if records is not None else read_records()
    now = utc_now()
    changed = False

    for record in stored_records:
        pending_file_name = record.get("audioDeletePendingFileName")
        if pending_file_name and not record.get("audioFileName"):
            pending_path = AUDIO_DIR / Path(pending_file_name).name
            if remove_audio_file(pending_path):
                record.pop("audioDeletePendingFileName", None)
                changed = True
            continue

        audio_file_name = record.get("audioFileName")
        if not audio_file_name:
            continue

        expires_at = parse_iso(record.get("expiresAt")) or (
            parse_iso(record.get("createdAt")) or now
        ) + RETENTION

        if now < expires_at:
            continue

        audio_path = AUDIO_DIR / Path(audio_file_name).name
        fully_deleted = remove_audio_file(audio_path)

        record["audioFileName"] = None
        record["audioBytes"] = 0
        record["audioDeletedAt"] = iso(now)
        if not fully_deleted:
            record["audioDeletePendingFileName"] = Path(audio_file_name).name
        changed = True

    if changed:
        write_records(stored_records)

    return stored_records


def remove_audio_file(audio_path: Path) -> bool:
    try:
        audio_path.unlink()
        return True
    except FileNotFoundError:
        return True
    except PermissionError:
        audio_path.write_bytes(b"")
        return False


def access_urls(host: str, port: int) -> dict[str, list[str] | str]:
    local_url = f"http://127.0.0.1:{port}"
    network_urls: list[str] = []

    if host in {"", "0.0.0.0", "::"}:
        network_urls = [f"http://{ip}:{port}" for ip in lan_ips()]
    elif is_lan_ip(host):
        network_urls = [f"http://{host}:{port}"]

    return {"local": local_url, "network": network_urls}


def lan_ips() -> list[str]:
    ips: set[str] = set()

    try:
        for item in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = item[4][0]
            if is_lan_ip(ip):
                ips.add(ip)
    except OSError:
        pass

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("8.8.8.8", 80))
            ip = probe.getsockname()[0]
            if is_lan_ip(ip):
                ips.add(ip)
    except OSError:
        pass

    return sorted(ips)


def is_lan_ip(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False

    return (
        address.version == 4
        and not address.is_loopback
        and not address.is_link_local
        and not address.is_unspecified
    )


def ensure_storage() -> None:
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)

    if not RECORDS_FILE.exists():
        write_records([])


def app_variant() -> str:
    configured = os.environ.get("APP_VARIANT", "").strip().lower()

    if configured in {"web", "windows"}:
        return configured

    if is_frozen_app():
        return "windows"

    if os.environ.get("RENDER"):
        return "web"

    return "web"


def is_frozen_app() -> bool:
    return bool(getattr(sys, "frozen", False))


def should_run_desktop_window() -> bool:
    if not is_frozen_app():
        return False

    return os.environ.get("APP_WINDOW", "1").strip() == "1"


def history_enabled() -> bool:
    return app_variant() == "windows"


def export_enabled() -> bool:
    return app_variant() == "windows"


def write_record_export(record: dict) -> Path:
    created_at = parse_iso(record.get("createdAt")) or utc_now()
    folder_name = safe_path_part(
        f"{created_at.astimezone():%Y%m%d-%H%M}-{record.get('title') or '録音ノート'}"
    )
    export_dir = DATA_DIR / "exports" / folder_name
    export_dir.mkdir(parents=True, exist_ok=True)

    transcript = clean_text(record.get("transcript") or "")
    note = clean_text(record.get("note") or "")

    (export_dir / "文字起こし.txt").write_text(transcript + "\n", encoding="utf-8")
    (export_dir / "AIノート.md").write_text(note + "\n", encoding="utf-8")
    (export_dir / "record.json").write_text(
        json.dumps(public_record(record), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    audio_file_name = record.get("audioFileName")
    if audio_file_name:
        source = AUDIO_DIR / Path(audio_file_name).name
        if source.exists() and source.stat().st_size:
            shutil.copy2(source, export_dir / f"録音.{extension_for_mime(record.get('audioMime'))}")

    return export_dir


def safe_path_part(value: str) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", value)
    cleaned = re.sub(r"\s+", "_", cleaned).strip("._ ")
    return cleaned[:120] or "録音ノート"


def read_records() -> list[dict]:
    if not RECORDS_FILE.exists():
        return []

    try:
        records = json.loads(RECORDS_FILE.read_text(encoding="utf-8"))
        return records if isinstance(records, list) else []
    except json.JSONDecodeError:
        return []


def write_records(records: list[dict]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    RECORDS_FILE.write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def public_record(record: dict) -> dict:
    safe = {key: value for key, value in record.items() if key != "audioFileName"}
    has_audio = bool(record.get("audioFileName"))
    safe["hasAudio"] = has_audio
    safe["audioUrl"] = f"/api/recordings/{record['id']}/audio" if has_audio else None
    safe["retryTranscriptRemaining"] = retry_transcript_remaining(record)
    return safe


def find_record(records: list[dict], recording_id: str) -> dict | None:
    return next((record for record in records if record.get("id") == recording_id), None)


def retry_transcript_day_key() -> str:
    return utc_now().astimezone(timezone(timedelta(hours=9))).strftime("%Y-%m-%d")


def retry_transcript_remaining(record: dict) -> int:
    usage = record.get("retryTranscriptUsage")
    if not isinstance(usage, dict):
        return RETRY_TRANSCRIPT_DAILY_LIMIT

    count = int(usage.get(retry_transcript_day_key()) or 0)
    return max(0, RETRY_TRANSCRIPT_DAILY_LIMIT - count)


def consume_retry_transcript_attempt(record: dict) -> bool:
    key = retry_transcript_day_key()
    usage = record.get("retryTranscriptUsage")

    if not isinstance(usage, dict):
        usage = {}

    count = int(usage.get(key) or 0)

    if count >= RETRY_TRANSCRIPT_DAILY_LIMIT:
        record["retryTranscriptUsage"] = usage
        return False

    usage[key] = count + 1
    record["retryTranscriptUsage"] = usage
    return True


def load_env_file() -> None:
    env_path = ROOT_DIR / ".env"
    if not env_path.exists():
        return

    for line in env_path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue

        key, value = stripped.split("=", 1)
        key = key.strip()
        value = value.strip().strip("\"'")

        if key and key not in os.environ:
            os.environ[key] = value


def has_openai_key() -> bool:
    return bool(os.environ.get("OPENAI_API_KEY", "").strip())


def has_remote_admin() -> bool:
    return bool(remote_admin_base())


def has_admin_ai() -> bool:
    return has_openai_key() or has_remote_admin()


def remote_admin_base() -> str:
    return os.environ.get("ADMIN_API_BASE", "").strip().rstrip("/")


def admin_api_token() -> str:
    return os.environ.get("ADMIN_API_TOKEN", "").strip()


def authorized_remote_ai_request(header: str | None) -> bool:
    token = admin_api_token()

    if not token:
        return True

    return str(header or "").strip() == f"Bearer {token}"


def should_use_remote_admin(payload: dict) -> bool:
    if clean_api_key(payload.get("userApiKey")):
        return False

    return bool(remote_admin_base())


def request_api_key(payload: dict) -> str:
    user_api_key = clean_api_key(payload.get("userApiKey"))

    if user_api_key:
        return user_api_key

    return os.environ.get("OPENAI_API_KEY", "").strip()


def clean_api_key(value: object) -> str:
    return str(value or "").strip()[:300]


def clean_note_mode(value: object) -> str:
    return "simple" if str(value or "").strip().lower() == "simple" else "detailed"


def register_pdf_font(pdfmetrics: object, UnicodeCIDFont: object, font_name: str) -> None:
    try:
        pdfmetrics.getFont(font_name)
    except KeyError:
        pdfmetrics.registerFont(UnicodeCIDFont(font_name))


def clean_title(value: str | None) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[\x00-\x1f\x7f]", " ", str(value or ""))).strip()[:80]


def clean_text(value: str | None) -> str:
    return str(value or "").replace("\x00", "").strip()[:200000]


def default_title(date: datetime) -> str:
    local = date.astimezone()
    return f"録音 {local:%Y/%m/%d %H:%M}"


def normalize_mime(value: str | None) -> str:
    mime = (value or "audio/webm").split(";", 1)[0].strip().lower()
    return mime or "audio/webm"


def extension_for_mime(mime: str) -> str:
    if "mp4" in mime or "m4a" in mime or "aac" in mime:
        return "m4a"
    if "mpeg" in mime or "mp3" in mime:
        return "mp3"
    if "wav" in mime:
        return "wav"
    if "ogg" in mime:
        return "ogg"
    return "webm"


def first(values: list[str] | None) -> str | None:
    return values[0] if values else None


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso(date: datetime) -> str:
    return date.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_iso(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None

    try:
        normalized = value.replace("Z", "+00:00")
        parsed = datetime.fromisoformat(normalized)
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


if __name__ == "__main__":
    main()
