// src/lib/sales.ts
import { db } from "../firebase";
import {
  doc,
  runTransaction,
  serverTimestamp,
  increment,
  setDoc,
  getDoc,
  collection,
  onSnapshot,
  query,
  where,
  orderBy,
  getDocs,
} from "firebase/firestore";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import { mesaOk } from "./parsers";
import type { Destination, ItemType } from "./parsers";

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = "America/Argentina/Buenos_Aires";

// Capacidad por mesa
export function tableCapacityFromKey(key: string): number {
  const n = parseInt(String(key).replace(/[^\d]/g, ""), 10);
  if (!Number.isFinite(n)) return 9; // default por las dudas

  if (n >= 24 && n <= 34) {
    return 8; // Anexo
  }
  return 9;   // resto de mesas
}

// ============================================================================
// LÓGICA DE FECHAS (MODIFICADA PARA PREVENTA 27/05)
// ============================================================================

/** * Verifica si una fecha cae en la ventana de preventa.
 * (Del 15 al 26 de Mayo de 2026, de 14:00 a 23:59 hs).
 */
function isPreventaWindow(d: dayjs.Dayjs): boolean {
  return (
    d.year() === 2026 &&
    d.month() === 4 && // Mayo (Enero = 0)
    d.date() >= 15 &&
    d.date() <= 26 &&
    d.hour() >= 14
  );
}

/** Clave de día (TZ AR) */
export const todayKey = () => {
  const now = dayjs().tz(TZ);

  if (isPreventaWindow(now)) {
    return "2026-05-27"; // Bypass de Preventa
  }

  return now.format("YYYY-MM-DD");
};

export const keyFromDate = (date: Date) => {
  const d = dayjs(date).tz(TZ);

  if (isPreventaWindow(d)) {
    return "2026-05-27"; // Bypass de Preventa
  }

  return d.format("YYYY-MM-DD");
};

// ============================================================================

/** Normaliza label de mesa a clave corta p.ej. "M01" */
export function tableKey(table?: string | null) {
  if (!table) return null;
  const n = String(table).toUpperCase().replace(/[^\d]/g, "");
  if (!n) return null;
  return "M" + n.padStart(2, "0");
}

/** A partir de "M01" devuelve "MESA 01" */
export function tableLabelFromKey(key: string) {
  const n = key.replace(/[^\d]/g, "");
  return `MESA ${n.padStart(2, "0")}`;
}

// ---------- SETUP DEL DÍA ----------
export async function ensureDaySettings() {
  const key = todayKey();
  const ref = doc(db, "settings_day", key);
  const snap = await getDoc(ref);

  if (snap.exists()) {
    const data = snap.data() as any;
    const patch: any = {};

    if (!data.cutoffs) {
      patch.cutoffs = { comedor: "00:00", vianda: "00:00" };
    }

    if (!data.limits) {
      patch.limits = {
        MENU: null,
        VEGGIE: null,
        CELIACO: null,
      };
    } else if (data.limits && data.limits.CELIACO === undefined) {
      patch.limits = {
        ...data.limits,
        CELIACO: null,
      };
    }

    if (Object.keys(patch).length > 0) {
      await setDoc(ref, patch, { merge: true });
    }
    return;
  }

  // Si no existe, lo crea desde cero
  const tables: Record<string, number> = {};

  // Mesas 1–23 → 9 lugares
  for (let i = 1; i <= 23; i++) {
    tables[`MESA ${String(i).padStart(2, "0")}`] = 9;
  }

  // Mesas 24–34 → 8 lugares
  for (let i = 24; i <= 34; i++) {
    tables[`MESA ${String(i).padStart(2, "0")}`] = 8;
  }

  await setDoc(ref, {
    cutoffs: { comedor: "23:00", vianda: "23:00" },
    tables,
    limits: {
      MENU: null,
      VEGGIE: null,
      CELIACO: null,
    },
    createdAt: serverTimestamp(),
  });
}

