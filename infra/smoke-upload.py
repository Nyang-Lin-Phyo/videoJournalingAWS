"""CLI-only integration test for the anonymous demo upload API + S3 POST.

Usage:
    python3 infra/smoke-upload.py samples/demo.mp4
Requires API_URL in infra/.resource-ids.env to be exported in the invoking shell.
This uses only the Python standard library.
"""
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request
import uuid


def main():
    if len(sys.argv) != 2:
        sys.exit("Usage: python3 infra/smoke-upload.py PATH_TO_MP4")
    path = pathlib.Path(sys.argv[1]); size = path.stat().st_size
    if path.suffix.lower() != ".mp4" or not (1 <= size <= 30 * 1024 * 1024):
        sys.exit("Select a nonempty .mp4 under 30 MiB")
    base = os.environ.get("API_URL", "").rstrip("/")
    if not base.startswith("https://"):
        sys.exit("API_URL is missing: run 'source infra/.resource-ids.env'")
    payload = json.dumps({"filename": path.name, "content_type": "video/mp4", "size": size}).encode("utf-8")
    req = urllib.request.Request(base + "/uploads", data=payload,
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as response:
        signed = json.load(response)
    form = signed["upload"]
    boundary = "----VideoJournal" + uuid.uuid4().hex
    parts = []
    for key, value in form["fields"].items():
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n{value}\r\n".encode())
    parts.append((f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{path.name}"\r\n'
                  'Content-Type: video/mp4\r\n\r\n').encode())
    parts.append(path.read_bytes())
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    body = b"".join(parts)
    upload = urllib.request.Request(form["url"], data=body, method="POST",
        headers={"Content-Type": "multipart/form-data; boundary=" + boundary})
    try:
        with urllib.request.urlopen(upload, timeout=120) as response:
            status = response.status
    except urllib.error.HTTPError as e:
        sys.exit(f"S3 upload failed: HTTP {e.code}\n{e.read().decode('utf-8', 'replace')[:600]}")
    if status not in (201, 204):
        sys.exit(f"Unexpected S3 status: {status}")
    print(f"Success! HTTP {status}; object key: {signed['object_key']}")
    print("Verify: aws s3 ls s3://$UPLOAD_BUCKET/uploads/ --recursive")


if __name__ == "__main__":
    main()
