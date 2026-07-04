---
"@ifc-lite/clash": minor
---

Clash-to-BCF export (`createBCFFromClashResult`) now records a markup `<Header>` source file per distinct model each clash group spans, derived from the group members' `model` names. A cross-model clash topic therefore round-trips the provenance of both models it references (issue #1591). Topics with no resolvable model name are unaffected.
