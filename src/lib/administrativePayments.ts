import {
  collection,
  doc,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  where,
} from "firebase/firestore";
import type { DocumentData, Timestamp } from "firebase/firestore";
import { db } from "../firebase";
import type { CenterId } from "./centers";
import type { ResidencyStatus } from "./members";

export type AdministrativeConcept =
  | "BONO_CONTRIBUCION"
  | "LOCKER"
  | "INVITADO"
  | "PILETA"
  | "INSCRIPCION_ACTIVIDADES"
  | "ACTIVIDAD_1_SEMANAL"
  | "ACTIVIDAD_2_SEMANAL";

export type AdministrativePaymentMethod = "EFECTIVO" | "MP";
export type PoolDayGroup = "LUN_MAR_JUE_SAB" | "LUN_MIE_VIE_DOM";
export type PoolSeasonType = "MES" | "TEMPORADA_COMPLETA";
export type PoolMonth = "DICIEMBRE" | "ENERO" | "FEBRERO" | "MARZO";

export type AdministrativePaymentItem = {
  concept: AdministrativeConcept;
  amount: number;
  detail: string;
  periodStart: string | null;
  periodEnd: string | null;
  lockerNumber: string | null;
  guest: {
    dni: string;
    name: string;
    visitDate: string;
  } | null;
  pool: {
    season: string;
    dayGroup: PoolDayGroup;
    seasonType: PoolSeasonType;
    month: PoolMonth | null;
  } | null;
};

export type AdministrativePayment = {
  id: string;
  dateKey: string;
  createdAt?: Timestamp | Date | null;
  member: {
    dni: string;
    firstName: string;
    lastName: string;
  };
  pricingResidency: ResidencyStatus;
  centerId: CenterId;
  closureId: string;
  items: AdministrativePaymentItem[];
  conceptKeys: AdministrativeConcept[];
  totalAmount: number;
  paymentMethod: AdministrativePaymentMethod;
  receiptNumber: string;
  notes: string;
  status: "ACTIVE" | "VOID";
  source: "APP" | "EXCEL";
  operator: { uid: string; email: string; name: string };
  voidedAt?: Timestamp | Date | null;
  voidedBy?: { uid: string; email: string; name: string };
  voidReason?: string;
};

export type NewAdministrativePayment = Omit<
  AdministrativePayment,
  "id" | "dateKey" | "createdAt" | "closureId" | "conceptKeys" | "status" | "source" | "voidedAt" | "voidedBy" | "voidReason"
>;

