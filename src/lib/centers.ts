import type {
  AdministrativeConcept,
  AdministrativePaymentMethod,
} from "./administrativePayments";

export const CENTER_IDS = ["PUERTO_LIBRE", "ANEXO_19", "CENTRO_35"] as const;
export type CenterId = typeof CENTER_IDS[number];

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

export function centerConceptLabel(centerId: CenterId, concept: AdministrativeConcept) {
  if (centerId === "ANEXO_19" && concept === "BONO_CONTRIBUCION") return "Cuota social";
  if (concept === "BONO_CONTRIBUCION") return "Bono contribución";
  if (concept === "LOCKER") return "Locker";
  if (concept === "INVITADO") return "Invitado";
  if (concept === "PILETA") return "Pileta";
  if (concept === "INSCRIPCION_ACTIVIDADES") return "Inscripción de actividades";
  if (concept === "ACTIVIDAD_1_SEMANAL") return "Actividad 1 vez por semana";
  return "Actividad 2 veces por semana";
}

type PriceKey = `${CenterId}:${AdministrativeConcept}:${string}`;

type PriceEntry = {
  cash: number;
  virtual: number;
};

const PRICES_SEP_DEC_2026: Partial<Record<PriceKey, PriceEntry>> = {
  "PUERTO_LIBRE:BONO_CONTRIBUCION:CUOTA": { cash: 2500, virtual: 2500 },
  "PUERTO_LIBRE:BONO_CONTRIBUCION:INSCRIPCION": { cash: 2500, virtual: 2500 },
  "PUERTO_LIBRE:BONO_CONTRIBUCION:REINCORPORACION": { cash: 12500, virtual: 12500 },
  "PUERTO_LIBRE:LOCKER:ALQUILER": { cash: 7000, virtual: 7000 },
  "PUERTO_LIBRE:INVITADO:INGRESO": { cash: 10000, virtual: 10000 },
  "ANEXO_19:BONO_CONTRIBUCION:CUOTA": { cash: 3000, virtual: 2500 },
  "ANEXO_19:ACTIVIDAD_1_SEMANAL:ACTIVIDAD": { cash: 2000, virtual: 1500 },
  "ANEXO_19:ACTIVIDAD_2_SEMANAL:ACTIVIDAD": { cash: 2500, virtual: 2000 },
  "CENTRO_35:INSCRIPCION_ACTIVIDADES:INSCRIPCION": { cash: 5000, virtual: 4000 },
  "CENTRO_35:ACTIVIDAD_1_SEMANAL:ACTIVIDAD": { cash: 4000, virtual: 3000 },
  "CENTRO_35:ACTIVIDAD_2_SEMANAL:ACTIVIDAD": { cash: 5000, virtual: 4000 },
};

export const ADMINISTRATIVE_PRICE_VALIDITY = {
  from: "2026-09-01",
  to: "2026-12-31",
  label: "septiembre a diciembre de 2026",
};

export function isCenterId(value: unknown): value is CenterId {
  return CENTER_IDS.includes(value as CenterId);
}

export function administrativePrice(params: {
  centerId: CenterId;
  concept: AdministrativeConcept;
  detail: string;
  paymentMethod: AdministrativePaymentMethod;
  dateKey?: string;
}) {
  const dateKey = params.dateKey ?? new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  if (dateKey < ADMINISTRATIVE_PRICE_VALIDITY.from || dateKey > ADMINISTRATIVE_PRICE_VALIDITY.to) {
    return null;
  }
  const entry = PRICES_SEP_DEC_2026[`${params.centerId}:${params.concept}:${params.detail}`];
  if (!entry) return null;
  return params.paymentMethod === "EFECTIVO" ? entry.cash : entry.virtual;
}
