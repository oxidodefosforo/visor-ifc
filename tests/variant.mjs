// Genera una «segunda versión» de un IFC real con cambios conocidos, para probar «Comparar».
// Se parte del IFC original y se modifica con web-ifc (no se inventa geometría):
//   1. Un muro cambia de GlobalId          → debe salir 1 eliminado + 1 nuevo.
//   2. Una viga cambia el valor de su marca → modificado (propiedades) en todos los elementos que
//      comparten ese conjunto de propiedades.
//   3. Un pilar se desplaza 500 mm en X      → modificado (geometría).
import * as WebIFC from "web-ifc";
import { readFileSync, writeFileSync } from "node:fs";

const val = (v) => (v && typeof v === "object" && "value" in v ? v.value : v);

export async function makeVariant(src, out) {
  const api = new WebIFC.IfcAPI();
  await api.Init();
  const m = api.OpenModel(new Uint8Array(readFileSync(src)));
  let next = api.GetMaxExpressID(m) + 1;
  const first = (type) => api.GetLineIDsWithType(m, type).get(0);

  // 1. Muro con otro GlobalId
  const wallId = first(WebIFC.IFCWALL);
  const wall = api.GetLine(m, wallId);
  const oldWallGuid = val(wall.GlobalId);
  const newWallGuid = oldWallGuid.slice(0, -4) + (oldWallGuid.endsWith("ZZZZ") ? "YYYY" : "ZZZZ");
  wall.GlobalId.value = newWallGuid;
  api.WriteLine(m, wall);

  // 2. Marca de una viga (Identidad · Marca): se crea un valor nuevo para no tocar otros conjuntos
  const rels = api.GetLineIDsWithType(m, WebIFC.IFCRELDEFINESBYPROPERTIES);
  let changedGuids = [], beamGuid = null, oldMark = null, newMark = null;
  for (let i = 0; i < rels.size() && !beamGuid; i++) {
    const rel = api.GetLine(m, rels.get(i));
    const objs = rel.RelatedObjects.map(val);
    if (!objs.some((o) => api.GetLineType(m, o) === WebIFC.IFCBEAM)) continue;
    const pset = api.GetLine(m, val(rel.RelatingPropertyDefinition));
    if (val(pset.Name) !== "Identidad" || !pset.HasProperties) continue;
    const idx = pset.HasProperties.findIndex((h) => val(api.GetLine(m, val(h)).Name) === "Marca");
    if (idx < 0) continue;
    const prop = api.GetLine(m, val(pset.HasProperties[idx]));
    oldMark = String(val(prop.NominalValue));
    newMark = `${oldMark}-REV2`;
    prop.expressID = next++;
    prop.NominalValue.value = newMark;
    api.WriteLine(m, prop);
    pset.HasProperties[idx] = new WebIFC.Handle(prop.expressID);
    api.WriteLine(m, pset);
    // todos los elementos con ese mismo pset (por si se comparte)
    for (let j = 0; j < rels.size(); j++) {
      const r = api.GetLine(m, rels.get(j));
      if (val(r.RelatingPropertyDefinition) === pset.expressID) for (const o of r.RelatedObjects) changedGuids.push(val(api.GetLine(m, val(o)).GlobalId));
    }
    beamGuid = val(api.GetLine(m, objs.find((o) => api.GetLineType(m, o) === WebIFC.IFCBEAM)).GlobalId);
  }

  // 3. Pilar desplazado 500 mm en X (unidades del proyecto: mm en el modelo de prueba)
  const colId = first(WebIFC.IFCCOLUMN);
  const col = api.GetLine(m, colId);
  const lp = api.GetLine(m, val(col.ObjectPlacement));
  const ax = api.GetLine(m, val(lp.RelativePlacement));
  const pt = api.GetLine(m, val(ax.Location));
  const lengthUnitIsMm = readFileSync(src, "latin1").includes(".MILLI.,.METRE.");
  pt.expressID = next++;
  // NumberHandle de web-ifc: el valor interno debe ser texto (si no, BindingError al escribir)
  pt.Coordinates[0].value = String(Number(pt.Coordinates[0].value) + (lengthUnitIsMm ? 500 : 0.5));
  api.WriteLine(m, pt);
  ax.expressID = next++;
  ax.Location = new WebIFC.Handle(pt.expressID);
  api.WriteLine(m, ax);
  lp.expressID = next++;
  lp.RelativePlacement = new WebIFC.Handle(ax.expressID);
  api.WriteLine(m, lp);
  col.ObjectPlacement = new WebIFC.Handle(lp.expressID);
  api.WriteLine(m, col);
  const movedGuid = val(col.GlobalId);

  writeFileSync(out, api.SaveModel(m));
  api.CloseModel(m);
  return { oldWallGuid, newWallGuid, beamGuid, changedGuids: [...new Set(changedGuids)], oldMark, newMark, movedGuid };
}
