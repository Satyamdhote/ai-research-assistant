---
name: milestone-log
description: Append a new milestone section to learning.md (concepts, problems hit, takeaways) after a milestone is implemented and confirmed.
disable-model-invocation: true
---

Append one new section to `learning.md` at the repo root for the milestone just completed: $ARGUMENTS

1. Read the tail of `learning.md` to match the existing heading style, numbering and tone.
2. Append the section at the end. Never edit or rewrite earlier sections.
3. Cover: the concepts learned, problems hit and how they were resolved, and key takeaways. Explain the reasoning, since the goal is understanding rather than a changelog.
4. Show the user the appended text. Do not stage or commit it; `learning.md` changes are committed only when the user asks.
