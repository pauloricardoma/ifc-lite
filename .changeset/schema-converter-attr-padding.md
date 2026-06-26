---
"@ifc-lite/export": patch
---

Fix IFC2X3 → IFC4/IFC4X3 schema conversion producing invalid entities. The converter trimmed
trailing attributes when downgrading but never **padded** the new trailing attributes that
newer schemas added (e.g. `PredefinedType` on `IfcWall` / `IfcBeam` / `IfcOpeningElement` /
`IfcFastener` / …, the IfcDoor/IfcWindow additions, `IfcMaterial.Category`, etc.). Upgraded
entities were left a positional attribute short and rejected by strict readers (e.g. BIM
Vision). Padding is now driven by the generated buildingSMART attribute tables
(`@ifc-lite/data`), so any added trailing attribute is filled with `$` (valid — the additions
are optional), scoped to upconversion so the downconversion trim path is untouched.

Also tolerate whitespace after `=` in `convertStepLine` (e.g. Tekla's `#34498= IFCWALL(...)`);
such lines previously failed the entity-line regex and passed through **unconverted**, so
neither type renames nor attribute adjustment applied. Validated end-to-end with ifcopenshell:
a federated IFC2X3 + IFC4X3 → IFC4 export went from 2556 "Invalid attribute value" errors to 0
(remaining issues are pre-existing source-data defects). ([#1416](https://github.com/LTplus-AG/ifc-lite/issues/1416))
