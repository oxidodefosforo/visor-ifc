import type * as FRAGS from "@thatopen/fragments";
import * as WEBIFC from "web-ifc";

/** IFCSLAB -> IfcSlab, usando los nombres de clase del esquema de web-ifc. */
const CLASS_NAMES = new Map<string, string>();
for (const schema of [WEBIFC.IFC2X3, WEBIFC.IFC4, WEBIFC.IFC4X3]) {
  for (const name of Object.keys(schema ?? {})) if (/^Ifc/.test(name)) CLASS_NAMES.set(name.toUpperCase(), name);
}
export const prettyClass = (c: string | null) => (c ? (CLASS_NAMES.get(c.toUpperCase()) ?? c) : null);

/** value = texto mostrado (con unidad); raw = valor original del IFC (para copiar/pruebas). */
export type PropertyRow = { name: string; value: string; raw?: unknown; unit?: string };
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
  storey: { name: string; elevation: number | null } | null;
  parent: { name: string | null; ifcClass: string | null } | null;
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

// ---------------- Unidades ----------------
/** Unidades del proyecto por tipo (LENGTHUNIT → "mm", AREAUNIT → "m²"…). */
export type ProjectUnits = Partial<Record<string, string>>;

const SI_PREFIX: Record<string, string> = {
  EXA: "E", PETA: "P", TERA: "T", GIGA: "G", MEGA: "M", KILO: "k", HECTO: "h", DECA: "da",
  DECI: "d", CENTI: "c", MILLI: "m", MICRO: "µ", NANO: "n", PICO: "p",
};
const SI_NAME: Record<string, string> = {
  METRE: "m", SQUARE_METRE: "m²", CUBIC_METRE: "m³", GRAM: "g", SECOND: "s", RADIAN: "rad",
  STERADIAN: "sr", KELVIN: "K", DEGREE_CELSIUS: "°C", AMPERE: "A", VOLT: "V", WATT: "W",
  PASCAL: "Pa", NEWTON: "N", JOULE: "J", HERTZ: "Hz", LUMEN: "lm", LUX: "lx", CANDELA: "cd",
  MOLE: "mol", OHM: "Ω", COULOMB: "C", FARAD: "F", HENRY: "H", WEBER: "Wb", TESLA: "T",
  SIEMENS: "S", BECQUEREL: "Bq", GRAY: "Gy", SIEVERT: "Sv", LITRE: "L",
};
const CONVERSION_NAME: Record<string, string> = {
  FOOT: "ft", INCH: "in", YARD: "yd", MILE: "mi", "SQUARE FOOT": "ft²", "SQUARE INCH": "in²",
  "CUBIC FOOT": "ft³", "CUBIC INCH": "in³", DEGREE: "°", POUND: "lb", GALLON: "gal",
  "US GALLON": "gal", LITRE: "L", LITER: "L", "SQUARE YARD": "yd²", ACRE: "ac",
};
/** Tipo de medida IFC → tipo de unidad del proyecto. */
const MEASURE_UNIT: Record<string, string> = {
  IFCLENGTHMEASURE: "LENGTHUNIT", IFCPOSITIVELENGTHMEASURE: "LENGTHUNIT", IFCNONNEGATIVELENGTHMEASURE: "LENGTHUNIT",
  IFCAREAMEASURE: "AREAUNIT", IFCVOLUMEMEASURE: "VOLUMEUNIT", IFCMASSMEASURE: "MASSUNIT",
  IFCPLANEANGLEMEASURE: "PLANEANGLEUNIT", IFCPOSITIVEPLANEANGLEMEASURE: "PLANEANGLEUNIT",
  IFCTIMEMEASURE: "TIMEUNIT", IFCTHERMODYNAMICTEMPERATUREMEASURE: "THERMODYNAMICTEMPERATUREUNIT",
  IFCELECTRICCURRENTMEASURE: "ELECTRICCURRENTUNIT", IFCELECTRICVOLTAGEMEASURE: "ELECTRICVOLTAGEUNIT",
  IFCPOWERMEASURE: "POWERUNIT", IFCPRESSUREMEASURE: "PRESSUREUNIT", IFCFORCEMEASURE: "FORCEUNIT",
  IFCENERGYMEASURE: "ENERGYUNIT", IFCFREQUENCYMEASURE: "FREQUENCYUNIT", IFCILLUMINANCEMEASURE: "ILLUMINANCEUNIT",
  IFCLUMINOUSFLUXMEASURE: "LUMINOUSFLUXUNIT", IFCVOLUMETRICFLOWRATEMEASURE: "VOLUMETRICFLOWRATEUNIT",
  IFCMASSFLOWRATEMEASURE: "MASSFLOWRATEUNIT", IFCLINEARVELOCITYMEASURE: "LINEARVELOCITYUNIT",
  IFCMASSDENSITYMEASURE: "MASSDENSITYUNIT", IFCHEATFLUXDENSITYMEASURE: "HEATFLUXDENSITYUNIT",
  IFCTHERMALTRANSMITTANCEMEASURE: "THERMALTRANSMITTANCEUNIT",
};
/** Cantidades IFC (IfcQuantityLength…) → tipo de unidad. */
const QUANTITY_UNIT: Record<string, string> = {
  LengthValue: "LENGTHUNIT", AreaValue: "AREAUNIT", VolumeValue: "VOLUMEUNIT", WeightValue: "MASSUNIT", TimeValue: "TIMEUNIT",
};