// ---------- ALTA DE VENTA (VERSIÓN OFFLINE-READY + SUBVENCIONADOS) ----------
export async function createSaleTx(params: {
  seller: { uid: string; email: string; name: string };
  memberId: string;
  itemType: ItemType;
  dest: Destination;
  allowDouble: boolean;
}) {
  const key = todayKey();
  const settingsRef = doc(db, "settings_day", key);
  const aggRef = doc(db, "dayAgg", key);
  const indexRef = doc(db, "membersDayIndex", `${key}_${params.memberId}`);
  
  // ¡AQUÍ ESTÁ LA VARIABLE CLAVE PARA EL GABINETE!
  const subRef = doc(db, "subsidized_members", params.memberId);

  // Función auxiliar para leer documentos sin que explote estando offline
  async function getOfflineSafe(ref: any) {
    try {
      const snap = await getDoc(ref);
      return snap;
    } catch (e: any) {
      if (e.message?.toLowerCase().includes("offline") || e.code === "unavailable") {
        return { exists: () => false, data: () => ({}) }; // Finge que no existe
      }
      throw e;
    }
  }

  // 1) Obtenemos settings de manera segura
  const st = await getOfflineSafe(settingsRef);
  const settings = (st.exists() ? st.data() : {}) as any;

  // 3) Validaciones de mesa/tipo
  if (params.dest.mode === "COMEDOR") {
    if (!params.dest.table) throw new Error("Mesa obligatoria en COMEDOR");
    if (!mesaOk(params.itemType, params.dest.table)) {
      throw new Error("Mesa inválida. Usá mesas del 01 al 34.");
    }
  }

  // 4) Duplicado por socio (Seguro offline)
  const idx = await getOfflineSafe(indexRef);
  const prev = idx.exists() ? ((idx.data() as any)?.count as number) : 0;
  if (prev >= 1 && !params.allowDouble) {
    throw new Error("Socio ya tiene una compra hoy. Habilitar doble compra para continuar.");
  }

  // 5) Chequear subsidio y VENCIMIENTO (Seguro offline)
  const subSnap = await getOfflineSafe(subRef);
  const subData = subSnap.exists() ? (subSnap.data() as any) : null;
  
  const now = dayjs();
  const expiresAt = subData?.expiresAt ? dayjs(subData.expiresAt.toDate()) : null;
  
  // Es subvencionado si está activo y (no tiene fecha O la fecha es mayor a hoy)
  const isSubsidized = subData?.active === true && (!expiresAt || now.isBefore(expiresAt));

  // 6) Validación de límites diarios (Seguro offline)
  const aggSnap = await getOfflineSafe(aggRef);
  const baseAgg = aggSnap.exists() ? (aggSnap.data() as any) : {
    comedor: { MENU: 0, VEGGIE: 0, CELIACO: 0 },
    vianda: { MENU: 0, VEGGIE: 0, CELIACO: 0 }
  };

  const limits = (settings.limits ?? {}) as {
    MENU?: number | null;
    VEGGIE?: number | null;
    CELIACO?: number | null;
  };

  const totalByType: Record<string, number> = {
    MENU: (baseAgg.comedor?.MENU ?? 0) + (baseAgg.vianda?.MENU ?? 0),
    VEGGIE: (baseAgg.comedor?.VEGGIE ?? 0) + (baseAgg.vianda?.VEGGIE ?? 0),
    CELIACO: (baseAgg.comedor?.CELIACO ?? 0) + (baseAgg.vianda?.CELIACO ?? 0),
  };

  const limit = limits[params.itemType];
  if (typeof limit === "number" && limit >= 0 && totalByType[params.itemType] >= limit) {
    throw new Error(`Límite diario alcanzado para ${params.itemType}.`);
  }

  // 7) Alta de venta (Escritura simple)
  const saleRef = doc(db, "sales", crypto.randomUUID());
  setDoc(saleRef, {
    dateKey: key,
    ts: serverTimestamp(),
    seller: params.seller,
    member: { id: params.memberId },
    itemType: params.itemType,
    destination: params.dest,
    allowDouble: !!params.allowDouble,
    isSubsidized, // <-- MARCAMOS LA VENTA COMO SUBVENCIONADA
    voided: false,
    voidReason: null,
    voidedBy: null,
  });

  // 8) Sumar retiro si es subvencionado al contador de Gabinete
  if (isSubsidized) {
    setDoc(subRef, { totalWithdrawals: increment(1) }, { merge: true });
  }

  // 9) Índice socio/día
  setDoc(indexRef, { 
    count: increment(1), 
    lastTs: serverTimestamp() 
  }, { merge: true });

  // 10) Actualizar Agregados de Cocina
  const upd: any = { lastUpdated: serverTimestamp() };
  
  if (params.dest.mode === "COMEDOR") {
    const mesaK = tableKey(params.dest.table)!;
    upd.comedor = {
      [params.itemType]: increment(1),
      byTable: { [mesaK]: increment(1) }
    };
  } else {
    upd.vianda = { [params.itemType]: increment(1) };
  }

  // NUEVO: Agregación Financiera para Auditoría
  upd.financial = {
    paid: increment(isSubsidized ? 0 : 1),
    subsidized: increment(isSubsidized ? 1 : 0)
  };

  setDoc(aggRef, upd, { merge: true });
}

