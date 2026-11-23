import { useEffect, useMemo, useState } from "react";
import {
  collection,
  doc,
  endAt,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  startAt,
} from "firebase/firestore";
import { db } from "../firebase";
import { resolveMemberDni } from "../lib/memberId";
import {
  administrativeContributionTypeLabel,
  administrativeItemPeriod,
  administrativeTodayKey,
  createAdministrativePayment,
  listenAdministrativePayments,
  listenMemberAdministrativePayments,
  voidAdministrativePayment,
} from "../lib/administrativePayments";
import type {
  AdministrativeConcept,
  AdministrativePayment,
  AdministrativePaymentItem,
  AdministrativePaymentMethod,
  PoolDayGroup,
  PoolMonth,
  PoolSeasonType,
} from "../lib/administrativePayments";
import { useAuth } from "../state/AuthContext";
import { Card } from "../ui/Card";
import {
  ADMINISTRATIVE_PRICE_VALIDITY,
  administrativePriceQuote,
  administrativeRangePrice,
  CENTER_CONCEPTS,
  CENTER_LABELS,
  centerConceptLabel,
} from "../lib/centers";
import type { CenterId } from "../lib/centers";
import { residencyLabel } from "../lib/members";
import type { ResidencyStatus } from "../lib/members";
import CobrosRendicion from "./CobrosRendicion";
import { listenAdministrativeClosure } from "../lib/administrativeClosures";
import type { AdministrativeClosure } from "../lib/administrativeClosures";

type MemberOption = {
  dni: string;
  firstName: string;
  lastName: string;
  residencyStatus: ResidencyStatus;
};

type ContributionType = "CUOTA" | "INSCRIPCION" | "REINCORPORACION";

type FormState = {
  enabled: Record<AdministrativeConcept, boolean>;
  contributionTypes: Record<ContributionType, boolean>;
  contributionAmounts: Record<ContributionType, string>;
  contributionStart: string;
  contributionEnd: string;
  lockerAmount: string;
  lockerNumber: string;
  lockerStart: string;
  lockerEnd: string;
  guestAmount: string;
  guestName: string;
  guestDni: string;
  guestVisitDate: string;
  poolAmount: string;
  poolSeason: string;
  poolDayGroup: PoolDayGroup;
  poolSeasonType: PoolSeasonType;
  poolMonth: PoolMonth;
  activityRegistrationAmount: string;
  activityOneAmount: string;
  activityTwoAmount: string;
  activityPeriod: string;
  paymentMethod: AdministrativePaymentMethod;
  receiptNumber: string;
  notes: string;
};

const PURE_DNI_RE = /^\d{7,8}$/;
const POOL_MONTHS: PoolMonth[] = ["DICIEMBRE", "ENERO", "FEBRERO", "MARZO"];
const CONTRIBUTION_TYPES: ContributionType[] = ["CUOTA", "INSCRIPCION", "REINCORPORACION"];

function contributionTypeLabel(type: ContributionType, centerId: CenterId) {
  if (type === "CUOTA") return centerId === "ANEXO_19" ? "Cuota social" : "Cuota mensual";
  if (type === "INSCRIPCION") return "Inscripción";
  return "Reincorporación";
}

function currentPoolSeason() {
  const now = new Date();
  const year = now.getFullYear();
  return now.getMonth() <= 2 ? `${year - 1}-${year}` : `${year}-${year + 1}`;
}

function blankForm(): FormState {
  const currentMonth = administrativeTodayKey().slice(0, 7);
  return {
    enabled: {
      BONO_CONTRIBUCION: false,
      LOCKER: false,
      INVITADO: false,
      PILETA: false,
      INSCRIPCION_ACTIVIDADES: false,
      ACTIVIDAD_1_SEMANAL: false,
      ACTIVIDAD_2_SEMANAL: false,
    },
    contributionTypes: { CUOTA: true, INSCRIPCION: false, REINCORPORACION: false },
    contributionAmounts: { CUOTA: "", INSCRIPCION: "", REINCORPORACION: "" },
    contributionStart: currentMonth,
    contributionEnd: currentMonth,
    lockerAmount: "",
    lockerNumber: "",
    lockerStart: currentMonth,
    lockerEnd: addMonths(currentMonth, 3),
    guestAmount: "",
    guestName: "",
    guestDni: "",
    guestVisitDate: administrativeTodayKey(),
    poolAmount: "",
    poolSeason: currentPoolSeason(),
    poolDayGroup: "LUN_MAR_JUE_SAB",
    poolSeasonType: "TEMPORADA_COMPLETA",
    poolMonth: "DICIEMBRE",
    activityRegistrationAmount: "",
    activityOneAmount: "",
    activityTwoAmount: "",
    activityPeriod: currentMonth,
    paymentMethod: "EFECTIVO",
    receiptNumber: "",
    notes: "",
  };
}

function addMonths(monthKey: string, amount: number) {
  const match = monthKey.match(/^(\d{4})-(\d{2})$/);
  if (!match) return monthKey;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1 + amount, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function memberName(member: MemberOption) {
  return [member.lastName, member.firstName].filter(Boolean).join(", ") || "Sin nombre cargado";
}

function money(value: number) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0,
  }).format(value);
}

