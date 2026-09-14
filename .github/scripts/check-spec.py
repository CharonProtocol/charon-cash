#!/usr/bin/env python3
"""Reject spec errors and warnings beyond the three existing model limitations."""

import json
from pathlib import Path
import subprocess
import sys


def validate(findings, returncode):
    baseline = json.loads(
        Path(__file__).with_name("qedgen-warning-baseline.json").read_text()
    )
    fields = ("severity", "priority", "rule", "subject", "message")
    allowed = {tuple(item[field] for field in fields) for item in baseline}
    if not isinstance(findings, list):
        raise ValueError("Expected a JSON array from qedgen check")
    warnings = 0
    failed = returncode not in (0, 1)
    for item in findings:
        fingerprint = tuple(item[field] for field in fields)
        severity = item["severity"]
        print(f'{severity}: {item["rule"]}: {item["message"]}')
        if severity == "warning":
            warnings += 1
            if fingerprint not in allowed:
                failed = True
        elif severity != "info":
            failed = True
    # Exit 1 is expected only for diagnosed, explicitly baselined warnings.
    if returncode == 1 and not warnings:
        failed = True
    return not failed


def main():
    result = subprocess.run(
        ["qedgen", "check", "--spec", "privacy_cash.qedspec", "--json"],
        cwd=Path(__file__).resolve().parents[2] / "verification",
        capture_output=True,
        text=True,
        check=False,
    )
    print(result.stderr, file=sys.stderr, end="")
    try:
        valid = validate(json.loads(result.stdout), result.returncode)
    except (ValueError, KeyError, TypeError) as error:
        print(f"Invalid QEDGen diagnostic output: {error}", file=sys.stderr)
        return 1
    if not valid:
        print("Spec check failed: new diagnostics or a tool failure.", file=sys.stderr)
        return 1
    print("Spec check passed against the documented warning baseline.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