// ---------- LISTADO EN VIVO ----------
export function listenTodaySales(setter: (rows: any[]) => void) {
  const q = query(
    collection(db, "sales"),
    where("dateKey", "==", todayKey()),
    orderBy("ts", "desc")
  );
  return onSnapshot(q, (snap) => {
    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    setter(rows as any[]);
  });
}

// ---------- ANULAR VENTA (VERSIÓN OFFLINE-READY) ----------
export async function voidSaleTx(id: string, voided: boolean, reason?: string) {
  const key = todayKey();
  const saleRef = doc(db, "sales", id);
  const aggRef = doc(db, "dayAgg", key);

  const s = await getDoc(saleRef).catch(() => null);
  if (!s || !s.exists()) throw new Error("Venta no encontrada.");
  const sale: any = s.data();

  if (!!sale.voided === voided) return;

  const sign = voided ? -1 : 1;
  const upd: any = { lastUpdated: serverTimestamp() };

  // Armamos la estructura anidada para anular
  if (sale.destination.mode === "COMEDOR") {
    upd.comedor = { [sale.itemType]: increment(sign) };
    if (sale.destination.table) {
      const oldK = tableKey(sale.destination.table)!;
      upd.comedor.byTable = { [oldK]: increment(sign) };
    }
  } else {
    upd.vianda = { [sale.itemType]: increment(sign) };
  }

  // NUEVO: Ajuste Financiero
  upd.financial = {
    paid: increment(sale.isSubsidized ? 0 : sign),
    subsidized: increment(sale.isSubsidized ? sign : 0)
  };

  setDoc(aggRef, upd, { merge: true });
  setDoc(saleRef, { voided, voidReason: reason ?? null, updatedAt: serverTimestamp() }, { merge: true });

  // Si anulamos una venta subvencionada, restamos el contador del Gabinete
  if (sale.isSubsidized) {
    const subRef = doc(db, "subsidized_members", sale.member.id);
    setDoc(subRef, { totalWithdrawals: increment(sign) }, { merge: true });
  }
}

// ---------- EDITAR VENTA (VERSIÓN OFFLINE-READY) ----------
export async function updateSaleTx(params: { saleId: string; newItemType: ItemType; newDest: Destination; }) {
  const key = todayKey();
  const saleRef = doc(db, "sales", params.saleId);
  const aggRef = doc(db, "dayAgg", key);

  const s = await getDoc(saleRef).catch(() => null);
  if (!s || !s.exists()) throw new Error("Venta no encontrada");
  const sale: any = s.data();
  if (sale.voided) throw new Error("No se puede editar una venta anulada");

  if (params.newDest.mode === "COMEDOR") {
    if (!params.newDest.table) throw new Error("Mesa obligatoria en COMEDOR");
    if (!mesaOk(params.newItemType, params.newDest.table)) throw new Error("Mesa inválida.");
  }

  // Calculamos la diferencia neta para no pisar datos
  const diffComedor: any = {};
  const diffVianda: any = {};
  const diffTables: any = {};

  // Restar lo viejo
  if (sale.destination.mode === "COMEDOR") {
    diffComedor[sale.itemType] = -1;
    if (sale.destination.table) diffTables[tableKey(sale.destination.table)!] = -1;
  } else {
    diffVianda[sale.itemType] = -1;
  }

  // Sumar lo nuevo
  if (params.newDest.mode === "COMEDOR") {
    diffComedor[params.newItemType] = (diffComedor[params.newItemType] || 0) + 1;
    if (params.newDest.table) diffTables[tableKey(params.newDest.table)!] = (diffTables[tableKey(params.newDest.table)!] || 0) + 1;
  } else {
    diffVianda[params.newItemType] = (diffVianda[params.newItemType] || 0) + 1;
  }

  // Construir el objeto anidado limpio
  const upd: any = { lastUpdated: serverTimestamp() };

  Object.keys(diffComedor).forEach(k => {
    if (diffComedor[k] !== 0) {
      if (!upd.comedor) upd.comedor = {};
      upd.comedor[k] = increment(diffComedor[k]);
    }
  });

  Object.keys(diffVianda).forEach(k => {
    if (diffVianda[k] !== 0) {
      if (!upd.vianda) upd.vianda = {};
      upd.vianda[k] = increment(diffVianda[k]);
    }
  });

  Object.keys(diffTables).forEach(k => {
    if (diffTables[k] !== 0) {
      if (!upd.comedor) upd.comedor = {};
      if (!upd.comedor.byTable) upd.comedor.byTable = {};
      upd.comedor.byTable[k] = increment(diffTables[k]);
    }
  });

  setDoc(aggRef, upd, { merge: true });
  setDoc(saleRef, { itemType: params.newItemType, destination: params.newDest, updatedAt: serverTimestamp() }, { merge: true });
}

