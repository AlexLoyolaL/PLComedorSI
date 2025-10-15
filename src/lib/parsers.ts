export type ItemType = "MENU" | "VEGGIE";
export type Destination = { mode: "COMEDOR" | "VIANDA"; table: string | null };

export function normalizeItemType(raw: string): ItemType {
  const t = raw.trim().toUpperCase();
  if (t === "VEGGIE" || t === "DIETA") return "VEGGIE";
  return "MENU";
}

function clean(s: string) {
  // normaliza: mayúsculas, quita “ENVIAR”, separadores, múltiples espacios
  return s
    .replace(/[\r\n\t]+/g, " ")
    .replace(/={2,}.*?={2,}/gi, " ")   // elimina ===Inicio...=== ===Fin...===
    .replace(/\bENVIAR\b/gi, " ")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Acepta: "MENU\nMESA 01", "MENU MESA 01", "DIETA VIANDA", "VEGGIE MESA01", etc.
export function parseOrderQR(qrText: string): { itemType: ItemType; dest: Destination } {
  const txt = clean(qrText);

  // Detectar tipo
  let itemType: ItemType | null = null;
  if (/\bDIETA\b/.test(txt) || /\bVEGGIE\b/.test(txt)) itemType = "VEGGIE";
  else if (/\bMENU\b/.test(txt)) itemType = "MENU";

  if (!itemType) throw new Error("QR de comida inválido: no se reconoce el tipo (MENU/VEGGIE/DIETA).");

  // Destino: VIANDA o MESA XX
  if (/\bVIANDA\b/.test(txt)) {
    return { itemType, dest: { mode: "VIANDA", table: null } };
  }

  // MESA con número (acepta “MESA01”, “MESA 01”, “MESA:01”, etc.)
  const mesaMatch = txt.match(/\bMESA\s*[:\-]?\s*(\d{1,2})\b/);
  if (mesaMatch) {
    const num = mesaMatch[1].padStart(2, "0");
    return { itemType, dest: { mode: "COMEDOR", table: `MESA ${num}` } };
  }

  throw new Error("QR de comida inválido: falta VIANDA o MESA XX.");
}

// util para validaciones de mesa
export function mesaOk(itemType: ItemType, table: string) {
  const num = parseInt(table.replace(/[^\d]/g, ""), 10);
  if (Number.isNaN(num)) return false;
  if (itemType === "MENU")   return num >= 1 && num <= 21;
  if (itemType === "VEGGIE") return num >= 22 && num <= 23;
  return false;
}

// Carnet: primera línea no vacía como ID
export function parseMemberQR(qrText: string): { memberId: string } {
  const first = (qrText.split(/\r?\n/).map(s => s.trim()).find(Boolean) ?? "").toUpperCase();
  if (!first) throw new Error("QR de carnet inválido");
  return { memberId: first };
}