const SUPERSCRIPT: Record<string, string> = { "1": "", "2": "²", "3": "³", "4": "⁴" };

function namedUnitSymbol(u: ItemData): string | null {
  const cat = String(attr(u, "_category") ?? "").toUpperCase();
  const name = String(attr(u, "Name") ?? "").toUpperCase();
  if (cat === "IFCSIUNIT") {
    const base = SI_NAME[name];
    if (!base) return null;
    const prefix = SI_PREFIX[String(attr(u, "Prefix") ?? "").toUpperCase()] ?? "";
    return prefix + base;
  }
  if (cat === "IFCCONVERSIONBASEDUNIT") return CONVERSION_NAME[name] ?? (name ? name.toLowerCase() : null);
  if (cat === "IFCDERIVEDUNIT") {
    const num: string[] = [], den: string[] = [];
    for (const el of isList(u.Elements) ? u.Elements : []) {
      const exp = Number(attr(el, "Exponent") ?? 1);
      const inner = isList(el.Unit) ? el.Unit[0] : undefined;
      const sym = inner ? namedUnitSymbol(inner) : null;
      if (!sym || !exp) return null;
      (exp > 0 ? num : den).push(sym + (SUPERSCRIPT[String(Math.abs(exp))] ?? `^${Math.abs(exp)}`));
    }
    if (!num.length && !den.length) return null;
    return (num.join("·") || "1") + (den.length ? "/" + den.join("·") : "");
  }
  return null;
}

/** Lee IFCPROJECT → UnitsInContext → Units. Sin efectos si el IFC no las declara. */
export async function readProjectUnits(model: {
  getItemsOfCategories(c: RegExp[]): Promise<Record<string, number[]>>;
  getItemsData(ids: number[], cfg: Partial<FRAGS.ItemsDataConfig>): Promise<ItemData[]>;
}): Promise<ProjectUnits> {
  const ids = Object.values(await model.getItemsOfCategories([/^IFCPROJECT$/])).flat();
  if (!ids.length) return {};
  const [project] = await model.getItemsData([ids[0]], {
    attributesDefault: true,
    relations: {
      UnitsInContext: { attributes: true, relations: true },
      Units: { attributes: true, relations: true },
      Elements: { attributes: true, relations: true },
      Unit: { attributes: true, relations: true },
    },
    relationsDefault: { attributes: false, relations: false },
  });
  const out: ProjectUnits = {};
  const assignments = isList(project?.UnitsInContext) ? project.UnitsInContext : [];
  for (const a of assignments) {
    for (const u of isList(a.Units) ? a.Units : []) {
      const type = String(attr(u, "UnitType") ?? "").toUpperCase();
      const sym = namedUnitSymbol(u);
      if (type && sym && !out[type]) out[type] = sym;
    }
  }
  return out;
}

function roundNice(n: number) {
  if (Number.isInteger(n)) return String(n);
  const abs = Math.abs(n);
  const decimals = abs >= 100 ? 2 : abs >= 1 ? 3 : 4;
  return String(Number(n.toFixed(decimals)));
}

/** Formatea un ItemAttribute con su unidad (según tipo de medida y unidades del proyecto). */
function formatAttr(a: Attr, units: ProjectUnits, unitTypeHint?: string): { value: string; unit?: string } {
  const v = a.value;
  const measure = String(a.type ?? "").toUpperCase();
  const unitType = MEASURE_UNIT[measure] ?? (measure.endsWith("MEASURE") || !measure ? unitTypeHint : undefined);
  const unit = unitType ? units[unitType] : undefined;
  if (typeof v === "number" && unit) {
    let text = `${roundNice(v)} ${unit}`;
    if (unit === "rad") text += ` (${roundNice((v * 180) / Math.PI)}°)`;
    return { value: text, unit };
  }
  if (typeof v === "number") return { value: roundNice(v) };
  return { value: formatValue(v) };
}

