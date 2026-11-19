#!/usr/bin/env python3
"""Temporarily re-date already completed Reverie test journals; restore via backup.

Uses AWS CLI subprocesses rather than boto3 so it works with AWS CLI login credentials
when the Python environment lacks botocore's optional CRT login dependency.
No S3 copies, provider calls, SQS operations, account changes, or record creation.
"""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from datetime import date, datetime, time, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

UUID = re.compile(r"^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$")
UTC_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


def aws(args, region):
    command = ["aws", "--region", region, "--no-cli-pager", *args]
    completed = subprocess.run(command, text=True, capture_output=True, check=False)
    if completed.returncode != 0:
        err = completed.stderr.strip()
        raise RuntimeError(f"AWS command failed ({' '.join(args[:2])}): {err}")
    return json.loads(completed.stdout) if completed.stdout.strip() else {}


def get_row(table, upload_id, region):
    response = aws([
        "dynamodb", "get-item", "--table-name", table,
        "--key", json.dumps({"uploadId": {"S": upload_id}}),
        "--consistent-read", "--output", "json",
    ], region)
    item = response.get("Item")
    if not item:
        raise ValueError(f"Journal not found: {upload_id}")
    def val(key):
        return (item.get(key) or {}).get("S")
    return {
        "uploadId": val("uploadId"), "userId": val("userId"),
        "createdAt": val("createdAt"), "userCreatedAt": val("userCreatedAt"),
        "status": val("status"), "title": val("title") or "Untitled",
    }


def validate_row(row):
    if row["status"] != "completed":
        raise ValueError(f"{row['uploadId']}: only completed journals can be moved")
    if not row["userId"] or not row["userCreatedAt"] or not row["createdAt"]:
        raise ValueError(f"{row['uploadId']}: missing ownership/date fields")
    if not UTC_ISO.fullmatch(row["createdAt"]):
        raise ValueError(f"{row['uploadId']}: unexpected createdAt format")
    if row["userCreatedAt"] != f"{row['createdAt']}#{row['uploadId']}":
        raise ValueError(f"{row['uploadId']}: unexpected GSI key format")


def update_dates(table, row, before, after, region):
    # Conditional update: refuses to overwrite concurrent changes or a changed owner/status.
    aws([
        "dynamodb", "update-item", "--table-name", table,
        "--key", json.dumps({"uploadId": {"S": row["uploadId"]}}),
        "--update-expression", "SET #ca = :newca, #uca = :newuca",
        "--condition-expression", (
            "attribute_exists(uploadId) AND userId = :owner AND #s = :complete "
            "AND #ca = :oldca AND #uca = :olduca"
        ),
        "--expression-attribute-names", json.dumps({
            "#s": "status", "#ca": "createdAt", "#uca": "userCreatedAt",
        }),
        "--expression-attribute-values", json.dumps({
            ":owner": {"S": row["userId"]},
            ":complete": {"S": "completed"},
            ":oldca": {"S": before["createdAt"]},
            ":olduca": {"S": before["userCreatedAt"]},
            ":newca": {"S": after["createdAt"]},
            ":newuca": {"S": after["userCreatedAt"]},
        }),
        "--output", "json",
    ], region)