// ---------- Reconstruir agregado del día desde sales ----------
export async function rebuildTodayAggFromSales() {
  const key = todayKey();
  const q = query(collection(db, "sales"), where("dateKey", "==", key));
  const snap = await getDocs(q);

  const agg = {
    comedor: {
      MENU: 0,
      VEGGIE: 0,
      CELIACO: 0,
      byTable: {} as Record<string, number>,
    },
    vianda: {
      MENU: 0,
      VEGGIE: 0,
      CELIACO: 0,
    },
    financial: { paid: 0, subsidized: 0 } // NUEVO
  };

  snap.forEach((d) => {
    const r: any = d.data();
    if (r.voided) return;

    const type = r.itemType as ItemType; 
    const mode = r.destination?.mode as "COMEDOR" | "VIANDA" | undefined;

    if (!type || !mode) return;

    if (mode === "COMEDOR") {
      agg.comedor[type] = (agg.comedor[type] ?? 0) + 1;

      const key = tableKey(r.destination?.table);
      if (key) {
        agg.comedor.byTable[key] = (agg.comedor.byTable[key] ?? 0) + 1;
      }
    } else if (mode === "VIANDA") {
      agg.vianda[type] = (agg.vianda[type] ?? 0) + 1;
    }

    // NUEVO: Reconstruir finanzas
    if (r.isSubsidized) {
      agg.financial.subsidized += 1;
    } else {
      agg.financial.paid += 1;
    }
  });

  // Usamos merge: true para no borrar los datos de pagos (Efectivo/MP) guardados
  await setDoc(doc(db, "dayAgg", key), agg, { merge: true });
}

// ---------- Permite filtrar por fecha ----------
export function listenSalesByDate(dateKey: string, setter: (rows:any[])=>void) {
  const q = query(
    collection(db, "sales"),
    where("dateKey","==", dateKey),
    orderBy("ts","desc")
  );
  return onSnapshot(q, snap => {
    const rows = snap.docs.map(d => ({ id:d.id, ...d.data() }));
    setter(rows as any[]);
  });
}

// --- Carga manual de VIANDAS por Admin ---
export type ViandaConcept =
  | "PERSONAL"
  | "DESAYUNO"
  | "CENTRO_JUBILADOS"
  | "EVENTOS"
  | "VIANDA_CONGELADA";

type AddManualViandasParams = {
  qty: number;
  concept: ViandaConcept;
  itemType: ItemType;     
  note?: string;          
  seller: { uid: string; email?: string; name?: string };
};

export async function addManualViandas(params: AddManualViandasParams) {
  const { qty, concept, itemType, note, seller } = params;
  if (!Number.isFinite(qty) || qty <= 0) throw new Error("Cantidad inválida");

  const key = todayKey();
  const aggRef = doc(db, "dayAgg", key);
  const logRef = doc(collection(db, "adminAdds"));

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(aggRef);
    if (!snap.exists()) {
      tx.set(
        aggRef,
        {
          comedor: { MENU: 0, VEGGIE: 0, CELIACO: 0, byTable: {} },
          vianda: { MENU: 0, VEGGIE: 0, CELIACO: 0 },
          extra: { vianda: { total: 0, breakdown: {} } },
          lastUpdated: serverTimestamp(),
        },
        { merge: true }
      );
    }

    // actualizar totales
    tx.update(aggRef, {
      [`vianda.${itemType}`]: increment(qty),
      "extra.vianda.total": increment(qty),
      [`extra.vianda.breakdown.${concept}`]: increment(qty),
      lastUpdated: serverTimestamp(),
    });

    // log en adminAdds
    tx.set(logRef, {
      dateKey: key,
      qty,
      concept,
      itemType,
      note: note ?? "",
      type: "VIANDA_MANUAL",
      ts: serverTimestamp(),
      seller: {
        uid: seller.uid,
        email: seller.email ?? "",
        name: seller.name ?? "",
      },
    });

    // reflejo en sales (para Supervisor / export)
    for (let i = 0; i < qty; i++) {
      const saleRef = doc(collection(db, "sales"));
      tx.set(saleRef, {
        dateKey: key,
        ts: serverTimestamp(),
        seller: {
          uid: seller.uid,
          email: seller.email ?? "",
          name: seller.name ?? "",
        },
        member: { id: "" },
        itemType,
        destination: { mode: "VIANDA", table: null },
        allowDouble: true,
        voided: false,
        voidReason: null,
        voidedBy: null,
        manual: true,
        manualConcept: concept,
        manualNote: note ?? "",
      });
    }
  });
}