function dateTime(value: AdministrativePayment["createdAt"]) {
  const date = value instanceof Date ? value : value?.toDate() ?? null;
  return date
    ? new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "short" }).format(date)
    : "Pendiente";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function numericAmount(value: string) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function parseSeason(season: string) {
  const match = season.match(/^(\d{4})-(\d{4})$/);
  if (!match) return null;
  const firstYear = Number(match[1]);
  const secondYear = Number(match[2]);
  if (secondYear !== firstYear + 1) return null;
  return { firstYear, secondYear };
}

function lastDayOfMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function poolPeriod(season: string, seasonType: PoolSeasonType, month: PoolMonth) {
  const years = parseSeason(season);
  if (!years) return null;
  if (seasonType === "TEMPORADA_COMPLETA") {
    return { start: `${years.firstYear}-12-01`, end: `${years.secondYear}-03-31` };
  }
  const monthData: Record<PoolMonth, { year: number; month: number }> = {
    DICIEMBRE: { year: years.firstYear, month: 12 },
    ENERO: { year: years.secondYear, month: 1 },
    FEBRERO: { year: years.secondYear, month: 2 },
    MARZO: { year: years.secondYear, month: 3 },
  };
  const selected = monthData[month];
  const monthText = String(selected.month).padStart(2, "0");
  const finalDay = String(lastDayOfMonth(selected.year, selected.month)).padStart(2, "0");
  return {
    start: `${selected.year}-${monthText}-01`,
    end: `${selected.year}-${monthText}-${finalDay}`,
  };
}

function monthlyPeriod(monthKey: string) {
  const match = monthKey.match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return {
    start: `${match[1]}-${match[2]}-01`,
    end: `${match[1]}-${match[2]}-${String(lastDayOfMonth(year, month)).padStart(2, "0")}`,
  };
}

function quoteAmount(
  quote: ReturnType<typeof administrativePriceQuote>,
  currentValue: string,
) {
  if (quote.status === "PRICED" && quote.amount != null) return String(quote.amount);
  if (quote.status === "UNAVAILABLE") return "";
  return currentValue;
}

function poolPriceMonth(form: FormState) {
  const period = poolPeriod(form.poolSeason, form.poolSeasonType, form.poolMonth);
  if (!period) return administrativeTodayKey().slice(0, 7);
  return form.poolSeasonType === "TEMPORADA_COMPLETA"
    ? `${period.end.slice(0, 4)}-01`
    : period.start.slice(0, 7);
}

function applyCatalogPrices(
  form: FormState,
  centerId: CenterId,
  paymentMethod: AdministrativePaymentMethod,
  residencyStatus: ResidencyStatus,
) {
  const quote = (concept: AdministrativeConcept, detail: string, monthKey: string) => administrativePriceQuote({
    centerId,
    concept,
    detail,
    paymentMethod,
    monthKey,
    residencyStatus,
  });
  const currentMonth = administrativeTodayKey().slice(0, 7);
  const contributionQuota = administrativeRangePrice({
    centerId,
    concept: "BONO_CONTRIBUCION",
    detail: "CUOTA",
    paymentMethod,
    from: form.contributionStart,
    to: form.contributionEnd,
    residencyStatus,
  });
  const contributionRegistration = quote("BONO_CONTRIBUCION", "INSCRIPCION", currentMonth);
  const contributionReinstatement = quote("BONO_CONTRIBUCION", "REINCORPORACION", currentMonth);
  const locker = quote("LOCKER", "ALQUILER", form.lockerStart || currentMonth);
  const guest = quote("INVITADO", "INGRESO", form.guestVisitDate.slice(0, 7) || currentMonth);
  const registration = quote("INSCRIPCION_ACTIVIDADES", "INSCRIPCION", currentMonth);
  const activityOne = quote("ACTIVIDAD_1_SEMANAL", "ACTIVIDAD", form.activityPeriod || currentMonth);
  const activityTwo = quote("ACTIVIDAD_2_SEMANAL", "ACTIVIDAD", form.activityPeriod || currentMonth);
  const pool = quote("PILETA", form.poolSeasonType, poolPriceMonth(form));
  return {
    ...form,
    paymentMethod,
    contributionAmounts: {
      CUOTA: contributionQuota.status === "PRICED" && contributionQuota.amount != null
        ? String(contributionQuota.amount)
        : form.contributionAmounts.CUOTA,
      INSCRIPCION: quoteAmount(contributionRegistration, form.contributionAmounts.INSCRIPCION),
      REINCORPORACION: quoteAmount(contributionReinstatement, form.contributionAmounts.REINCORPORACION),
    },
    lockerAmount: quoteAmount(locker, form.lockerAmount),
    guestAmount: quoteAmount(guest, form.guestAmount),
    poolAmount: quoteAmount(pool, form.poolAmount),
    activityRegistrationAmount: quoteAmount(registration, form.activityRegistrationAmount),
    activityOneAmount: quoteAmount(activityOne, form.activityOneAmount),
    activityTwoAmount: quoteAmount(activityTwo, form.activityTwoAmount),
  };
}

function requiredAmount(value: string, label: string) {
  const amount = numericAmount(value);
  if (!amount) throw new Error(`Ingresá un importe mayor a cero para ${label}.`);
  return amount;
}

