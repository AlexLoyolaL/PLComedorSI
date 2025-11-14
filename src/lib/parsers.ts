export type ItemType = "MENU" | "VEGGIE" | "CELIACO";

export type Destination = { mode: "COMEDOR" | "VIANDA"; table: string | null };

export function normalizeItemType(raw: string): ItemType {
  const t = raw.trim().toUpperCase();
  if (t === "CELIACO") return "CELIACO";
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

  // CELIACO o SIN TACC
  if (/\bCELIAC[OA]S?\b/.test(txt) || /\bSIN\s+TACC\b/.test(txt)) {
    itemType = "CELIACO";
  } else if (/\bDIETA\b/.test(txt) || /\bVEGGIE\b/.test(txt)) {
    itemType = "VEGGIE";
  } else if (/\bMENU\b/.test(txt)) {
    itemType = "MENU";
  }

  if (!itemType) {
    throw new Error(
      "QR de comida inválido: no se reconoce el tipo (MENU/VEGGIE/CELIACO)."
    );
  }

  // Destino: VIANDA o MESA XX
  if (/\bVIANDA\b/.test(txt)) {
    return { itemType, dest: { mode: "VIANDA", table: null } };
  }

  const mesaMatch = txt.match(/\bMESA\s*[:\-]?\s*(\d{1,2})\b/);
  if (mesaMatch) {
    const num = mesaMatch[1].padStart(2, "0");
    return { itemType, dest: { mode: "COMEDOR", table: `MESA ${num}` } };
  }

  throw new Error("QR de comida inválido: falta destino (MESA xx o VIANDA).");
}

// util para validaciones de mesa
// util para validaciones de mesa
export function mesaOk(itemType: ItemType, table: string) {
  const num = parseInt(table.replace(/[^\d]/g, ""), 10);
  if (Number.isNaN(num)) return false;

  // ✅ Mesa válida simplemente si está en el rango 1–34
  //    (no depende del tipo de vianda)
  return num >= 1 && num <= 34;
}


// Carnet: primera línea no vacía como ID
export function parseMemberQR(qrText: string): { memberId: string } {
  const first = (qrText.split(/\r?\n/).map(s => s.trim()).find(Boolean) ?? "").toUpperCase();
  if (!first) throw new Error("QR de carnet inválido");
  return { memberId: first };
}