/** Atributos directos que se muestran en "Atributos IFC" (además de los fijos). */
const SKIP_ATTRS = new Set(["_localId", "_category", "_guid", "GlobalId", "Name", "OwnerHistory"]);

/** Extrae el valor de una IfcProperty (Single, Enumerated, List, Bounded) o IfcPhysicalQuantity. */
function propertyRow(p: ItemData, units: ProjectUnits): PropertyRow | null {
  const name = str(attr(p, "Name"));
  if (!name) return null;
  const valueKeys = [
    "NominalValue", "EnumerationValues", "ListValues", "LowerBoundValue", "UpperBoundValue",
    "LengthValue", "AreaValue", "VolumeValue", "CountValue", "WeightValue", "TimeValue", "Value",
  ];
  for (const k of valueKeys) {
    const raw = p[k];
    if (raw === undefined) continue;
    if (isAttr(raw)) return { name, raw: raw.value, ...formatAttr(raw, units, QUANTITY_UNIT[k]) };
    if (isList(raw)) {
      const parts = raw.map((x) => (isAttr(x) ? formatAttr(x as unknown as Attr, units).value : formatValue(x)));
      return { name, value: parts.join(", "), raw: parts };
    }
  }
  // Valor no reconocido: se muestra cualquier atributo *Value
  for (const [k, raw] of Object.entries(p)) {
    if (/Value$/.test(k) && isAttr(raw)) return { name, raw: raw.value, ...formatAttr(raw, units) };
  }
  return { name, value: "—" };
}

function readPropertyDefinition(def: ItemData, source: PropertySet["source"], units: ProjectUnits): PropertySet | null {
  const cat = String(attr(def, "_category") ?? "").toUpperCase();
  const name = str(attr(def, "Name")) ?? "(sin nombre)";
  const rows = (list: unknown) =>
    (isList(list) ? list : []).map((p) => propertyRow(p, units)).filter(Boolean) as PropertyRow[];
  if (cat === "IFCPROPERTYSET") return { name, kind: "pset", source, properties: rows(def.HasProperties) };
  if (cat === "IFCELEMENTQUANTITY") return { name, kind: "qto", source, properties: rows(def.Quantities) };
  return null;
}

/**
 * Convierte el resultado de FragmentsModel.getItemsData() en una estructura
 * plana para la interfaz. Tolera que falten relaciones (IFC incompletos).
 */
export function parseItemData(
  item: ItemData,
  ids: { localId: number; guid: string | null },
  units: ProjectUnits = {},
): ElementInfo {
  const psets: PropertySet[] = [];

  let typeName: string | null = null;
  let typeClass: string | null = null;
  const materials = new Set<string>();

  const readType = (type: ItemData) => {
    typeName ??= str(attr(type, "Name"));
    typeClass ??= str(attr(type, "_category"));
    for (const def of isList(type.HasPropertySets) ? type.HasPropertySets : []) {
      const ps = readPropertyDefinition(def, "tipo", units);
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
      const ps = readPropertyDefinition(def, "instancia", units);
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
    attributes.push({ name: k, raw: v.value, ...formatAttr(v, units) });
  }

  // Nivel (IfcBuildingStorey). La elevación llega ya convertida a metros por el importador
  // (verificado: 11399.99 mm en el IFC → 11.4).
  const container = isList(item.ContainedInStructure) ? item.ContainedInStructure[0] : undefined;
  const storey = container
    ? {
        name: str(attr(container, "Name")) ?? str(attr(container, "LongName")) ?? "(sin nombre)",
        elevation: typeof attr(container, "Elevation") === "number" ? (attr(container, "Elevation") as number) : null,
      }
    : null;
  const parentItem = isList(item.Decomposes) ? item.Decomposes[0] : undefined;
  const parent = parentItem
    ? { name: str(attr(parentItem, "Name")), ifcClass: prettyClass(str(attr(parentItem, "_category"))) }
    : null;

  return {
    localId: ids.localId,
    globalId: ids.guid ?? str(attr(item, "_guid")) ?? str(attr(item, "GlobalId")),
    ifcClass: prettyClass(str(attr(item, "_category"))),
    name: str(attr(item, "Name")),
    attributes,
    typeName,
    typeClass: prettyClass(typeClass),
    materials: [...materials],
    storey,
    parent,
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