export function administrativeTodayKey(date = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function administrativeConceptLabel(concept: AdministrativeConcept) {
  if (concept === "BONO_CONTRIBUCION") return "Bono contribución";
  if (concept === "LOCKER") return "Locker";
  if (concept === "INVITADO") return "Invitado";
  if (concept === "PILETA") return "Pileta";
  if (concept === "INSCRIPCION_ACTIVIDADES") return "Inscripción de actividades";
  if (concept === "ACTIVIDAD_1_SEMANAL") return "Actividad 1 vez por semana";
  return "Actividad 2 veces por semana";
}

export function poolDayGroupLabel(group: PoolDayGroup) {
  return group === "LUN_MAR_JUE_SAB"
    ? "Lunes, martes, jueves y sábado"
    : "Lunes, miércoles, viernes y domingo";
}

export function administrativeMonthLabel(value: string) {
  const monthKey = value.slice(0, 7);
  const match = monthKey.match(/^(\d{4})-(\d{2})$/);
  if (!match) return value;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  const month = new Intl.DateTimeFormat("es-AR", { month: "long", timeZone: "UTC" }).format(date);
  return `${month.charAt(0).toLocaleUpperCase("es-AR")}${month.slice(1)}/${match[1].slice(2)}`;
}

function administrativeDateLabel(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
}

export function administrativeItemPeriod(item: AdministrativePaymentItem) {
  if (item.concept === "PILETA" && item.pool) {
    const selectedMonth = item.pool.month ?? "Mes sin especificar";
    const coverage = item.pool.seasonType === "TEMPORADA_COMPLETA"
      ? "Temporada completa (diciembre a marzo)"
      : selectedMonth.charAt(0) + selectedMonth.slice(1).toLocaleLowerCase("es-AR");
    return `${item.pool.season} · ${coverage} · ${poolDayGroupLabel(item.pool.dayGroup)}`;
  }
  if (item.concept === "LOCKER" && item.lockerNumber) {
    const dates = item.periodStart && item.periodEnd
      ? ` · ${administrativeMonthLabel(item.periodStart)} a ${administrativeMonthLabel(item.periodEnd)}`
      : "";
    return `Locker ${item.lockerNumber}${dates}`;
  }
  if (item.concept === "INVITADO" && item.guest) {
    const dni = item.guest.dni ? ` · DNI ${item.guest.dni}` : "";
    return `${item.guest.name}${dni} · ${administrativeDateLabel(item.guest.visitDate)}`;
  }
  if (item.periodStart && item.periodEnd) {
    const period = item.periodStart.slice(0, 7) === item.periodEnd.slice(0, 7)
      ? administrativeMonthLabel(item.periodStart)
      : `${administrativeMonthLabel(item.periodStart)} a ${administrativeMonthLabel(item.periodEnd)}`;
    return `${item.detail} · ${period}`;
  }
  return item.detail;
}

export function administrativePaymentConcepts(payment: AdministrativePayment) {
  return payment.items.map((item) => administrativeConceptLabel(item.concept)).join(" + ");
}

export async function createAdministrativePayment(input: NewAdministrativePayment) {
  const paymentRef = doc(collection(db, "administrative_payments"));
  const dateKey = administrativeTodayKey();
  await setDoc(paymentRef, {
    ...input,
    conceptKeys: input.items.map((item) => item.concept),
    dateKey,
    closureId: `${dateKey}_${input.centerId}`,
    createdAt: serverTimestamp(),
    status: "ACTIVE",
    source: "APP",
  });
  return paymentRef.id;
}

function mapPayment(id: string, data: DocumentData): AdministrativePayment {
  return { id, ...data } as AdministrativePayment;
}

function timestampMillis(value: AdministrativePayment["createdAt"]) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  return value.toMillis();
}

function newestFirst(a: AdministrativePayment, b: AdministrativePayment) {
  return timestampMillis(b.createdAt) - timestampMillis(a.createdAt);
}

export function listenAdministrativePayments(params: {
  centerId: CenterId;
  dateKey: string;
  setter: (payments: AdministrativePayment[]) => void;
}) {
  const paymentsQuery = query(
    collection(db, "administrative_payments"),
    where("centerId", "==", params.centerId),
    where("dateKey", "==", params.dateKey),
  );
  return onSnapshot(paymentsQuery, (snapshot) => {
    params.setter(snapshot.docs.map((item) => mapPayment(item.id, item.data())).sort(newestFirst));
  });
}

export function listenMemberAdministrativePayments(
  dni: string,
  centerId: CenterId,
  setter: (payments: AdministrativePayment[]) => void,
) {
  const paymentsQuery = query(
    collection(db, "administrative_payments"),
    where("member.dni", "==", dni),
    where("centerId", "==", centerId),
  );
  return onSnapshot(paymentsQuery, (snapshot) => {
    setter(snapshot.docs.map((item) => mapPayment(item.id, item.data())).sort(newestFirst));
  });
}

export async function voidAdministrativePayment(params: {
  paymentId: string;
  reason: string;
  actor: { uid: string; email: string; name: string };
}) {
  const paymentRef = doc(db, "administrative_payments", params.paymentId);
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(paymentRef);
    if (!snapshot.exists()) throw new Error("El cobro ya no existe.");
    if (snapshot.data()?.status === "VOID") throw new Error("El cobro ya estaba anulado.");
    transaction.update(paymentRef, {
      status: "VOID",
      voidedAt: serverTimestamp(),
      voidedBy: params.actor,
      voidReason: params.reason.trim(),
    });
  });
}
