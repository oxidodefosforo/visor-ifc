import type * as FRAGS from "@thatopen/fragments";
import * as WEBIFC from "web-ifc";

/** IFCSLAB -> IfcSlab, usando los nombres de clase del esquema de web-ifc. */
const CLASS_NAMES = new Map<string, string>();
for (const schema of [WEBIFC.IFC2X3, WEBIFC.IFC4, WEBIFC.IFC4X3]) {
  for (const name of Object.keys(schema ?? {})) if (/^Ifc/.test(name)) CLASS_NAMES.set(name.toUpperCase(), name);
}
export const prettyClass = (c: string | null) => (c ? (CLASS_NAMES.get(c.toUpperCase()) ?? c) : null);

export type PropertyRow = { name: string; value: string; unit?: string };
export type PropertySet = { name: string; kind: "pset" | "qto"; source: "instancia" | "tipo"; properties: PropertyRow[] };

export type ElementInfo = {
  localId: number;
  globalId: string | null;
  ifcClass: string | null;
  name: string | null;
  attributes: PropertyRow[];
  typeName: string | null;
  typeClass: string | null;
  materials: string[];
  propertySets: PropertySet[];
};

type ItemData = FRAGS.ItemData;
type Attr = FRAGS.ItemAttribute;

const isAttr = (v: unknown): v is Attr => !!v && typeof v === "object" && !Array.isArray(v) && "value" in v;
const isList = (v: unknown): v is ItemData[] => Array.isArray(v);

function attr(item: ItemData | undefined, key: string): unknown {
  const v = item?.[key];
  return isAttr(v) ? v.value : undefined;
}

function str(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  return String(v);
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "Sí" : "No";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6);
  if (Array.isArray(v)) return v.map(formatValue).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  // Los booleanos/lógicos IFC llegan como ".T." / ".F." en algunos exportadores
  if (v === ".T." || v === "T") return "Sí";
  if (v === ".F." || v === "F") return "No";
  return String(v);
}

/** Atributos directos que se muestran en "Atributos IFC" (además de los fijos). */
const SKIP_ATTRS = new Set(["_localId", "_category", "_guid", "GlobalId", "Name", "OwnerHistory"]);

/** Extrae el valor de una IfcProperty (Single, Enumerated, List, Bounded) o IfcPhysicalQuantity. */
function propertyRow(p: ItemData): PropertyRow | null {
  const name = str(attr(p, "Name"));
  if (!name) return null;
  const valueKeys = [
    "NominalValue", "EnumerationValues", "ListValues", "LowerBoundValue", "UpperBoundValue",
    "LengthValue", "AreaValue", "VolumeValue", "CountValue", "WeightValue", "TimeValue", "Value",
  ];
  for (const k of valueKeys) {
    const raw = p[k];
    if (raw === undefined) continue;
    if (isAttr(raw)) return { name, value: formatValue(raw.value) };
    if (isList(raw)) return { name, value: raw.map((x) => formatValue(isAttr(x) ? x.value : x)).join(", ") };
  }
  // Valor no reconocido: se muestra cualquier atributo *Value
  for (const [k, raw] of Object.entries(p)) {
    if (/Value$/.test(k) && isAttr(raw)) return { name, value: formatValue(raw.value) };
  }
  return { name, value: "—" };
}

function readPropertyDefinition(def: ItemData, source: PropertySet["source"]): PropertySet | null {
  const cat = String(attr(def, "_category") ?? "").toUpperCase();
  const name = str(attr(def, "Name")) ?? "(sin nombre)";
  if (cat === "IFCPROPERTYSET") {
    const props = (isList(def.HasProperties) ? def.HasProperties : []).map(propertyRow).filter(Boolean) as PropertyRow[];
    return { name, kind: "pset", source, properties: props };
  }
  if (cat === "IFCELEMENTQUANTITY") {
    const props = (isList(def.Quantities) ? def.Quantities : []).map(propertyRow).filter(Boolean) as PropertyRow[];
    return { name, kind: "qto", source, properties: props };
  }
  return null;
}

/**
 * Convierte el resultado de FragmentsModel.getItemsData() en una estructura
 * plana para la interfaz. Tolera que falten relaciones (IFC incompletos).
 */
export function parseItemData(item: ItemData, ids: { localId: number; guid: string | null }): ElementInfo {
  const psets: PropertySet[] = [];

  let typeName: string | null = null;
  let typeClass: string | null = null;
  const materials = new Set<string>();

  const readType = (type: ItemData) => {
    typeName ??= str(attr(type, "Name"));
    typeClass ??= str(attr(type, "_category"));
    for (const def of isList(type.HasPropertySets) ? type.HasPropertySets : []) {
      const ps = readPropertyDefinition(def, "tipo");
      if (ps) psets.push(ps);
    }
    collectMaterials(type, materials);
  };

  // Forma observada en Fragments 3.4: IsDefinedBy ya "aplanado" -> contiene
  // directamente IfcPropertySet / IfcElementQuantity y el objeto de tipo.
  // Se admite también la forma IFC "pura" (IfcRelDefinesByProperties/ByType).
  const defs = isList(item.IsDefinedBy) ? item.IsDefinedBy : [];
  for (const d of defs) {
    const nested = isList(d.RelatingPropertyDefinition)
      ? d.RelatingPropertyDefinition
      : isList(d.RelatingType)
        ? d.RelatingType
        : [d];
    for (const def of nested) {
      const ps = readPropertyDefinition(def, "instancia");
      if (ps) psets.push(ps);
      else if (isTypeObject(def)) readType(def);
    }
  }
  const typed = isList(item.IsTypedBy) ? item.IsTypedBy : [];
  for (const t of typed) {
    for (const type of isList(t.RelatingType) ? t.RelatingType : [t]) readType(type);
  }
  collectMaterials(item, materials);

  const attributes: PropertyRow[] = [];
  for (const [k, v] of Object.entries(item)) {
    if (SKIP_ATTRS.has(k) || !isAttr(v)) continue;
    attributes.push({ name: k, value: formatValue(v.value) });
  }

  return {
    localId: ids.localId,
    globalId: ids.guid ?? str(attr(item, "_guid")) ?? str(attr(item, "GlobalId")),
    ifcClass: prettyClass(str(attr(item, "_category"))),
    name: str(attr(item, "Name")),
    attributes,
    typeName,
    typeClass: prettyClass(typeClass),
    materials: [...materials],
    propertySets: psets,
  };
}

function isTypeObject(def: ItemData) {
  const cat = String(attr(def, "_category") ?? "").toUpperCase();
  return /TYPE$|STYLE$/.test(cat) || "HasPropertySets" in def || "ObjectTypeOf" in def;
}

/** Nombres de material de HasAssociations (IfcMaterial, conjuntos de capas/constituyentes…). */
function collectMaterials(item: ItemData, out: Set<string>, depth = 0) {
  if (depth > 3) return;
  for (const a of isList(item.HasAssociations) ? item.HasAssociations : []) {
    const cat = String(attr(a, "_category") ?? "").toUpperCase();
    if (cat.startsWith("IFCMATERIAL")) {
      const n = str(attr(a, "Name")) ?? str(attr(a, "LayerSetName"));
      if (n) out.add(n);
    }
    for (const v of Object.values(a)) {
      if (isList(v)) for (const child of v) {
        const n = str(attr(child, "Name"));
        if (n && String(attr(child, "_category") ?? "").toUpperCase().startsWith("IFCMATERIAL")) out.add(n);
      }
    }
    collectMaterials(a, out, depth + 1);
  }
}
