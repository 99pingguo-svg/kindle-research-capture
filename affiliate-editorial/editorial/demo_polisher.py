"""Stand-in for Antigravity CLI used only by the demo data directory.

It returns the text unchanged so the whole workflow can be tried before
Antigravity CLI is installed.  The demo config labels it clearly; real data
directories use the configured Antigravity command.
"""

import json
import sys


def main() -> int:
    prompt = sys.stdin.read()
    start = prompt.find("{")
    if start < 0:
        print("no JSON found", file=sys.stderr)
        return 1
    data = json.loads(prompt[start:])
    print(json.dumps(data, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
