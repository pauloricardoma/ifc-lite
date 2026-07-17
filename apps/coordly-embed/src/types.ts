// Espelha web/src/Data/interfaces/Viewer/IIfcArtifacts.ts (contrato do §7 do next_06).
export interface IfcGeometryContainer { layout: 'container'; geometry: string; }
export interface IfcGeometrySplit { layout: 'split'; mesh: string; vertex: string; index: string; }

export interface IfcArtifacts {
  status: string;
  urls?: {
    geometry: IfcGeometryContainer | IfcGeometrySplit;
    metadata: string;
    datamodel?: string;
    symbolic?: string;
  };
}
