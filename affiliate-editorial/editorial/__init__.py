"""Private editorial manager and static public site builder for an
Amazon.co.jp product introduction site.

The package is deliberately small and dependency-light (stdlib + Jinja2) so
that it runs on the owner's Mac with the system Python 3.9+ as well as on a
small server.  See ../README.md for the workflow and safety rules.
"""

__version__ = "0.1.0"

# Bumped whenever public templates change in a way that alters rendered
# output.  It is part of the publish-context hash, so a template change
# requires re-approval of unpublished approvals.
TEMPLATE_VERSION = "2026-10-05.1"
