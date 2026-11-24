import type { AdministrativeConcept, AdministrativePaymentMethod } from "./administrativePayments";
import type { ResidencyStatus } from "./members";

export const CENTER_IDS = ["PUERTO_LIBRE", "ANEXO_19", "CENTRO_35"] as const;
export type CenterId = (typeof CENTER_IDS)[number];

export const CENTER_LABELS: Record<CenterId, string> = {
  PUERTO_LIBRE: "Puerto Libre",
  ANEXO_19: "Anexo 19",
  CENTRO_35: "Centro 35",
};

export const CENTER_CONCEPTS: Record<CenterId, AdministrativeConcept[]> = {
  PUERTO_LIBRE: ["BONO_CONTRIBUCION", "LOCKER", "INVITADO", "PILETA"],
  ANEXO_19: ["BONO_CONTRIBUCION", "ACTIVIDAD_1_SEMANAL", "ACTIVIDAD_2_SEMANAL"],
  CENTRO_35: ["INSCRIPCION_ACTIVIDADES", "ACTIVIDAD_1_SEMANAL", "ACTIVIDAD_2_SEMANAL"],
};

export function isCenterId(value: unknown): value is CenterId {
  return typeof value === "string" && CENTER_IDS.includes(value as CenterId);
}

export function centerConceptLabel(centerId: CenterId, concept: AdministrativeConcept) {
  if (concept === "BONO_CONTRIBUCION") return centerId === "ANEXO_19" ? "Cuota social" : "Bono contribución";
  if (concept === "LOCKER") return "Locker";
  if (concept === "INVITADO") return "Invitado";
  if (concept === "PILETA") return "Pileta";
  if (concept === "INSCRIPCION_ACTIVIDADES") return "Inscripción de actividades";
  if (concept === "ACTIVIDAD_1_SEMANAL") return "Actividad 1 vez por semana";
  return "Actividad 2 veces por semana";
}

type PriceEntry = {
  cash: number;
  virtual: number;
  outside?: number | "NOT_AVAILABLE";
};

type PriceKey = `${CenterId}:${AdministrativeConcept}:${string}`;
type PricePeriod = {
  from: string;
  to: string;
  label: string;
  prices: Partial<Record<PriceKey, PriceEntry>>;
};

const PRICE_PERIODS: PricePeriod[] = [
  {
    from: "2026-09",
    to: "2026-12",
    label: "septiembre a diciembre de 2026",
    prices: {
      "PUERTO_LIBRE:BONO_CONTRIBUCION:CUOTA": { cash: 2500, virtual: 2500 },
      "PUERTO_LIBRE:BONO_CONTRIBUCION:INSCRIPCION": { cash: 2500, virtual: 2500 },
      "PUERTO_LIBRE:BONO_CONTRIBUCION:REINCORPORACION": { cash: 10000, virtual: 10000 },
      "PUERTO_LIBRE:LOCKER:ALQUILER": { cash: 7000, virtual: 7000 },
      "PUERTO_LIBRE:INVITADO:INGRESO": { cash: 10000, virtual: 10000 },
      "ANEXO_19:BONO_CONTRIBUCION:CUOTA": { cash: 3000, virtual: 2500 },
      "ANEXO_19:ACTIVIDAD_1_SEMANAL:ACTIVIDAD": { cash: 2000, virtual: 1500 },
      "ANEXO_19:ACTIVIDAD_2_SEMANAL:ACTIVIDAD": { cash: 2500, virtual: 2000 },
      "CENTRO_35:INSCRIPCION_ACTIVIDADES:INSCRIPCION": { cash: 5000, virtual: 4000 },
      "CENTRO_35:ACTIVIDAD_1_SEMANAL:ACTIVIDAD": { cash: 4000, virtual: 3000 },
      "CENTRO_35:ACTIVIDAD_2_SEMANAL:ACTIVIDAD": { cash: 5000, virtual: 4000 },
    },
  },
  {
    from: "2027-01",
    to: "2027-04",
    label: "enero a abril de 2027",
    prices: {
      "PUERTO_LIBRE:BONO_CONTRIBUCION:CUOTA": { cash: 3000, virtual: 3000, outside: 7000 },
      "PUERTO_LIBRE:BONO_CONTRIBUCION:INSCRIPCION": { cash: 3000, virtual: 3000, outside: 7000 },
      "PUERTO_LIBRE:BONO_CONTRIBUCION:REINCORPORACION": { cash: 10000, virtual: 10000, outside: 35000 },
      "PUERTO_LIBRE:LOCKER:ALQUILER": { cash: 9000, virtual: 9000, outside: 20000 },
      "PUERTO_LIBRE:INVITADO:INGRESO": { cash: 15000, virtual: 15000, outside: "NOT_AVAILABLE" },
      "PUERTO_LIBRE:PILETA:TEMPORADA_COMPLETA": { cash: 30000, virtual: 30000, outside: 60000 },
      "PUERTO_LIBRE:PILETA:MES": { cash: 10000, virtual: 10000, outside: 20000 },
      "ANEXO_19:BONO_CONTRIBUCION:CUOTA": { cash: 4000, virtual: 3500 },
      "ANEXO_19:ACTIVIDAD_1_SEMANAL:ACTIVIDAD": { cash: 2500, virtual: 2000 },
      "ANEXO_19:ACTIVIDAD_2_SEMANAL:ACTIVIDAD": { cash: 3000, virtual: 2500 },
      "CENTRO_35:INSCRIPCION_ACTIVIDADES:INSCRIPCION": { cash: 5500, virtual: 4500 },
      "CENTRO_35:ACTIVIDAD_1_SEMANAL:ACTIVIDAD": { cash: 4500, virtual: 3500 },
      "CENTRO_35:ACTIVIDAD_2_SEMANAL:ACTIVIDAD": { cash: 5500, virtual: 4500 },
    },
  },
];

