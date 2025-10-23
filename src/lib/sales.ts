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

/** Clave de día (TZ AR) */
export const todayKey = () => dayjs().tz(TZ).format("YYYY-MM-DD");
export const keyFromDate = (d: Date) => dayjs(d).tz(TZ).format("YYYY-MM-DD");

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
  const ref = doc(db, "settings_day", key); // colección plana por fecha
  const snap = await getDoc(ref);
  if (snap.exists()) return;

  const tables: Record<string, number> = {};
  for (let i = 1; i <= 23; i++) tables[`MESA ${String(i).padStart(2, "0")}`] = 9;

  await setDoc(ref, {
    cutoffs: { comedor: "20:00", vianda: "20:00" },
    tables,
    createdAt: serverTimestamp(),
  });
}

function afterCutoff(mode: "COMEDOR" | "VIANDA", settings: any) {
  const now = dayjs().tz(TZ);
  const hhmm = mode === "COMEDOR" ? settings.cutoffs.comedor : settings.cutoffs.vianda;
  const [hh, mm] = hhmm.split(":").map(Number);
  const limit = now.hour(hh).minute(mm).second(0).millisecond(0);
  return now.isAfter(limit);
}

// ---------- ALTA DE VENTA ----------
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

  await runTransaction(db, async (tx) => {
    // 1) Settings del día
    const st = await tx.get(settingsRef);
    if (!st.exists()) throw new Error("Faltan settings del día");
    const settings = st.data();

    // 2) Cortes horarios
    if (afterCutoff(params.dest.mode, settings)) {
      throw new Error(params.dest.mode === "COMEDOR" ? "Cierre de comedor (11:00)." : "Cierre de viandas (13:00).");
    }

    // 3) Validaciones de mesa/tipo
    if (params.dest.mode === "COMEDOR") {
      if (!params.dest.table) throw new Error("Mesa obligatoria en COMEDOR");
      if (!mesaOk(params.itemType, params.dest.table)) {
        throw new Error("La mesa no corresponde al tipo (01–21 MENU, 22–23 VEGGIE).");
      }
    }

    // 4) Duplicado por socio
    const idx = await tx.get(indexRef);
    const prev = idx.exists() ? (idx.data().count as number) : 0;
    if (prev >= 1 && !params.allowDouble) {
      throw new Error("Socio ya tiene una compra hoy. Habilitar doble compra para continuar.");
    }

    // 5) Asegurar doc base de agregados y LEERLO para usar valores actuales
    const aggSnap = await tx.get(aggRef);
    const baseAgg = aggSnap.exists()
      ? (aggSnap.data() as any)
      : { comedor: { MENU: 0, VEGGIE: 0, byTable: {} as Record<string, number> }, vianda: { MENU: 0, VEGGIE: 0 } };

    // 👇 NUEVO: si no existe, crearlo antes de cualquier tx.update
    if (!aggSnap.exists()) {
      tx.set(aggRef, {
        comedor: { MENU: 0, VEGGIE: 0, byTable: {} },
        vianda:  { MENU: 0, VEGGIE: 0 },
        lastUpdated: serverTimestamp(),
      }, { merge: true });
    }

    // 6) Capacidad por mesa con clave normalizada
    if (params.dest.mode === "COMEDOR") {
      const mesaK = tableKey(params.dest.table)!;
      const ocupados =
        (baseAgg?.comedor?.byTable?.[mesaK] ??
          baseAgg?.comedor?.byTable?.[params.dest.table!] ??
          0) as number;
      if (ocupados >= 9) throw new Error(`Capacidad completa en ${tableLabelFromKey(mesaK)} (9).`);
    }

    // 7) Alta de venta
    const saleRef = doc(db, "sales", crypto.randomUUID());
    tx.set(saleRef, {
      dateKey: key,
      ts: serverTimestamp(),
      seller: params.seller,
      member: { id: params.memberId },
      itemType: params.itemType,
      destination: params.dest,
      allowDouble: !!params.allowDouble,
      voided: false,
      voidReason: null,
      voidedBy: null,
    });

    // 8) Índice socio/día
    tx.set(indexRef, { count: increment(1), lastTs: serverTimestamp() }, { merge: true });

    // 9) Calcular NUEVOS valores y escribirlos con update (números explícitos)
    //    => evitamos cualquier rareza con increment/merge.
    if (params.dest.mode === "COMEDOR") {
      const totalTipoActual = (baseAgg?.comedor?.[params.itemType] ?? 0) as number;
      const mesaK = tableKey(params.dest.table)!;
      const mesaActual = (baseAgg?.comedor?.byTable?.[mesaK] ??
        baseAgg?.comedor?.byTable?.[params.dest.table!] ??
        0) as number;

      const updates: any = {};
      updates[`comedor.${params.itemType}`] = totalTipoActual + 1;
      updates[`comedor.byTable.${mesaK}`] = mesaActual + 1;
      tx.update(aggRef, updates);
    } else {
      const totalTipoActual = (baseAgg?.vianda?.[params.itemType] ?? 0) as number;
      const updates: any = {};
      updates[`vianda.${params.itemType}`] = totalTipoActual + 1;
      tx.update(aggRef, updates);
    }
  });
}


