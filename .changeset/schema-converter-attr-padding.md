---
"@ifc-lite/export": patch
---

Fix IFC2X3 → IFC4/IFC4X3 schema conversion producing invalid entities. The converter trimmed
trailing attributes when downgrading but never **padded** the new trailing attributes that
newer schemas added (e.g. `PredefinedType` on `IfcWall` / `IfcBeam` / `IfcOpeningElement` /
`IfcFastener` / …, the IfcDoor/IfcWindow additions, `IfcMaterial.Category`, etc.). Upgraded
entities were left a positional attribute short and rejected by strict readers (e.g. BIM
Vision). Padding is driven by the generated buildingSMART attribute tables (`@ifc-lite/data`),
scoped to upconversion so the downconversion trim path is untouched.

Padding is applied **only when the source attribute name-list is a strict prefix of the
target's** (i.e. the newer schema merely appended attributes). Many entities insert/reorder
attributes mid-list — e.g. `IfcMaterialProperties` (`[Material]` → `[Name, Description,
Properties, Material]`), `IfcApproval`, `IfcTask` — where blindly appending `$` would shift
values into the wrong, type-invalid slots; those are left untouched. All headline targets
(`IfcWall`/`Beam`/`Column`/`Member`/`Plate`/`OpeningElement`/`Door`/`Window`/`Fastener`/
`MechanicalFastener`/`Grid`, `IfcMaterial`) are prefix-safe, so the intended fix is preserved.

Also tolerate whitespace after `=` in `convertStepLine` (e.g. Tekla's `#34498= IFCWALL(...)`);
such lines previously failed the entity-line regex and passed through **unconverted**, so
neither type renames nor attribute adjustment applied. Validated end-to-end with ifcopenshell:
a federated IFC2X3 + IFC4X3 → IFC4 export went from 2556 "Invalid attribute value" errors to 0
(remaining issues are pre-existing source-data defects). ([#1416](https://github.com/LTplus-AG/ifc-lite/issues/1416))