export default function Cobros() {
  const { user, role, allowedCenters } = useAuth();
  const canWrite = role === "root" || role === "administrador" || role === "administrativo" || role === "cobrador";
  const actor = useMemo(() => ({
    uid: user?.uid ?? "",
    email: user?.email ?? "",
    name: user?.displayName ?? "",
  }), [user]);

  const [search, setSearch] = useState("");
  const [centerId, setCenterId] = useState<CenterId>(allowedCenters[0] ?? "PUERTO_LIBRE");
  const [activeView, setActiveView] = useState<"COBRAR" | "RENDICION">("COBRAR");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [candidates, setCandidates] = useState<MemberOption[]>([]);
  const [selectedMember, setSelectedMember] = useState<MemberOption | null>(null);
  const [form, setForm] = useState<FormState>(blankForm);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [todayPayments, setTodayPayments] = useState<AdministrativePayment[]>([]);
  const [memberPayments, setMemberPayments] = useState<AdministrativePayment[]>([]);
  const [todayClosure, setTodayClosure] = useState<AdministrativeClosure | null>(null);

  const availableConcepts = CENTER_CONCEPTS[centerId];

  useEffect(() => {
    if (!allowedCenters.includes(centerId) && allowedCenters[0]) setCenterId(allowedCenters[0]);
  }, [allowedCenters, centerId]);

  useEffect(() => {
    setForm(blankForm());
    setSelectedMember(null);
    setMemberPayments([]);
    setMessage("");
  }, [centerId]);

  useEffect(() => listenAdministrativePayments({
    centerId,
    dateKey: administrativeTodayKey(),
    setter: setTodayPayments,
  }), [centerId]);

  useEffect(() => listenAdministrativeClosure(
    centerId,
    administrativeTodayKey(),
    setTodayClosure,
  ), [centerId]);

  useEffect(() => {
    if (!selectedMember) {
      setMemberPayments([]);
      return;
    }
    return listenMemberAdministrativePayments(selectedMember.dni, centerId, setMemberPayments);
  }, [selectedMember, centerId]);

  const pricingResidency = selectedMember?.residencyStatus ?? "SIN_VERIFICAR";
  const pricingTrigger = [
    ...Object.entries(form.enabled).map(([concept, enabled]) => `${concept}:${enabled}`),
    ...Object.entries(form.contributionTypes).map(([type, enabled]) => `${type}:${enabled}`),
    form.paymentMethod,
    form.contributionStart,
    form.contributionEnd,
    form.lockerStart,
    form.guestVisitDate,
    form.poolSeason,
    form.poolSeasonType,
    form.poolMonth,
    form.activityPeriod,
  ].join("|");

  useEffect(() => {
    void pricingTrigger;
    setForm((current) => {
      const priced = applyCatalogPrices(current, centerId, current.paymentMethod, pricingResidency);
      const unchanged = priced.contributionAmounts.CUOTA === current.contributionAmounts.CUOTA
        && priced.contributionAmounts.INSCRIPCION === current.contributionAmounts.INSCRIPCION
        && priced.contributionAmounts.REINCORPORACION === current.contributionAmounts.REINCORPORACION
        && priced.lockerAmount === current.lockerAmount
        && priced.guestAmount === current.guestAmount
        && priced.poolAmount === current.poolAmount
        && priced.activityRegistrationAmount === current.activityRegistrationAmount
        && priced.activityOneAmount === current.activityOneAmount
        && priced.activityTwoAmount === current.activityTwoAmount;
      return unchanged ? current : priced;
    });
  }, [centerId, pricingResidency, pricingTrigger]);

  const activeToday = useMemo(() => todayPayments.filter((payment) => payment.status !== "VOID"), [todayPayments]);
  const totals = useMemo(() => ({
    total: activeToday.reduce((sum, payment) => sum + Number(payment.totalAmount || 0), 0),
    cash: activeToday.filter((payment) => payment.paymentMethod === "EFECTIVO").reduce((sum, payment) => sum + Number(payment.totalAmount || 0), 0),
    mp: activeToday.filter((payment) => payment.paymentMethod === "MP").reduce((sum, payment) => sum + Number(payment.totalAmount || 0), 0),
  }), [activeToday]);
  const formTotal = useMemo(() => (
    (form.enabled.BONO_CONTRIBUCION
      ? CONTRIBUTION_TYPES.reduce((sum, type) => sum + (form.contributionTypes[type] ? numericAmount(form.contributionAmounts[type]) : 0), 0)
      : 0)
    + (form.enabled.LOCKER ? numericAmount(form.lockerAmount) : 0)
    + (form.enabled.INVITADO ? numericAmount(form.guestAmount) : 0)
    + (form.enabled.PILETA ? numericAmount(form.poolAmount) : 0)
    + (form.enabled.INSCRIPCION_ACTIVIDADES ? numericAmount(form.activityRegistrationAmount) : 0)
    + (form.enabled.ACTIVIDAD_1_SEMANAL ? numericAmount(form.activityOneAmount) : 0)
    + (form.enabled.ACTIVIDAD_2_SEMANAL ? numericAmount(form.activityTwoAmount) : 0)
  ), [form]);
  const guestUnavailable = administrativePriceQuote({
    centerId,
    concept: "INVITADO",
    detail: "INGRESO",
    paymentMethod: form.paymentMethod,
    monthKey: form.guestVisitDate.slice(0, 7),
    residencyStatus: pricingResidency,
  }).status === "UNAVAILABLE";

  function selectMember(member: MemberOption) {
    setSelectedMember(member);
    setSearch(member.dni);
    setCandidates([]);
    setSearchError("");
    setMessage("");
  }

  async function lookupMember() {
    const term = search.trim();
    if (!term) return;
    setSearching(true);
    setSearchError("");
    setCandidates([]);
    try {
      const compactDni = term.replace(/[.\s-]/g, "");
      if (PURE_DNI_RE.test(compactDni) || /\d/.test(term)) {
        const dni = await resolveMemberDni(term);
        if (!dni) throw new Error("No se pudo identificar el DNI del socio.");
        const snapshot = await getDoc(doc(db, "members", dni));
        if (!snapshot.exists()) throw new Error("El DNI no está registrado en Socios.");
        const data = snapshot.data();
        selectMember({
          dni,
          firstName: String(data.firstName ?? data.name ?? ""),
          lastName: String(data.lastName ?? ""),
          residencyStatus: data.residencyStatus === "SAN_ISIDRO" || data.residencyStatus === "FUERA_SAN_ISIDRO"
            ? data.residencyStatus
            : "SIN_VERIFICAR",
        });
        return;
      }

      const normalized = term.toLocaleUpperCase("es-AR");
      const fields = ["lastName", "firstName"] as const;
      const snapshots = await Promise.all(fields.map((field) => getDocs(query(
        collection(db, "members"),
        orderBy(field),
        startAt(normalized),
        endAt(`${normalized}\uf8ff`),
        limit(10),
      ))));
      const found = new Map<string, MemberOption>();
      snapshots.forEach((snapshot) => snapshot.docs.forEach((item) => {
        const data = item.data();
        found.set(item.id, {
          dni: item.id,
          firstName: String(data.firstName ?? data.name ?? ""),
          lastName: String(data.lastName ?? ""),
          residencyStatus: data.residencyStatus === "SAN_ISIDRO" || data.residencyStatus === "FUERA_SAN_ISIDRO"
            ? data.residencyStatus
            : "SIN_VERIFICAR",
        });
      }));
      const list = Array.from(found.values()).slice(0, 12);
      if (!list.length) throw new Error("No se encontraron socios con ese nombre o apellido.");
      setCandidates(list);
    } catch (error: unknown) {
      setSearchError(errorMessage(error));
    } finally {
      setSearching(false);
    }
  }

  function toggleConcept(concept: AdministrativeConcept) {
    setForm((current) => ({
      ...current,
      enabled: { ...current.enabled, [concept]: !current.enabled[concept] },
    }));
    setMessage("");
  }

  function toggleContributionType(type: ContributionType) {
    setForm((current) => ({
      ...current,
      contributionTypes: { ...current.contributionTypes, [type]: !current.contributionTypes[type] },
    }));
    setMessage("");
  }

  function buildItems() {
    const items: AdministrativePaymentItem[] = [];
    if (!availableConcepts.some((concept) => form.enabled[concept])) {
      throw new Error("Seleccioná al menos un concepto de cuota o servicio.");
    }

    if (form.enabled.BONO_CONTRIBUCION) {
      const availableContributionTypes = centerId === "PUERTO_LIBRE" ? CONTRIBUTION_TYPES : (["CUOTA"] as ContributionType[]);
      const selectedContributionTypes = availableContributionTypes.filter((type) => form.contributionTypes[type]);
      if (!selectedContributionTypes.length) {
        throw new Error("Seleccioná al menos un tipo dentro de Bono contribución.");
      }
      if (form.contributionTypes.CUOTA && (!form.contributionStart || !form.contributionEnd)) {
        throw new Error("Indicá desde y hasta cuándo cubre el bono contribución.");
      }
      const contributionStart = form.contributionTypes.CUOTA ? monthlyPeriod(form.contributionStart) : null;
      const contributionEnd = form.contributionTypes.CUOTA ? monthlyPeriod(form.contributionEnd) : null;
      if (form.contributionTypes.CUOTA && (!contributionStart || !contributionEnd || form.contributionStart > form.contributionEnd)) {
        throw new Error("El período del bono contribución debe tener meses válidos y Desde no puede ser posterior a Hasta.");
      }
      selectedContributionTypes.forEach((type) => {
        items.push({
          concept: "BONO_CONTRIBUCION",
          amount: requiredAmount(form.contributionAmounts[type], contributionTypeLabel(type, centerId).toLocaleLowerCase("es-AR")),
          detail: type,
          periodStart: type === "CUOTA" ? contributionStart?.start ?? null : null,
          periodEnd: type === "CUOTA" ? contributionEnd?.end ?? null : null,
          lockerNumber: null,
          guest: null,
          pool: null,
        });
      });
    }

    if (form.enabled.LOCKER) {
      if (!form.lockerNumber.trim() || !form.lockerStart || !form.lockerEnd) {
        throw new Error("Indicá el número de locker y su período de alquiler.");
      }
      const lockerStart = monthlyPeriod(form.lockerStart);
      const lockerEnd = monthlyPeriod(form.lockerEnd);
      if (!lockerStart || !lockerEnd || form.lockerStart > form.lockerEnd) {
        throw new Error("El período del locker debe tener meses válidos y Desde no puede ser posterior a Hasta.");
      }
      items.push({
        concept: "LOCKER",
        amount: requiredAmount(form.lockerAmount, "locker"),
        detail: "ALQUILER",
        periodStart: lockerStart.start,
        periodEnd: lockerEnd.end,
        lockerNumber: form.lockerNumber.trim(),
        guest: null,
        pool: null,
      });
    }

    if (form.enabled.INVITADO) {
      if (guestUnavailable) {
        throw new Error("El tarifario indica que Invitados no está disponible para socios con domicilio fuera del partido.");
      }
      const guestDni = form.guestDni.replace(/\D/g, "");
      if (!form.guestName.trim() || !form.guestVisitDate) {
        throw new Error("Indicá el nombre y la fecha de visita del invitado.");
      }
      if (guestDni && !PURE_DNI_RE.test(guestDni)) {
        throw new Error("El DNI del invitado debe tener 7 u 8 números.");
      }
      items.push({
        concept: "INVITADO",
        amount: requiredAmount(form.guestAmount, "invitado"),
        detail: "INGRESO",
        periodStart: form.guestVisitDate,
        periodEnd: form.guestVisitDate,
        lockerNumber: null,
        guest: {
          dni: guestDni,
          name: form.guestName.trim().toLocaleUpperCase("es-AR"),
          visitDate: form.guestVisitDate,
        },
        pool: null,
      });
    }

    if (form.enabled.PILETA) {
      const period = poolPeriod(form.poolSeason, form.poolSeasonType, form.poolMonth);
      if (!period) throw new Error("La temporada de pileta debe tener el formato 2026-2027.");
      items.push({
        concept: "PILETA",
        amount: requiredAmount(form.poolAmount, "pileta"),
        detail: form.poolSeasonType,
        periodStart: period.start,
        periodEnd: period.end,
        lockerNumber: null,
        guest: null,
        pool: {
          season: form.poolSeason,
          dayGroup: form.poolDayGroup,
          seasonType: form.poolSeasonType,
          month: form.poolSeasonType === "MES" ? form.poolMonth : null,
        },
      });
    }

    const activityPeriod = monthlyPeriod(form.activityPeriod);
    if ((form.enabled.ACTIVIDAD_1_SEMANAL || form.enabled.ACTIVIDAD_2_SEMANAL) && !activityPeriod) {
      throw new Error("Indicá el mes que cubre la actividad.");
    }

    if (form.enabled.INSCRIPCION_ACTIVIDADES) {
      items.push({
        concept: "INSCRIPCION_ACTIVIDADES",
        amount: requiredAmount(form.activityRegistrationAmount, "inscripción de actividades"),
        detail: "INSCRIPCION",
        periodStart: administrativeTodayKey(),
        periodEnd: administrativeTodayKey(),
        lockerNumber: null,
        guest: null,
        pool: null,
      });
    }

    if (form.enabled.ACTIVIDAD_1_SEMANAL && activityPeriod) {
      items.push({
        concept: "ACTIVIDAD_1_SEMANAL",
        amount: requiredAmount(form.activityOneAmount, "actividad 1 vez por semana"),
        detail: "ACTIVIDAD",
        periodStart: activityPeriod.start,
        periodEnd: activityPeriod.end,
        lockerNumber: null,
        guest: null,
        pool: null,
      });
    }

    if (form.enabled.ACTIVIDAD_2_SEMANAL && activityPeriod) {
      items.push({
        concept: "ACTIVIDAD_2_SEMANAL",
        amount: requiredAmount(form.activityTwoAmount, "actividad 2 veces por semana"),
        detail: "ACTIVIDAD",
        periodStart: activityPeriod.start,
        periodEnd: activityPeriod.end,
        lockerNumber: null,
        guest: null,
        pool: null,
      });
    }
    return items;
  }

  async function submitPayment(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    try {
      if (!selectedMember) throw new Error("Primero seleccioná un socio.");
      if (todayClosure) throw new Error("La rendición de hoy ya está cerrada para esta sede.");
      if (!form.receiptNumber.trim()) throw new Error("Ingresá el número de recibo o comprobante.");
      const items = buildItems();
      const totalAmount = items.reduce((sum, item) => sum + item.amount, 0);
      await createAdministrativePayment({
        member: {
          dni: selectedMember.dni,
          firstName: selectedMember.firstName,
          lastName: selectedMember.lastName,
        },
        pricingResidency: selectedMember.residencyStatus,
        centerId,
        items,
        totalAmount,
        paymentMethod: form.paymentMethod,
        receiptNumber: form.receiptNumber.trim(),
        notes: form.notes.trim(),
        operator: actor,
      });
      setForm(blankForm());
      setMessage(`✅ Cuota y servicio por ${money(totalAmount)} registrado con ${items.length} concepto${items.length === 1 ? "" : "s"}.`);
    } catch (error: unknown) {
      setMessage(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function voidPayment(payment: AdministrativePayment) {
    const reason = window.prompt(`Motivo de anulación del recibo ${payment.receiptNumber}:`);
    if (!reason?.trim()) return;
    try {
      await voidAdministrativePayment({ paymentId: payment.id, reason, actor });
    } catch (error: unknown) {
      setMessage(errorMessage(error));
    }
  }

  return <div className="cobros-page">
    <div className="cobros-heading">
      <div><h1>Cuotas y Servicios</h1><p>Registro y rendición de cuotas y servicios por sede.</p></div>
      <div className="cobros-center-control">
        <label><span>Sede activa</span>{allowedCenters.length > 1 ? <select className="input" value={centerId} onChange={(event) => setCenterId(event.target.value as CenterId)}>{allowedCenters.map((item) => <option key={item} value={item}>{CENTER_LABELS[item]}</option>)}</select> : <strong>{CENTER_LABELS[centerId]}</strong>}</label>
        {!canWrite && <span className="badge">Solo consulta</span>}
      </div>
    </div>

    <div className="cobros-view-tabs">
      <button className={activeView === "COBRAR" ? "active" : ""} onClick={() => setActiveView("COBRAR")}>Registrar cuotas y servicios</button>
      <button className={activeView === "RENDICION" ? "active" : ""} onClick={() => setActiveView("RENDICION")}>Rendición</button>
    </div>

    {activeView === "COBRAR" ? <>{todayClosure && <div className="socios-message info">La rendición de hoy ya fue cerrada para {CENTER_LABELS[centerId]}. Los registros y anulaciones quedaron bloqueados.</div>}<div className="cobros-summary">
      <div className="socios-stat"><span>Comprobantes de hoy</span><strong>{activeToday.length}</strong></div>
      <div className="socios-stat ok"><span>Total cobrado</span><strong>{money(totals.total)}</strong></div>
      <div className="socios-stat"><span>Efectivo</span><strong>{money(totals.cash)}</strong></div>
      <div className="socios-stat info"><span>Pago virtual</span><strong>{money(totals.mp)}</strong></div>
    </div>

    <div className="cobros-layout">
      <div className="grid">
        <Card title="1) Buscar socio">
          <form className="cobros-search" onSubmit={(event) => { event.preventDefault(); void lookupMember(); }}>
            <input className="input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="DNI, carnet, apellido o nombre" autoFocus />
            <button className="button" disabled={searching}>{searching ? "Buscando..." : "Buscar"}</button>
          </form>
          {searchError && <div className="socios-message error cobros-message">{searchError}</div>}
          {candidates.length > 0 && <div className="cobros-candidates">{candidates.map((member) => <button type="button" key={member.dni} onClick={() => selectMember(member)}><strong>{memberName(member)}</strong><span>DNI {member.dni}</span></button>)}</div>}
          {selectedMember && <div className="cobros-selected"><span>Socio seleccionado</span><strong>{memberName(selectedMember)}</strong><small>DNI {selectedMember.dni} · {residencyLabel(selectedMember.residencyStatus)}</small></div>}
          {selectedMember?.residencyStatus === "SIN_VERIFICAR" && <div className="socios-message info cobros-message">El domicilio todavía no está verificado. Se aplican los valores generales hasta que se actualice la ficha del socio.</div>}
          {selectedMember?.residencyStatus === "FUERA_SAN_ISIDRO" && <div className="socios-message info cobros-message">Se aplican los valores para socios con domicilio fuera del partido. Los conceptos sin arancel diferencial conservan el valor general.</div>}
        </Card>

        <Card title="2) Conceptos e importes">
          <form className="cobros-form" onSubmit={submitPayment}>
            <div className="cobros-concept-options">
              {availableConcepts.map((concept) => <label key={concept} className={`cobros-concept-check ${form.enabled[concept] ? "active" : ""}`}>
                <input type="checkbox" checked={form.enabled[concept]} disabled={concept === "INVITADO" && guestUnavailable && !form.enabled[concept]} onChange={() => toggleConcept(concept)} />
                <span>{centerConceptLabel(centerId, concept)}</span>
              </label>)}
            </div>

            {form.enabled.BONO_CONTRIBUCION && <section className="cobros-concept-panel">
              <h3>{centerId === "ANEXO_19" ? "Cuota social" : "Bono contribución"}</h3>
              <div className="cobros-rate-note">Tipos: seleccioná una o varias opciones para incluirlas en el mismo comprobante.</div>
              <div className="cobros-concept-options">
                {(centerId === "PUERTO_LIBRE" ? CONTRIBUTION_TYPES : (["CUOTA"] as ContributionType[])).map((type) => <label key={type} className={`cobros-concept-check ${form.contributionTypes[type] ? "active" : ""}`}>
                  <input type="checkbox" checked={form.contributionTypes[type]} onChange={() => toggleContributionType(type)} />
                  <span>{contributionTypeLabel(type, centerId)}</span>
                </label>)}
              </div>
              {form.contributionTypes.CUOTA && <div className="cobros-two-cols"><label><span>{contributionTypeLabel("CUOTA", centerId)} - importe</span><input type="number" min="0" step="0.01" className="input" value={form.contributionAmounts.CUOTA} onChange={(event) => setForm((current) => ({ ...current, contributionAmounts: { ...current.contributionAmounts, CUOTA: event.target.value } }))} /></label><label><span>Desde (mes/año)</span><input type="month" className="input" value={form.contributionStart} onChange={(event) => setForm({ ...form, contributionStart: event.target.value })} /></label><label><span>Hasta (mes/año)</span><input type="month" className="input" value={form.contributionEnd} onChange={(event) => setForm({ ...form, contributionEnd: event.target.value })} /></label></div>}
              {form.contributionTypes.INSCRIPCION && centerId === "PUERTO_LIBRE" && <label><span>Inscripción - importe</span><input type="number" min="0" step="0.01" className="input" value={form.contributionAmounts.INSCRIPCION} onChange={(event) => setForm((current) => ({ ...current, contributionAmounts: { ...current.contributionAmounts, INSCRIPCION: event.target.value } }))} /></label>}
              {form.contributionTypes.REINCORPORACION && centerId === "PUERTO_LIBRE" && <label><span>Reincorporación - importe</span><input type="number" min="0" step="0.01" className="input" value={form.contributionAmounts.REINCORPORACION} onChange={(event) => setForm((current) => ({ ...current, contributionAmounts: { ...current.contributionAmounts, REINCORPORACION: event.target.value } }))} /></label>}
            </section>}

            {form.enabled.LOCKER && <section className="cobros-concept-panel">
              <h3>Locker</h3>
              <div className="cobros-two-cols"><label><span>Número de locker</span><input className="input" value={form.lockerNumber} onChange={(event) => setForm({ ...form, lockerNumber: event.target.value })} placeholder="Ej. 173" /></label><label><span>Importe</span><input type="number" min="0" step="0.01" className="input" value={form.lockerAmount} onChange={(event) => setForm({ ...form, lockerAmount: event.target.value })} /></label><label><span>Desde (mes/año)</span><input type="month" className="input" value={form.lockerStart} onChange={(event) => setForm({ ...form, lockerStart: event.target.value })} /></label><label><span>Hasta (mes/año)</span><input type="month" className="input" value={form.lockerEnd} onChange={(event) => setForm({ ...form, lockerEnd: event.target.value })} /></label></div>
            </section>}

            {form.enabled.INVITADO && <section className="cobros-concept-panel">
              <h3>Invitado</h3>
              {guestUnavailable && <div className="socios-message error cobros-message">El tarifario no permite Invitados para socios de fuera del partido en el mes seleccionado.</div>}
              <div className="cobros-two-cols"><label><span>Nombre del invitado</span><input className="input" value={form.guestName} onChange={(event) => setForm({ ...form, guestName: event.target.value })} /></label><label><span>DNI del invitado (opcional)</span><input className="input" inputMode="numeric" value={form.guestDni} onChange={(event) => setForm({ ...form, guestDni: event.target.value })} /></label><label><span>Fecha de visita</span><input type="date" className="input" value={form.guestVisitDate} onChange={(event) => setForm({ ...form, guestVisitDate: event.target.value })} /></label><label><span>Importe</span><input type="number" min="0" step="0.01" className="input" value={form.guestAmount} onChange={(event) => setForm({ ...form, guestAmount: event.target.value })} /></label></div>
            </section>}

            {form.enabled.PILETA && <section className="cobros-concept-panel">
              <h3>Pileta</h3>
              <div className="cobros-two-cols">
                <label><span>Temporada</span><input className="input" value={form.poolSeason} onChange={(event) => setForm({ ...form, poolSeason: event.target.value })} placeholder="2026-2027" /></label>
                <label><span>Días de uso</span><select className="input" value={form.poolDayGroup} onChange={(event) => setForm({ ...form, poolDayGroup: event.target.value as PoolDayGroup })}><option value="LUN_MAR_JUE_SAB">Lunes, martes, jueves y sábado</option><option value="LUN_MIE_VIE_DOM">Lunes, miércoles, viernes y domingo</option></select></label>
                <label><span>Tipo de temporada</span><select className="input" value={form.poolSeasonType} onChange={(event) => setForm({ ...form, poolSeasonType: event.target.value as PoolSeasonType })}><option value="MES">Un mes</option><option value="TEMPORADA_COMPLETA">Temporada completa (4 meses)</option></select></label>
                {form.poolSeasonType === "MES" && <label><span>Mes</span><select className="input" value={form.poolMonth} onChange={(event) => setForm({ ...form, poolMonth: event.target.value as PoolMonth })}>{POOL_MONTHS.map((month) => <option key={month} value={month}>{month.charAt(0) + month.slice(1).toLocaleLowerCase("es-AR")}</option>)}</select></label>}
                <label><span>Importe</span><input type="number" min="0" step="0.01" className="input" value={form.poolAmount} onChange={(event) => setForm({ ...form, poolAmount: event.target.value })} /></label>
              </div>
            </section>}

            {form.enabled.INSCRIPCION_ACTIVIDADES && <section className="cobros-concept-panel">
              <h3>Inscripción de actividades</h3>
              <label><span>Importe</span><input type="number" min="0" step="0.01" className="input" value={form.activityRegistrationAmount} onChange={(event) => setForm({ ...form, activityRegistrationAmount: event.target.value })} /></label>
            </section>}

            {(form.enabled.ACTIVIDAD_1_SEMANAL || form.enabled.ACTIVIDAD_2_SEMANAL) && <section className="cobros-concept-panel">
              <h3>Actividades</h3>
              <label><span>Mes abonado</span><input type="month" className="input" value={form.activityPeriod} onChange={(event) => setForm({ ...form, activityPeriod: event.target.value })} /></label>
              {form.enabled.ACTIVIDAD_1_SEMANAL && <label><span>Actividad 1 vez por semana - importe</span><input type="number" min="0" step="0.01" className="input" value={form.activityOneAmount} onChange={(event) => setForm({ ...form, activityOneAmount: event.target.value })} /></label>}
              {form.enabled.ACTIVIDAD_2_SEMANAL && <label><span>Actividad 2 veces por semana - importe</span><input type="number" min="0" step="0.01" className="input" value={form.activityTwoAmount} onChange={(event) => setForm({ ...form, activityTwoAmount: event.target.value })} /></label>}
            </section>}

            <section className="cobros-payment-panel">
              <h3>Comprobante y pago</h3>
              <div className="cobros-rate-note">Aranceles cargados para {ADMINISTRATIVE_PRICE_VALIDITY.label}. En períodos que atraviesan un cambio de arancel, cada mes se suma con su valor vigente. Los importes siguen editables para contemplar excepciones autorizadas.</div>
              <div className="cobros-two-cols"><label><span>Medio de pago</span><select className="input" value={form.paymentMethod} onChange={(event) => setForm({ ...form, paymentMethod: event.target.value as AdministrativePaymentMethod })}><option value="EFECTIVO">Efectivo</option><option value="MP">Pago virtual</option></select></label><label><span>Número de recibo / comprobante</span><input className="input" value={form.receiptNumber} onChange={(event) => setForm({ ...form, receiptNumber: event.target.value })} /></label></div>
              <label><span>Observaciones</span><textarea rows={2} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
              <div className="cobros-form-total"><span>Total del comprobante</span><strong>{money(formTotal)}</strong></div>
            </section>

            {message && <div className={`socios-message ${message.startsWith("✅") ? "success" : "error"}`}>{message}</div>}
            <button className="button" disabled={!canWrite || saving || !selectedMember || formTotal <= 0 || Boolean(todayClosure)}>{saving ? "Guardando..." : `Registrar cuota y servicio por ${money(formTotal)}`}</button>
          </form>
        </Card>
      </div>

      <div className="grid">
        <PaymentTable title={selectedMember ? `Historial de ${memberName(selectedMember)}` : "Historial del socio"} payments={memberPayments} empty="Seleccioná un socio para corroborar sus pagos." canVoid={canWrite && !todayClosure} onVoid={voidPayment} />
        <PaymentTable title={`Movimientos de hoy · ${administrativeTodayKey()}`} payments={todayPayments} empty="Todavía no se registraron cuotas ni servicios hoy." canVoid={canWrite && !todayClosure} onVoid={voidPayment} />
      </div>
    </div></> : <CobrosRendicion centerId={centerId} canClose={canWrite} />}
  </div>;
}

function PaymentTable({ title, payments, empty, canVoid, onVoid }: {
  title: string;
  payments: AdministrativePayment[];
  empty: string;
  canVoid: boolean;
  onVoid: (payment: AdministrativePayment) => void;
}) {
  return <Card title={title}>
    {payments.length === 0 ? <div className="socios-muted-box">{empty}</div> : <div className="cobros-table-wrap"><table className="table cobros-table">
      <thead><tr><th>Fecha</th><th>Conceptos</th><th>Detalle</th><th>Recibo</th><th>Medio</th><th>Total</th><th>Estado</th><th></th></tr></thead>
      <tbody>{payments.map((payment) => <tr key={payment.id} className={payment.status === "VOID" ? "cobros-void" : ""}>
        <td>{dateTime(payment.createdAt)}</td>
        <td><div className="cobros-item-concepts">{payment.items.map((item, index) => <span className="socios-pill info" key={`${item.concept}-${item.detail}-${index}`}>{centerConceptLabel(payment.centerId, item.concept)}{item.concept === "BONO_CONTRIBUCION" ? ` · ${administrativeContributionTypeLabel(item.detail)}` : ""}</span>)}</div></td>
        <td><div className="cobros-item-details">{payment.items.map((item, index) => <div key={`${item.concept}-${item.detail}-${index}`}><span>{administrativeItemPeriod(item)}</span><strong>{money(item.amount)}</strong></div>)}</div></td>
        <td><div>{payment.receiptNumber}</div>{payment.pricingResidency && <small>{residencyLabel(payment.pricingResidency)}</small>}</td>
        <td>{payment.paymentMethod === "MP" ? "Pago virtual" : "Efectivo"}</td>
        <td>{money(Number(payment.totalAmount || 0))}</td>
        <td>{payment.status === "VOID" ? <span className="socios-pill danger">Anulado</span> : <span className="socios-pill ok">Vigente</span>}</td>
        <td>{canVoid && payment.status !== "VOID" ? <button className="button outline cobros-void-button" onClick={() => onVoid(payment)}>Anular</button> : null}</td>
      </tr>)}</tbody>
    </table></div>}
  </Card>;
}