def confirm(text):
    try:
        return input(f"Type {text} to proceed: ").strip() == text
    except EOFError:
        return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--table", default=os.environ.get("JOURNAL_TABLE"))
    parser.add_argument("--account", default=os.environ.get("AWS_ACCOUNT"))
    parser.add_argument("--region", default=os.environ.get("AWS_REGION", "us-east-1"))
    parser.add_argument("--timezone", default="America/New_York")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--move", action="append", metavar="UUID:2026-10-DD",
                       help="A completed journal ID and its temporary October date; may repeat")
    group.add_argument("--restore", metavar="BACKUP_JSON", help="Restore all dates from a prior backup")
    parser.add_argument("--apply", action="store_true", help="Actually update dates (default: dry run)")
    opts = parser.parse_args()
    if not opts.table or not opts.account:
        parser.error("Load infra/.resource-ids.env and infra/.phase3-resource-ids.env first")
    actual = aws(["sts", "get-caller-identity", "--output", "json"], opts.region).get("Account")
    if actual != opts.account:
        raise ValueError(f"Wrong AWS account: expected {opts.account}; current {actual}")

    if opts.restore:
        plan = json.loads(Path(opts.restore).read_text())
        if plan.get("account") != opts.account or plan.get("table") != opts.table:
            raise ValueError("Backup account/table does not match current environment")
        if plan.get("kind") != "reverie-calendar-test-dates-v1":
            raise ValueError("Not a recognized date-fixture backup")
        print(f"Restoring {len(plan['changes'])} journal date(s) from {opts.restore}")
        if not confirm("RESTORE OCTOBER"):
            print("Cancelled; no changes made.")
            return
        for change in plan["changes"]:
            current = get_row(opts.table, change["uploadId"], opts.region)
            if current["userId"] != change["userId"]:
                raise ValueError("Owner changed; refusing to restore")
            current_dates = {k: current[k] for k in ("createdAt", "userCreatedAt")}
            if current_dates == change["before"]:
                print(f"Already restored: {change['title']}")
                continue
            if current_dates != change["after"]:
                raise ValueError(f"Journal changed since fixture creation: {change['uploadId']}")
            validate_row(current)
            update_dates(opts.table, current, change["after"], change["before"], opts.region)
            print(f"Restored: {change['title']}")
        print("Done. Refresh the website; GSI updates may take a few seconds to appear.")
        return

    try:
        tz = ZoneInfo(opts.timezone)
    except ZoneInfoNotFoundError as exc:
        raise ValueError(f"Unknown timezone: {opts.timezone}") from exc
    if len(opts.move) > 10:
        raise ValueError("Limit the test to at most 10 journals")
    seen = set()
    changes = []
    owners = set()
    for mapping in opts.move:
        try:
            upload_id, day = mapping.split(":", 1)
        except ValueError as exc:
            raise ValueError(f"Expected UUID:2026-10-DD, got {mapping!r}") from exc
        if not UUID.fullmatch(upload_id) or not re.fullmatch(r"2026-10-\d{2}", day):
            raise ValueError(f"Invalid October mapping: {mapping}")
        target = date.fromisoformat(day)
        if upload_id in seen:
            raise ValueError(f"Duplicate journal: {upload_id}")
        seen.add(upload_id)
        row = get_row(opts.table, upload_id, opts.region)
        validate_row(row)
        owners.add(row["userId"])
        when = datetime.combine(target, time(12, 0), tzinfo=tz).astimezone(timezone.utc)
        after_created = when.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        if row["createdAt"] == after_created:
            raise ValueError(f"Journal already has the target date: {upload_id}")
        before = {k: row[k] for k in ("createdAt", "userCreatedAt")}
        after = {"createdAt": after_created,
                 "userCreatedAt": f"{after_created}#{upload_id}"}
        changes.append({"uploadId": upload_id, "userId": row["userId"],
                        "title": row["title"], "before": before, "after": after})
    if len(owners) != 1:
        raise ValueError("All test journals must belong to the same user")
    print("\nPlanned temporary October dates (no S3/Lambda/SQS actions):")
    for change in changes:
        print(f"  {change['title']!r}: {change['before']['createdAt']} -> {change['after']['createdAt']}")
    if not opts.apply:
        print("\nDRY RUN ONLY. Re-run with --apply after reviewing the journal IDs.")
        return
    if not confirm("MOVE OCTOBER"):
        print("Cancelled; no changes made.")
        return
    backups = Path("infra/calendar-test-backups")
    backups.mkdir(parents=True, exist_ok=True)
    try:
        backups.chmod(0o700)
    except OSError:
        pass
    suffix = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    file = backups / f"original-dates-{suffix}.json"
    plan = {"kind": "reverie-calendar-test-dates-v1", "table": opts.table,
            "account": opts.account, "region": opts.region,
            "changes": changes}
    # Write backup before any mutation; use mode 0600 so it isn't world-readable.
    fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as output:
        json.dump(plan, output, indent=2)
        output.write("\n")
    print(f"Backup saved: {file}")
    print("Keep the backup until you're finished testing. Do not commit it to Git.")
    for change in changes:
        current = get_row(opts.table, change["uploadId"], opts.region)
        if current["userId"] != change["userId"]:
            raise ValueError("Owner changed; refusing to continue")
        validate_row(current)
        if any(current[key] != change["before"][key] for key in ("createdAt", "userCreatedAt")):
            raise ValueError(f"Journal dates changed; restore with {file} if partially applied")
        update_dates(opts.table, current, change["before"], change["after"], opts.region)
        print(f"Moved: {change['title']}")
    print("\nDone. You can refresh Reverie and switch Calendar to October 2026.")
    print("To restore original dates:")
    print(f"  python3 infra/calendar-test-dates.py --restore {file}")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