// ---------- LISTADO EN VIVO (requiere índice: dateKey ASC + ts DESC) ----------
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

// ---------- ANULAR VENTA (ajusta agregados) ----------
export async function voidSaleTx(id: string, voided: boolean, reason?: string) {
  const key = todayKey();
  const saleRef = doc(db, "sales", id);
  const aggRef = doc(db, "dayAgg", key);

  await runTransaction(db, async (tx) => {
    const s = await tx.get(saleRef);
    if (!s.exists()) throw new Error("Venta no encontrada");
    const sale: any = s.data();
    if (!!sale.voided === voided) return;

    const sign = voided ? -1 : 1;

    const fld = sale.destination.mode === "COMEDOR" ? "comedor" : "vianda";
    const upd: any = {};
    upd[`${fld}.${sale.itemType}`] = increment(sign);
    if (sale.destination.mode === "COMEDOR" && sale.destination.table) {
      const oldK = tableKey(sale.destination.table)!;
      upd[`comedor.byTable.${oldK}`] = increment(sign);
    }
    tx.update(aggRef, upd);

    tx.update(saleRef, { voided, voidReason: reason ?? null });
  });
}

// ---------- EDITAR VENTA (cambia tipo/destino y recalcula agregados) ----------
export async function updateSaleTx(params: {
  saleId: string;
  newItemType: ItemType;
  newDest: Destination;
}) {
  const key = todayKey();
  const saleRef = doc(db, "sales", params.saleId);
  const aggRef = doc(db, "dayAgg", key);
  const settingsRef = doc(db, "settings_day", key);

  await runTransaction(db, async (tx) => {
    // 1) Venta actual
    const s = await tx.get(saleRef);
    if (!s.exists()) throw new Error("Venta no encontrada");
    const sale: any = s.data();
    if (sale.voided) throw new Error("No se puede editar una venta anulada");

    // 2) Settings del día
    const st = await tx.get(settingsRef);
    if (!st.exists()) throw new Error("Faltan settings del día");

    // 3) Validar nuevo destino/mesa
    if (params.newDest.mode === "COMEDOR") {
      if (!params.newDest.table) throw new Error("Mesa obligatoria en COMEDOR");
      if (!mesaOk(params.newItemType, params.newDest.table)) {
        throw new Error("Mesa no corresponde al tipo (01–21 MENU, 22–23 VEGGIE).");
      }
    }

    // 4) Restar agregados actuales
    const oldFld = sale.destination.mode === "COMEDOR" ? "comedor" : "vianda";
    const down: any = {};
    down[`${oldFld}.${sale.itemType}`] = increment(-1);
    if (sale.destination.mode === "COMEDOR" && sale.destination.table) {
      const oldK = tableKey(sale.destination.table)!;
      down[`comedor.byTable.${oldK}`] = increment(-1);
    }
    tx.update(aggRef, down);

    // 5) Sumar agregados nuevos
    const newFld = params.newDest.mode === "COMEDOR" ? "comedor" : "vianda";
    const up: any = {};
    up[`${newFld}.${params.newItemType}`] = increment(1);
    if (params.newDest.mode === "COMEDOR" && params.newDest.table) {
      const newK = tableKey(params.newDest.table)!;
      up[`comedor.byTable.${newK}`] = increment(1);
    }
    tx.update(aggRef, up);

    // 6) Actualizar venta
    tx.update(saleRef, {
      itemType: params.newItemType,
      destination: params.newDest,
      updatedAt: serverTimestamp(),
    });
  });
}

