---
description: Diagnose why a Xingular run stopped short and propose the fix
argument-hint: "[run-id|latest|latest-unfinished] [what you expected]"
---
Run forensics on Xingular run `${1:-latest-unfinished}`, using the `xingular-run-forensics` skill: read its SKILL.md and follow its steps in order.

What the person expected from that run: ${@:2}
