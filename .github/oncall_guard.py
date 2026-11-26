#!/usr/bin/env python3
"""Decide whether an on-call branch may merge itself (edge oncall/PROTOCOL.md; kit from oracle-edge oncall/kit).

The workflow runs this file and reads ONCALL.json *from main*, never from the branch, so a branch can't loosen
its own rules. Prints `auto_merge=true|false` and `reason=...` for $GITHUB_OUTPUT.

    python3 oncall_guard.py <runbook.json> <base> <head>
"""
import fnmatch
import json
import subprocess
import sys


def matches(path, patterns):
    return any(fnmatch.fnmatch(path, p) or (p.endswith("/**") and path.startswith(p[:-2])) for p in patterns)


def main():
    book, base, head = json.load(open(sys.argv[1]))["fix"], sys.argv[2], sys.argv[3]
    rows = subprocess.run(["git", "diff", "--numstat", f"{base}...{head}"], capture_output=True, text=True,
                          check=True).stdout.splitlines()
    files, changed = [], 0
    for row in rows:
        added, deleted, path = row.split("\t", 2)
        files.append(path)
        changed += (int(added) if added.isdigit() else 0) + (int(deleted) if deleted.isdigit() else 0)
    never = [f for f in files if matches(f, book.get("never_edit", []))]
    held = book.get("auto_merge") is False  # a repo without real tests yet: every on-call PR waits for review
    protected = [f for f in files if matches(f, book.get("protected", []))]
    if never:
        verdict, reason = False, f"edits paths on-call may never touch: {', '.join(never)}"
    elif held:
        verdict, reason = False, book.get("why_review") or "this repo's on-call PRs wait for review"
    elif protected:
        verdict, reason = False, f"touches protected paths (Claude reviews): {', '.join(protected)}"
    elif changed > book.get("max_changed_lines", 120):
        verdict, reason = False, f"{changed} changed lines (limit {book.get('max_changed_lines', 120)})"
    elif not files:
        verdict, reason = False, "no changes"
    else:
        verdict, reason = True, f"{len(files)} file(s), {changed} lines, tests passed"
    print(f"auto_merge={'true' if verdict else 'false'}")
    print(f"reason={reason}")


if __name__ == "__main__":
    main()