export const ADMINISTRATIVE_PRICE_VALIDITY = {
  label: PRICE_PERIODS.map((period) => period.label).join(" y "),
};

export type AdministrativePriceQuote = {
  status: "PRICED" | "UNAVAILABLE" | "MISSING";
  amount: number | null;
  periodLabel: string | null;
};

function pricePeriod(monthKey: string) {
  return PRICE_PERIODS.find((period) => monthKey >= period.from && monthKey <= period.to) ?? null;
}

export function administrativePriceQuote(params: {
  centerId: CenterId;
  concept: AdministrativeConcept;
  detail: string;
  paymentMethod: AdministrativePaymentMethod;
  monthKey: string;
  residencyStatus: ResidencyStatus;
}): AdministrativePriceQuote {
  const period = pricePeriod(params.monthKey);
  if (!period) return { status: "MISSING", amount: null, periodLabel: null };
  const key: PriceKey = `${params.centerId}:${params.concept}:${params.detail}`;
  const entry = period.prices[key];
  if (!entry) return { status: "MISSING", amount: null, periodLabel: period.label };

  if (params.residencyStatus === "FUERA_SAN_ISIDRO" && entry.outside === "NOT_AVAILABLE") {
    return { status: "UNAVAILABLE", amount: null, periodLabel: period.label };
  }
  const amount = params.residencyStatus === "FUERA_SAN_ISIDRO" && typeof entry.outside === "number"
    ? entry.outside
    : params.paymentMethod === "MP" ? entry.virtual : entry.cash;
  return { status: "PRICED", amount, periodLabel: period.label };
}

export function monthKeysBetween(from: string, to: string) {
  if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to) || from > to) return [];
  const result: string[] = [];
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  const endYear = Number(to.slice(0, 4));
  const endMonth = Number(to.slice(5, 7));
  while (year < endYear || (year === endYear && month <= endMonth)) {
    result.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
    if (result.length > 60) return [];
  }
  return result;
}

export function administrativeRangePrice(params: {
  centerId: CenterId;
  concept: AdministrativeConcept;
  detail: string;
  paymentMethod: AdministrativePaymentMethod;
  from: string;
  to: string;
  residencyStatus: ResidencyStatus;
}) {
  const months = monthKeysBetween(params.from, params.to);
  if (!months.length) return { status: "MISSING" as const, amount: null, quotes: [] };
  const quotes = months.map((monthKey) => ({
    monthKey,
    quote: administrativePriceQuote({ ...params, monthKey }),
  }));
  if (quotes.some(({ quote }) => quote.status === "UNAVAILABLE")) {
    return { status: "UNAVAILABLE" as const, amount: null, quotes };
  }
  if (quotes.some(({ quote }) => quote.status !== "PRICED" || quote.amount == null)) {
    return { status: "MISSING" as const, amount: null, quotes };
  }
  return {
    status: "PRICED" as const,
    amount: quotes.reduce((sum, { quote }) => sum + Number(quote.amount), 0),
    quotes,
  };
}