// ---------- (OPCIONAL) Reconstruir agregado del día desde sales ----------
export async function rebuildTodayAggFromSales() {
  const key = todayKey();
  const q = query(collection(db, "sales"), where("dateKey", "==", key));
  const snap = await getDocs(q);

  const agg = {
    comedor: { MENU: 0, VEGGIE: 0, byTable: {} as Record<string, number> },
    vianda: { MENU: 0, VEGGIE: 0 },
  };

  snap.forEach((d) => {
    const r: any = d.data();
    if (r.voided) return;

    const type = r.itemType as "MENU" | "VEGGIE";
    const mode = r.destination?.mode as "COMEDOR" | "VIANDA" | undefined;

    if (mode === "COMEDOR") {
      agg.comedor[type] += 1;
      const key = tableKey(r.destination?.table);
      if (key) agg.comedor.byTable[key] = (agg.comedor.byTable[key] ?? 0) + 1;
    } else if (mode === "VIANDA") {
      agg.vianda[type] += 1;
    }
  });

  await setDoc(doc(db, "dayAgg", key), agg, { merge: false });
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


export type ViandaConcept = "PERSONAL" | "DESAYUNO" | "CENTRO_JUBILADOS";

type AddManualViandasParams = {
  qty: number;
  concept: ViandaConcept;
  seller: { uid: string; email?: string; name?: string };
};

export async function addManualViandas(params: AddManualViandasParams) {
  const { qty, concept, seller } = params;
  if (!Number.isFinite(qty) || qty <= 0) throw new Error("Cantidad inválida");

  const key = todayKey();
  const aggRef = doc(db, "dayAgg", key);
  const logRef = doc(collection(db, "adminAdds")); // log auditable

  await runTransaction(db, async (tx) => {
    // asegurar doc agregado
    const snap = await tx.get(aggRef);
    if (!snap.exists()) {
      tx.set(
        aggRef,
        {
          comedor: { MENU: 0, VEGGIE: 0, byTable: {} },
          vianda: { MENU: 0, VEGGIE: 0 },
          extra: { vianda: { total: 0, breakdown: {} } },
          lastUpdated: serverTimestamp(),
        },
        { merge: true }
      );
    }

    // actualizar totales (manual = vianda MENU por ahora)
    tx.update(aggRef, {
      "vianda.MENU": increment(qty),
      "extra.vianda.total": increment(qty),
      [`extra.vianda.breakdown.${concept}`]: increment(qty),
      lastUpdated: serverTimestamp(),
    });

    // log de auditoría
    tx.set(logRef, {
      dateKey: key,
      qty,
      concept,
      type: "VIANDA_MANUAL",
      ts: serverTimestamp(),
      seller,
    });

    // NUEVO: reflejar en `sales` para que Supervisor lo vea
    // un doc por vianda (Supervisor agrega por cantidad de documentos)
    for (let i = 0; i < qty; i++) {
      const saleRef = doc(db, "sales", crypto.randomUUID());
      tx.set(saleRef, {
        dateKey: key,
        ts: serverTimestamp(),
        seller: { uid: seller.uid, email: seller.email ?? "", name: seller.name ?? "" },
        member: { id: "" }, // sin socio
        itemType: "MENU",   // si luego querés Veggie, mapeamos según 'concept'
        destination: { mode: "VIANDA", table: null },
        allowDouble: true,
        voided: false,
        voidReason: null,
        voidedBy: null,
      });
    }
  });
}

