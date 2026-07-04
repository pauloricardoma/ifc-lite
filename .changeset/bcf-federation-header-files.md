---
"@ifc-lite/bcf": minor
---

`BCFTopic` gains an optional `header?: BCFHeaderFile[]` field: the source IFC file(s) a topic refers to (markup `<Header>`), one entry per distinct model a federated topic spans, so a topic round-trips the provenance of every model it touches (issue #1591).

`writeBCF` now emits the `<Header>` block (version-correct: BCF 2.1 nests `<File>` directly, BCF 3.0 wraps them in `<Files>`), and `readBCF` parses it back into `topic.header`. Both are additive: topics without header files emit no `<Header>` element and existing markup output is unchanged.
