---
description: Diagnose why a Xingular run stopped short and propose the fix
argument-hint: "[run-id|latest|latest-unfinished] [what you expected]"
---
Run forensics using the `xingular-run-forensics` skill: read its SKILL.md and follow its steps in order. The requested selector is `${1:-current-session}`. For `current-session`, call `trajectory_read({run:'current'})` to obtain the full invoking run id, then pass it to the digest as `current-session --current-run <full-id>`. Do not substitute a global selector if identity or ordering is unavailable.

What the person expected from that run: ${@:2}
