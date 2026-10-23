import { useEffect, useMemo, useRef, useState } from "react";
import {
  collection,
  doc,
  documentId,
  getCountFromServer,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  startAfter,
  where,
  writeBatch,
} from "firebase/firestore";
import type { DocumentData } from "firebase/firestore";
import * as XLSX from "xlsx";
import { db } from "../firebase";
import { emptyMemberProfile, isMemberAlertActive, memberProfileFromData, residencyLabel } from "../lib/members";
import type { MemberAlert, MemberProfile, ResidencyStatus } from "../lib/members";
import { useAuth } from "../state/AuthContext";
import { Card } from "../ui/Card";

const PAGE_SIZE = 20;
const SOURCE_PAGE_SIZE = { members: 7, subsidized: 7, sales: 6 } as const;
const PURE_DNI_RE = /^\d{7,8}$/;

type BenefitFilter = "TODOS" | "SUBVENCIONADO" | "LOTE" | "SIN_BENEFICIO";
type ProfileFilter = "TODAS" | MemberProfile["profileStatus"];
type OriginFilter = "TODOS" | MemberOrigin;

type PurchaseSummary = {
  total: number;
  firstDate: string;
  lastDate: string;
  efectivo: number;
  mercadoPago: number;
  lote: number;
  subsidized: number;
};

type AuditEntry = {
  id: string;
  action: "CREATE" | "UPDATE" | "DELETE" | "IMPORT";
  actor?: { uid?: string; email?: string; name?: string };
  createdAt?: any;
};

type MemberDocument = {
  id: string;
  data: () => DocumentData | undefined;
};

type MemberRow = {
  dni: string;
  profile: MemberProfile;
  memberData: any;
  subsidizedData: any | null;
  alert: MemberAlert | null;
  qrCodes: string[];
  existsInMembers: boolean;
  origins: MemberOrigin[];
};

type MemberOrigin = "MEMBERS" | "SUBSIDIZED" | "SALE_TODAY";

type SourceCursors = {
  members: string | null;
  subsidized: string | null;
  sales: string | null;
};

type SourceCounts = {
  members: number | null;
  subsidized: number | null;
  salesToday: number | null;
};

type RegistrationCandidate = {
  profile: MemberProfile;
  subsidizedData: any | null;
};

type ImportedMember = {
  dni: string;
  firstName: string;
  lastName: string;
  residencyStatus: ResidencyStatus;
  sourceRow: number;
};

type ImportIssue = {
  row: number;
  dni: string;
  name: string;
  lastName: string;
  reason: string;
};

type ImportPreview = {
  fileName: string;
  valid: ImportedMember[];
  issues: ImportIssue[];
  duplicates: number;
};

let cachedRows: MemberRow[] | null = null;
let cachedCursors: SourceCursors = { members: null, subsidized: null, sales: null };
let cachedHasMore = true;
let cachedCounts: SourceCounts = { members: null, subsidized: null, salesToday: null };
let cachedAt: Date | null = null;

function todayKey() {
  const date = new Date();
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function asDate(value: any): Date | null {
  if (!value) return null;
  if (typeof value?.toDate === "function") return value.toDate();
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDate(value: any, includeTime = false) {
  const date = asDate(value);
  if (!date) return "—";
  return new Intl.DateTimeFormat("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    ...(includeTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(date);
}

function formatDateKey(value: string) {
  if (!value) return "—";
  const parts = value.split("-");
  return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : value;
}

function isFutureOrToday(value: any) {
  const date = asDate(value);
  if (!date) return true;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  return date >= startOfToday;
}

function hasActiveSubsidy(row: MemberRow) {
  return Boolean(row.subsidizedData?.active && isFutureOrToday(row.subsidizedData?.expiresAt));
}

function hasActiveBundle(row: MemberRow) {
  const bundle = row.memberData?.active_bundle;
  return Boolean(Number(bundle?.remaining) > 0 && isFutureOrToday(bundle?.expiresAt));
}

function displayName(row: MemberRow) {
  return [row.profile.lastName, row.profile.firstName].filter(Boolean).join(", ") || "Sin nombre cargado";
}

function addressLabel(profile: MemberProfile) {
  const streetAndNumber = [profile.address.street, profile.address.number].filter(Boolean).join(" ");
  return [streetAndNumber, profile.address.locality].filter(Boolean).join(", ") || "—";
}

function statusPill(label: string, tone: "ok" | "warn" | "danger" | "info" | "muted") {
  return <span className={`socios-pill ${tone}`}>{label}</span>;
}

function originLabel(origin: MemberOrigin) {
  if (origin === "MEMBERS") return "Ficha maestra";
  if (origin === "SUBSIDIZED") return "Subvencionado";
  return "Venta de hoy";
}

function normalizeHeader(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLocaleUpperCase("es-AR");
}

function normalizeResidency(value: unknown): ResidencyStatus {
  const normalized = normalizeHeader(value).replace(/[\s-]+/g, "_");
  if (normalized === "SAN_ISIDRO" || normalized === "SANISIDRO") return "SAN_ISIDRO";
  if (normalized === "FUERA_SAN_ISIDRO" || normalized === "FUERA_DE_SAN_ISIDRO") return "FUERA_SAN_ISIDRO";
  return "SIN_VERIFICAR";
}

function emptyPurchaseSummary(): PurchaseSummary {
  return { total: 0, firstDate: "", lastDate: "", efectivo: 0, mercadoPago: 0, lote: 0, subsidized: 0 };
}

async function hydrateSources(
  memberDocs: MemberDocument[],
  subsidizedDocs: MemberDocument[] = [],
  saleDocs: MemberDocument[] = [],
): Promise<MemberRow[]> {
  const memberDataByDni = new Map<string, any>();
  const subsidizedDataByDni = new Map<string, any>();
  const originsByDni = new Map<string, Set<MemberOrigin>>();
  const addOrigin = (dni: string, origin: MemberOrigin) => {
    if (!PURE_DNI_RE.test(dni)) return;
    const origins = originsByDni.get(dni) ?? new Set<MemberOrigin>();
    origins.add(origin);
    originsByDni.set(dni, origins);
  };

  memberDocs.forEach((snapshot) => {
    memberDataByDni.set(snapshot.id, snapshot.data() ?? {});
    addOrigin(snapshot.id, "MEMBERS");
  });
  subsidizedDocs.forEach((snapshot) => {
    subsidizedDataByDni.set(snapshot.id, snapshot.data() ?? {});
    addOrigin(snapshot.id, "SUBSIDIZED");
  });
  saleDocs.forEach((snapshot) => {
    const sale = snapshot.data() ?? {};
    const dni = String(sale?.member?.id ?? "").trim();
    if (!sale?.voided) addOrigin(dni, "SALE_TODAY");
  });

  const dnis = Array.from(originsByDni.keys());
  if (!dnis.length) return [];
  const missingMemberDnis = dnis.filter((dni) => !memberDataByDni.has(dni));
  const missingSubsidizedDnis = dnis.filter((dni) => !subsidizedDataByDni.has(dni));
  const [missingMembersSnap, missingSubsidizedSnap, alertsSnap, qrSnap] = await Promise.all([
    missingMemberDnis.length
      ? getDocs(query(collection(db, "members"), where(documentId(), "in", missingMemberDnis)))
      : Promise.resolve(null),
    missingSubsidizedDnis.length
      ? getDocs(query(collection(db, "subsidized_members"), where(documentId(), "in", missingSubsidizedDnis)))
      : Promise.resolve(null),
    getDocs(query(collection(db, "member_alerts"), where(documentId(), "in", dnis))),
    getDocs(query(collection(db, "qr_mappings"), where("dni", "in", dnis))),
  ]);

  missingMembersSnap?.forEach((snapshot) => {
    memberDataByDni.set(snapshot.id, snapshot.data());
    addOrigin(snapshot.id, "MEMBERS");
  });
  missingSubsidizedSnap?.forEach((snapshot) => {
    subsidizedDataByDni.set(snapshot.id, snapshot.data());
    addOrigin(snapshot.id, "SUBSIDIZED");
  });
  const alerts = new Map<string, MemberAlert>();
  const qrCodes = new Map<string, string[]>();
  alertsSnap.forEach((snapshot) => alerts.set(snapshot.id, { dni: snapshot.id, ...snapshot.data() } as MemberAlert));
  qrSnap.forEach((snapshot) => {
    const dni = String(snapshot.data()?.dni ?? "");
    const current = qrCodes.get(dni) ?? [];
    current.push(snapshot.id);
    qrCodes.set(dni, current);
  });

  return dnis.map((dni) => {
    const memberData = memberDataByDni.get(dni) ?? {};
    const subsidizedData = subsidizedDataByDni.get(dni) ?? null;
    const profile = memberProfileFromData(dni, {
      ...memberData,
      firstName: memberData?.firstName || memberData?.name || subsidizedData?.name || "",
      lastName: memberData?.lastName || subsidizedData?.lastName || "",
    });
    return {
      dni,
      profile,
      memberData,
      subsidizedData,
      alert: alerts.get(dni) ?? null,
      qrCodes: (qrCodes.get(dni) ?? []).sort(),
      existsInMembers: memberDataByDni.has(dni),
      origins: Array.from(originsByDni.get(dni) ?? []),
    };
  });
}

function mergeRows(existing: MemberRow[], incoming: MemberRow[]) {
  const merged = new Map(existing.map((row) => [row.dni, row]));
  incoming.forEach((row) => {
    const current = merged.get(row.dni);
    if (!current) {
      merged.set(row.dni, row);
      return;
    }
    const origins = Array.from(new Set([...current.origins, ...row.origins]));
    merged.set(row.dni, {
      ...current,
      ...row,
      memberData: row.existsInMembers ? row.memberData : current.memberData,
      subsidizedData: row.subsidizedData ?? current.subsidizedData,
      existsInMembers: current.existsInMembers || row.existsInMembers,
      origins,
    });
  });
  return Array.from(merged.values());
}

export default function Socios() {
  const { user, role } = useAuth();
  const canImportExcel = role === "root";
  const canManageMembers = role === "root" || role === "administrador" || role === "administrativo";
  const canDeleteMembers = role === "root";
  const [rows, setRows] = useState<MemberRow[]>(() => cachedRows ?? []);
  const [cursors, setCursors] = useState<SourceCursors>(cachedCursors);
  const [hasMore, setHasMore] = useState(cachedHasMore);
  const [counts, setCounts] = useState<SourceCounts>(cachedCounts);
  const [selectedDni, setSelectedDni] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [profileFilter, setProfileFilter] = useState<ProfileFilter>("TODAS");
  const [residencyFilter, setResidencyFilter] = useState<"TODAS" | ResidencyStatus>("TODAS");
  const [benefitFilter, setBenefitFilter] = useState<BenefitFilter>("TODOS");
  const [originFilter, setOriginFilter] = useState<OriginFilter>("TODOS");
  const [loading, setLoading] = useState(cachedRows === null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [registration, setRegistration] = useState<RegistrationCandidate | null>(null);
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(0);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(cachedAt);
  const initialLoadStarted = useRef(false);

  function commitCache(nextRows: MemberRow[], nextCursors: SourceCursors, nextHasMore: boolean, nextCounts: SourceCounts) {
    cachedRows = nextRows;
    cachedCursors = nextCursors;
    cachedHasMore = nextHasMore;
    cachedCounts = nextCounts;
    cachedAt = new Date();
    setRows(nextRows);
    setCursors(nextCursors);
    setHasMore(nextHasMore);
    setCounts(nextCounts);
    setLastUpdated(cachedAt);
  }

  async function backfillSubsidizedMembers(pageRows: MemberRow[]) {
    if (!user || !canManageMembers) return { rows: pageRows, created: 0 };
    const missing = pageRows.filter((row) => row.subsidizedData && !row.existsInMembers);
    if (!missing.length) return { rows: pageRows, created: 0 };

    const actor = { uid: user.uid, email: user.email ?? "", name: user.displayName ?? "" };
    const batch = writeBatch(db);
    missing.forEach((row) => {
      const firstName = String(row.subsidizedData?.name ?? row.profile.firstName).trim().toUpperCase();
      const lastName = String(row.subsidizedData?.lastName ?? row.profile.lastName).trim().toUpperCase();
      const payload = {
        id: row.dni,
        dni: row.dni,
        firstName,
        name: firstName,
        lastName,
        createdAt: serverTimestamp(),
        createdBy: actor,
        updatedAt: serverTimestamp(),
        updatedBy: actor,
      };
      batch.set(doc(db, "members", row.dni), payload, { merge: true });
      batch.set(doc(collection(db, "member_audit")), {
        dni: row.dni,
        action: "CREATE",
        before: null,
        after: { dni: row.dni, firstName, lastName, profileStatus: "INCOMPLETO" },
        source: "SUBSIDIZED_MEMBERS_AUTO",
        actor,
        createdAt: serverTimestamp(),
      });
    });
    await batch.commit();

    const migrated = new Set(missing.map((row) => row.dni));
    return {
      created: missing.length,
      rows: pageRows.map((row) => {
        if (!migrated.has(row.dni)) return row;
        const firstName = String(row.subsidizedData?.name ?? row.profile.firstName).trim().toUpperCase();
        const lastName = String(row.subsidizedData?.lastName ?? row.profile.lastName).trim().toUpperCase();
        const memberData = {
          id: row.dni,
          dni: row.dni,
          firstName,
          name: firstName,
          lastName,
          createdAt: new Date(),
          createdBy: actor,
          updatedAt: new Date(),
          updatedBy: actor,
        };
        return {
          ...row,
          memberData,
          profile: memberProfileFromData(row.dni, memberData),
          existsInMembers: true,
          origins: Array.from(new Set<MemberOrigin>([...row.origins, "MEMBERS"])),
        };
      }),
    };
  }

  async function loadMembers(reset = false) {
    if (loading && !reset) return;
    setLoading(true);
    setError("");
    try {
      const current = reset ? { members: null, subsidized: null, sales: null } : cursors;
      const pageQuery = (collectionName: string, after: string | null, size: number, constraints: any[] = []) => query(
        collection(db, collectionName),
        ...constraints,
        orderBy(documentId()),
        ...(after ? [startAfter(after)] : []),
        limit(size),
      );
      const todaySales = query(
        collection(db, "sales"),
        where("dateKey", "==", todayKey()),
        orderBy(documentId()),
        ...(current.sales ? [startAfter(current.sales)] : []),
        limit(SOURCE_PAGE_SIZE.sales),
      );
      const shouldCount = reset || counts.members === null || counts.subsidized === null || counts.salesToday === null;
      const [membersSnap, subsidizedSnap, salesSnap, membersCountSnap, subsidizedCountSnap, salesCountSnap] = await Promise.all([
        getDocs(pageQuery("members", current.members, SOURCE_PAGE_SIZE.members)),
        getDocs(pageQuery("subsidized_members", current.subsidized, SOURCE_PAGE_SIZE.subsidized)),
        getDocs(todaySales),
        shouldCount ? getCountFromServer(collection(db, "members")) : Promise.resolve(null),
        shouldCount ? getCountFromServer(collection(db, "subsidized_members")) : Promise.resolve(null),
        shouldCount ? getCountFromServer(query(collection(db, "sales"), where("dateKey", "==", todayKey()))) : Promise.resolve(null),
      ]);
      const hydratedRows = await hydrateSources(membersSnap.docs, subsidizedSnap.docs, salesSnap.docs);
      const backfilled = await backfillSubsidizedMembers(hydratedRows);
      const pageRows = backfilled.rows;
      const merged = reset ? pageRows : mergeRows(rows, pageRows);
      const nextCursors = {
        members: membersSnap.docs.at(-1)?.id ?? current.members,
        subsidized: subsidizedSnap.docs.at(-1)?.id ?? current.subsidized,
        sales: salesSnap.docs.at(-1)?.id ?? current.sales,
      };
      const nextCounts = shouldCount ? {
        members: (membersCountSnap?.data().count ?? counts.members) === null
          ? null
          : Number(membersCountSnap?.data().count ?? counts.members) + backfilled.created,
        subsidized: subsidizedCountSnap?.data().count ?? counts.subsidized,
        salesToday: salesCountSnap?.data().count ?? counts.salesToday,
      } : {
        ...counts,
        members: counts.members === null ? null : counts.members + backfilled.created,
      };
      const nextHasMore = membersSnap.size === SOURCE_PAGE_SIZE.members
        || subsidizedSnap.size === SOURCE_PAGE_SIZE.subsidized
        || salesSnap.size === SOURCE_PAGE_SIZE.sales;
      commitCache(merged, nextCursors, nextHasMore, nextCounts);
    } catch (loadError: any) {
      setError(`No se pudo cargar el padrón: ${loadError?.message || String(loadError)}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (initialLoadStarted.current || cachedRows) return;
    initialLoadStarted.current = true;
    void loadMembers(true);
  }, []);

  function openRow(row: MemberRow) {
    setError("");
    if (row.existsInMembers || !canManageMembers) {
      setRegistration(null);
      setNotice("");
      setSelectedDni(row.dni);
      return;
    }
    setSelectedDni(null);
    setRegistration({ profile: row.profile, subsidizedData: row.subsidizedData });
    const source = row.origins.includes("SUBSIDIZED") ? "subvencionados" : "las ventas de hoy";
    setNotice(`El DNI ${row.dni} aparece en ${source}, pero todavía no tiene ficha maestra. Completá los datos para registrarlo en Socios.`);
  }

  async function searchExactDni() {
    const dni = search.trim();
    if (!PURE_DNI_RE.test(dni)) {
      setError("Para buscar fuera de los socios cargados, ingresá un DNI exacto de 7 u 8 números.");
      return;
    }
    const existing = rows.find((row) => row.dni === dni);
    if (existing) {
      openRow(existing);
      return;
    }
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const [snapshot, subsidizedSnapshot] = await Promise.all([
        getDoc(doc(db, "members", dni)),
        getDoc(doc(db, "subsidized_members", dni)),
      ]);
      if (!snapshot.exists()) {
        const subsidizedData = subsidizedSnapshot.exists() ? subsidizedSnapshot.data() : null;
        if (subsidizedSnapshot.exists()) {
          const hydrated = await hydrateSources([], [subsidizedSnapshot]);
          const backfilled = await backfillSubsidizedMembers(hydrated);
          const row = backfilled.rows[0];
          if (!row) throw new Error("No se pudo incorporar automáticamente el socio subvencionado.");
          const nextRows = mergeRows([row], rows);
          const nextCounts = {
            ...counts,
            members: counts.members === null ? null : counts.members + backfilled.created,
          };
          commitCache(nextRows, cursors, hasMore, nextCounts);
          setRegistration(null);
          setSelectedDni(dni);
          setNotice(backfilled.created > 0
            ? `✅ El DNI ${dni} fue incorporado automáticamente desde Gabinete Social.`
            : `El DNI ${dni} figura en Gabinete Social y todavía no tiene ficha maestra.`);
          return;
        }
        if (!canManageMembers) {
          setError(`El DNI ${dni} no existe en el padrón de socios.`);
          return;
        }
        const profile = memberProfileFromData(dni, {
          firstName: subsidizedData?.name ?? "",
          lastName: subsidizedData?.lastName ?? "",
        });
        setSelectedDni(null);
        setRegistration({ profile, subsidizedData });
        setNotice(`El DNI ${dni} todavía no existe en Socios. Podés registrarlo como un socio nuevo.`);
        return;
      }
      const [row] = await hydrateSources([snapshot], subsidizedSnapshot.exists() ? [subsidizedSnapshot] : []);
      if (!row) return;
      const nextRows = mergeRows([row], rows);
      commitCache(nextRows, cursors, hasMore, counts);
      setRegistration(null);
      setSelectedDni(dni);
    } catch (searchError: any) {
      setError(`No se pudo buscar el socio: ${searchError?.message || String(searchError)}`);
    } finally {
      setLoading(false);
    }
  }

  function startRegistration() {
    if (!canManageMembers) return;
    const dni = PURE_DNI_RE.test(search.trim()) ? search.trim() : "";
    setSelectedDni(null);
    setError("");
    setNotice(dni ? `Completá los datos para registrar el DNI ${dni} en Socios.` : "Completá los datos para registrar un nuevo socio.");
    setRegistration({ profile: emptyMemberProfile(dni), subsidizedData: null });
  }

  async function registerMember(candidate: RegistrationCandidate, draft: MemberProfile) {
    if (!user) throw new Error("No hay una sesión activa.");
    const dni = draft.dni.trim();
    if (!PURE_DNI_RE.test(dni)) throw new Error("Ingresá un DNI válido de 7 u 8 números, sin puntos.");
    const normalized = memberProfileFromData(dni, draft);
    if (!normalized.firstName.trim() || !normalized.lastName.trim()) throw new Error("Nombre y apellido son obligatorios.");
    const current = await getDoc(doc(db, "members", dni));
    if (current.exists()) throw new Error(`El DNI ${dni} ya está registrado en Socios.`);

    const actor = { uid: user.uid, email: user.email ?? "", name: user.displayName ?? "" };
    const payload = {
      id: dni,
      dni,
      firstName: normalized.firstName.trim().toUpperCase(),
      name: normalized.firstName.trim().toUpperCase(),
      lastName: normalized.lastName.trim().toUpperCase(),
      birthDate: normalized.birthDate,
      address: {
        street: normalized.address.street.trim().toUpperCase(),
        number: normalized.address.number.trim().toUpperCase(),
        locality: normalized.address.locality.trim().toUpperCase(),
      },
      residencyStatus: normalized.residencyStatus,
      profileStatus: normalized.profileStatus,
      active: true,
      createdAt: serverTimestamp(),
      createdBy: actor,
      updatedAt: serverTimestamp(),
      updatedBy: actor,
    };
    const batch = writeBatch(db);
    batch.set(doc(db, "members", dni), payload);
    if (candidate.subsidizedData) {
      batch.set(doc(db, "subsidized_members", dni), { name: payload.firstName, lastName: payload.lastName }, { merge: true });
    }
    batch.set(doc(collection(db, "member_audit")), {
      dni,
      action: "CREATE",
      before: null,
      after: { ...normalized, firstName: payload.firstName, lastName: payload.lastName, address: payload.address },
      source: candidate.subsidizedData ? "SUBSIDIZED_MEMBERS" : "MANUAL",
      actor,
      createdAt: serverTimestamp(),
    });
    await batch.commit();

    const createdSnapshot = await getDoc(doc(db, "members", dni));
    const subsidizedSnapshot = await getDoc(doc(db, "subsidized_members", dni));
    const [createdRow] = await hydrateSources([createdSnapshot], subsidizedSnapshot.exists() ? [subsidizedSnapshot] : []);
    if (!createdRow) throw new Error("El socio se guardó, pero no se pudo cargar su ficha.");
    const previous = rows.find((row) => row.dni === dni);
    const nextRows = [
      { ...createdRow, origins: Array.from(new Set([...(previous?.origins ?? []), ...createdRow.origins])) },
      ...rows.filter((row) => row.dni !== dni),
    ];
    const nextCounts = { ...counts, members: counts.members === null ? null : counts.members + 1 };
    commitCache(nextRows, cursors, hasMore, nextCounts);
    setRegistration(null);
    setSelectedDni(dni);
    setSearch(dni);
    setNotice(`✅ El DNI ${dni} quedó registrado en Socios.`);
  }

  async function saveMember(row: MemberRow, draft: MemberProfile) {
    if (!user) throw new Error("No hay una sesión activa.");
    const normalized = memberProfileFromData(row.dni, draft);
    if (!normalized.firstName.trim() || !normalized.lastName.trim()) throw new Error("Nombre y apellido son obligatorios.");
    const actor = { uid: user.uid, email: user.email ?? "", name: user.displayName ?? "" };
    const payload = {
      id: row.dni,
      dni: row.dni,
      firstName: normalized.firstName.trim().toUpperCase(),
      name: normalized.firstName.trim().toUpperCase(),
      lastName: normalized.lastName.trim().toUpperCase(),
      birthDate: normalized.birthDate,
      address: {
        street: normalized.address.street.trim().toUpperCase(),
        number: normalized.address.number.trim().toUpperCase(),
        locality: normalized.address.locality.trim().toUpperCase(),
      },
      residencyStatus: normalized.residencyStatus,
      profileStatus: normalized.profileStatus,
      updatedAt: serverTimestamp(),
      updatedBy: actor,
    };
    const batch = writeBatch(db);
    batch.set(doc(db, "members", row.dni), payload, { merge: true });
    if (row.subsidizedData) {
      batch.set(doc(db, "subsidized_members", row.dni), { name: payload.firstName, lastName: payload.lastName }, { merge: true });
    }
    batch.set(doc(collection(db, "member_audit")), {
      dni: row.dni,
      action: "UPDATE",
      before: row.profile,
      after: { ...normalized, firstName: payload.firstName, lastName: payload.lastName, address: payload.address },
      actor,
      createdAt: serverTimestamp(),
    });
    await batch.commit();

    const updatedMemberData = { ...row.memberData, ...payload, updatedAt: new Date(), updatedBy: actor };
    const updatedRow: MemberRow = {
      ...row,
      profile: memberProfileFromData(row.dni, updatedMemberData),
      memberData: updatedMemberData,
      subsidizedData: row.subsidizedData ? { ...row.subsidizedData, name: payload.firstName, lastName: payload.lastName } : null,
    };
    const nextRows = rows.map((candidate) => candidate.dni === row.dni ? updatedRow : candidate);
    commitCache(nextRows, cursors, hasMore, counts);
  }

  async function deleteMember(row: MemberRow) {
    if (!user) throw new Error("No hay una sesión activa.");
    const confirmation = window.prompt(
      `Esta acción eliminará la ficha, el beneficio, la alerta y los QR vinculados. Las ventas históricas se conservarán.\n\nEscribí el DNI ${row.dni} para confirmar:`
    );
    if (confirmation?.trim() !== row.dni) throw new Error("Eliminación cancelada: el DNI ingresado no coincide.");

    const actor = { uid: user.uid, email: user.email ?? "", name: user.displayName ?? "" };
    const qrSnap = await getDocs(query(collection(db, "qr_mappings"), where("dni", "==", row.dni)));
    const batch = writeBatch(db);
    batch.set(doc(collection(db, "member_audit")), {
      dni: row.dni,
      action: "DELETE",
      snapshot: { member: row.memberData, subsidized: row.subsidizedData, alert: row.alert, qrCodes: qrSnap.docs.map((snapshot) => snapshot.id) },
      actor,
      createdAt: serverTimestamp(),
    });
    batch.delete(doc(db, "members", row.dni));
    batch.delete(doc(db, "subsidized_members", row.dni));
    batch.delete(doc(db, "member_alerts", row.dni));
    qrSnap.forEach((snapshot) => batch.delete(snapshot.ref));
    await batch.commit();

    const nextRows = rows.filter((candidate) => candidate.dni !== row.dni);
    const nextCounts = {
      ...counts,
      members: counts.members === null ? null : Math.max(0, counts.members - 1),
      subsidized: row.subsidizedData && counts.subsidized !== null ? Math.max(0, counts.subsidized - 1) : counts.subsidized,
    };
    commitCache(nextRows, cursors, hasMore, nextCounts);
    setSelectedDni(null);
  }

  const filteredRows = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("es");
    return rows.filter((row) => {
      const activeAlert = isMemberAlertActive(row.alert, todayKey());
      const searchable = [row.dni, row.profile.firstName, row.profile.lastName, row.profile.birthDate, row.profile.address.street, row.profile.address.number, row.profile.address.locality, row.qrCodes.join(" "), activeAlert ? row.alert?.message : ""].join(" ").toLocaleLowerCase("es");
      if (term && !searchable.includes(term)) return false;
      if (originFilter !== "TODOS" && !row.origins.includes(originFilter)) return false;
      if (profileFilter !== "TODAS" && row.profile.profileStatus !== profileFilter) return false;
      if (residencyFilter !== "TODAS" && row.profile.residencyStatus !== residencyFilter) return false;
      if (benefitFilter === "SUBVENCIONADO" && !hasActiveSubsidy(row)) return false;
      if (benefitFilter === "LOTE" && !hasActiveBundle(row)) return false;
      if (benefitFilter === "SIN_BENEFICIO" && (hasActiveSubsidy(row) || hasActiveBundle(row))) return false;
      return true;
    });
  }, [rows, search, originFilter, profileFilter, residencyFilter, benefitFilter]);

  const selected = selectedDni ? rows.find((row) => row.dni === selectedDni) ?? null : null;

  async function prepareExcelImport(file: File) {
    setError("");
    setNotice("");
    try {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const sheetName = workbook.SheetNames[0];
      if (!sheetName) throw new Error("El archivo no contiene hojas.");
      const sheet = workbook.Sheets[sheetName];
      const sourceRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: true });
      const valid: ImportedMember[] = [];
      const issues: ImportIssue[] = [];
      const seen = new Set<string>();
      let duplicates = 0;

      sourceRows.forEach((source, index) => {
        const row = Object.fromEntries(Object.entries(source).map(([key, value]) => [normalizeHeader(key), value]));
        const dni = String(row.DNI ?? "").replace(/\D/g, "");
        const firstName = String(row.NOMBRE ?? "").trim().toLocaleUpperCase("es-AR");
        const lastName = String(row.APELLIDO ?? "").trim().toLocaleUpperCase("es-AR");
        const sourceRow = index + 2;
        if (!PURE_DNI_RE.test(dni)) {
          issues.push({ row: sourceRow, dni, name: firstName, lastName, reason: "El DNI debe tener 7 u 8 dígitos" });
          return;
        }
        if (!firstName || !lastName) {
          issues.push({ row: sourceRow, dni, name: firstName, lastName, reason: "Falta nombre o apellido" });
          return;
        }
        if (seen.has(dni)) {
          duplicates += 1;
          issues.push({ row: sourceRow, dni, name: firstName, lastName, reason: "DNI duplicado en el archivo" });
          return;
        }
        seen.add(dni);
        valid.push({
          dni,
          firstName,
          lastName,
          residencyStatus: normalizeResidency(row.RESIDENCIA),
          sourceRow,
        });
      });

      setImportPreview({ fileName: file.name, valid, issues, duplicates });
    } catch (importError: any) {
      setImportPreview(null);
      setError(`No se pudo leer el Excel: ${importError?.message || String(importError)}`);
    }
  }

  async function importExcelMembers() {
    if (!user || !importPreview || !importPreview.valid.length) return;
    const accepted = window.confirm(
      `Se guardarán ${importPreview.valid.length} socios. ${importPreview.issues.length} filas inválidas quedarán excluidas. ¿Continuar?`
    );
    if (!accepted) return;

    setImporting(true);
    setImportProgress(0);
    setError("");
    setNotice("");
    let importedCount = 0;
    try {
      const actor = { uid: user.uid, email: user.email ?? "", name: user.displayName ?? "" };
      const chunkSize = 200;
      for (let offset = 0; offset < importPreview.valid.length; offset += chunkSize) {
        const chunk = importPreview.valid.slice(offset, offset + chunkSize);
        const batch = writeBatch(db);
        chunk.forEach((member) => {
          const after = {
            dni: member.dni,
            firstName: member.firstName,
            lastName: member.lastName,
            residencyStatus: member.residencyStatus,
            sourceRow: member.sourceRow,
          };
          batch.set(doc(db, "members", member.dni), {
            id: member.dni,
            dni: member.dni,
            firstName: member.firstName,
            name: member.firstName,
            lastName: member.lastName,
            residencyStatus: member.residencyStatus,
            updatedAt: serverTimestamp(),
            updatedBy: actor,
            importedAt: serverTimestamp(),
            importSource: importPreview.fileName,
          }, { merge: true });
          batch.set(doc(collection(db, "member_audit")), {
            dni: member.dni,
            action: "IMPORT",
            before: null,
            after,
            source: "EXCEL_IMPORT",
            sourceFile: importPreview.fileName,
            actor,
            createdAt: serverTimestamp(),
          });
        });
        await batch.commit();
        importedCount = Math.min(importPreview.valid.length, offset + chunk.length);
        setImportProgress(importedCount);
      }
      const imported = importPreview.valid.length;
      const rejected = importPreview.issues.length;
      setImportPreview(null);
      setNotice(`✅ Se importaron ${imported} socios. ${rejected} filas inválidas fueron excluidas.`);
      await loadMembers(true);
    } catch (importError: any) {
      setError(`La importación se detuvo después de ${importedCount} socios: ${importError?.message || String(importError)}`);
    } finally {
      setImporting(false);
    }
  }

  function exportImportIssues() {
    if (!importPreview?.issues.length) return;
    const worksheet = XLSX.utils.json_to_sheet(importPreview.issues.map((issue) => ({
      Fila: issue.row,
      DNI: issue.dni,
      Nombre: issue.name,
      Apellido: issue.lastName,
      Motivo: issue.reason,
    })));
    worksheet["!cols"] = [{ wch: 10 }, { wch: 16 }, { wch: 28 }, { wch: 28 }, { wch: 36 }];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Filas rechazadas");
    XLSX.writeFile(workbook, `socios_rechazados_${todayKey()}.xlsx`);
  }

  function exportExcel() {
    const exportRows = filteredRows.map((row) => ({
      DNI: row.dni,
      Origen: row.origins.map(originLabel).join(" | "),
      Apellido: row.profile.lastName,
      Nombre: row.profile.firstName,
      "Fecha de nacimiento": row.profile.birthDate,
      Calle: row.profile.address.street,
      Número: row.profile.address.number,
      Localidad: row.profile.address.locality,
      Residencia: residencyLabel(row.profile.residencyStatus),
      "Estado de ficha": row.profile.profileStatus,
      "Subvencionado activo": hasActiveSubsidy(row) ? "Sí" : "No",
      "Vencimiento subvención": formatDate(row.subsidizedData?.expiresAt),
      "Retiros subvencionados": Number(row.subsidizedData?.totalWithdrawals ?? 0),
      "Viandas de lote disponibles": Number(row.memberData?.active_bundle?.remaining ?? 0),
      "Vencimiento del lote": formatDate(row.memberData?.active_bundle?.expiresAt),
      "Alerta activa": isMemberAlertActive(row.alert, todayKey()) ? "Sí" : "No",
      "Detalle de alerta": isMemberAlertActive(row.alert, todayKey()) ? row.alert?.message ?? "" : "",
      "Códigos QR vinculados": row.qrCodes.join(" | "),
      "Última actualización": formatDate(row.memberData?.updatedAt, true),
      "Actualizado por": row.memberData?.updatedBy?.email || row.memberData?.updatedBy?.name || "",
    }));
    const worksheet = XLSX.utils.json_to_sheet(exportRows);
    worksheet["!cols"] = Array.from({ length: 20 }, () => ({ wch: 22 }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Socios cargados");
    XLSX.writeFile(workbook, `padron_socios_cargados_${todayKey()}.xlsx`);
  }

  return (
    <div className="socios-page">
      <div className="socios-heading">
        <div><h1>Socios</h1><p>Vista unificada de fichas maestras, subvencionados y ventas de hoy. Se consultan hasta {PAGE_SIZE} registros base por vez.</p></div>
        <div className="socios-actions">
          {canManageMembers && <button className="button outline" onClick={startRegistration} disabled={loading}>+ Registrar socio</button>}
          {canImportExcel && (
            <label className={`button outline socios-file-button ${loading || importing ? "disabled" : ""}`}>
              Importar Excel
              <input
                type="file"
                accept=".xlsx,.xls"
                disabled={loading || importing}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void prepareExcelImport(file);
                  event.target.value = "";
                }}
              />
            </label>
          )}
          <button className="button outline" onClick={() => void loadMembers(true)} disabled={loading}>{loading ? "Actualizando..." : "Actualizar"}</button>
          <button className="button" onClick={exportExcel} disabled={loading || filteredRows.length === 0}>Exportar cargados</button>
        </div>
      </div>

      <div className="socios-summary socios-summary-four">
        <SummaryCard label="Fichas maestras" value={counts.members ?? "—"} active={originFilter === "MEMBERS"} onClick={() => setOriginFilter(originFilter === "MEMBERS" ? "TODOS" : "MEMBERS")} />
        <SummaryCard label="Subvencionados" value={counts.subsidized ?? "—"} tone="info" active={originFilter === "SUBSIDIZED"} onClick={() => setOriginFilter(originFilter === "SUBSIDIZED" ? "TODOS" : "SUBSIDIZED")} />
        <SummaryCard label="Ventas registradas hoy" value={counts.salesToday ?? "—"} tone="ok" active={originFilter === "SALE_TODAY"} onClick={() => setOriginFilter(originFilter === "SALE_TODAY" ? "TODOS" : "SALE_TODAY")} />
        <SummaryCard label="Todos los cargados" value={rows.length} tone="info" active={originFilter === "TODOS"} onClick={() => setOriginFilter("TODOS")} />
      </div>

      <Card title="Buscar y filtrar los socios cargados">
        <div className="socios-filters">
          <label><span>Buscar</span><div className="socios-search-row">
            <input className="input" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && PURE_DNI_RE.test(search.trim())) void searchExactDni(); }} placeholder="Nombre, domicilio o DNI" />
            <button className="button outline" onClick={() => void searchExactDni()} disabled={loading || !PURE_DNI_RE.test(search.trim())}>Buscar DNI</button>
          </div></label>
          <label><span>Ficha</span><select className="input" value={profileFilter} onChange={(event) => setProfileFilter(event.target.value as ProfileFilter)}><option value="TODAS">Todas</option><option value="COMPLETO">Completa</option><option value="INCOMPLETO">Incompleta</option></select></label>
          <label><span>Residencia</span><select className="input" value={residencyFilter} onChange={(event) => setResidencyFilter(event.target.value as "TODAS" | ResidencyStatus)}><option value="TODAS">Todas</option><option value="SAN_ISIDRO">San Isidro</option><option value="FUERA_SAN_ISIDRO">Fuera de San Isidro</option><option value="SIN_VERIFICAR">Sin verificar</option></select></label>
          <label><span>Beneficio</span><select className="input" value={benefitFilter} onChange={(event) => setBenefitFilter(event.target.value as BenefitFilter)}><option value="TODOS">Todos</option><option value="SUBVENCIONADO">Subvencionado activo</option><option value="LOTE">Lote activo</option><option value="SIN_BENEFICIO">Sin beneficio activo</option></select></label>
        </div>
        <div className="socios-filter-help">Los indicadores superiores también funcionan como filtros. Los demás filtros se aplican sobre los socios ya cargados. Para consultar cualquier persona sin recorrer todo el padrón, ingresá el DNI exacto.</div>
      </Card>

      {error && <div className="socios-message error">{error}</div>}
      {notice && <div className={`socios-message ${notice.startsWith("✅") ? "success" : "info"}`}>{notice}</div>}
      {importPreview && (
        <Card title={`Importar ${importPreview.fileName}`}>
          <div className="socios-import-review">
            <div>{statusPill(`${importPreview.valid.length} válidos`, "ok")}</div>
            <div>{statusPill(`${importPreview.issues.length} rechazados`, importPreview.issues.length ? "danger" : "muted")}</div>
            <div className="socios-import-copy">
              Solo se aceptan DNI de 7 u 8 dígitos. Nombre y apellido se guardarán en mayúsculas. Las filas rechazadas no se escriben en la base.
            </div>
            <div className="socios-form-actions">
              <button className="button" onClick={() => void importExcelMembers()} disabled={importing || importPreview.valid.length === 0}>
                {importing ? `Importando ${importProgress} de ${importPreview.valid.length}...` : `Importar ${importPreview.valid.length} socios`}
              </button>
              {importPreview.issues.length > 0 && <button className="button outline" onClick={exportImportIssues} disabled={importing}>Descargar rechazados</button>}
              <button className="button ghost" onClick={() => setImportPreview(null)} disabled={importing}>Cancelar</button>
            </div>
            {importPreview.issues.length > 0 && (
              <div className="socios-import-issues">
                {importPreview.issues.slice(0, 8).map((issue) => (
                  <div key={`${issue.row}-${issue.dni}`}><strong>Fila {issue.row}</strong> · DNI {issue.dni || "vacío"} · {issue.reason}</div>
                ))}
                {importPreview.issues.length > 8 && <div>Y {importPreview.issues.length - 8} filas rechazadas más.</div>}
              </div>
            )}
          </div>
        </Card>
      )}

      <div className="socios-layout">
        <Card title={`Listado (${filteredRows.length} visibles · ${rows.length} cargados)`} right={lastUpdated ? <span className="socios-updated">Actualizado {formatDate(lastUpdated, true)}</span> : undefined}>
          {loading && rows.length === 0 ? <div className="socios-empty">Cargando los primeros {PAGE_SIZE} socios...</div> : filteredRows.length === 0 ? <div className="socios-empty">No hay socios cargados que coincidan con los filtros.</div> : (
            <div className="socios-table-wrap"><table className="table socios-table">
              <thead><tr><th>Socio</th><th>DNI</th><th>Origen</th><th>Residencia</th><th>Beneficios</th><th>Ficha</th><th></th></tr></thead>
              <tbody>{filteredRows.map((row) => {
                const activeAlert = isMemberAlertActive(row.alert, todayKey());
                return <tr key={row.dni} className={selectedDni === row.dni ? "selected" : ""}>
                  <td><strong>{displayName(row)}</strong>{activeAlert && <div className="socios-row-note">⚠ {row.alert?.message}</div>}</td>
                  <td className="socios-nowrap">{row.dni}</td>
                  <td><div className="socios-pills">{row.origins.map((origin) => <span key={origin}>{statusPill(originLabel(origin), origin === "MEMBERS" ? "ok" : "info")}</span>)}</div></td>
                  <td>{residencyLabel(row.profile.residencyStatus)}</td>
                  <td><div className="socios-pills">{hasActiveSubsidy(row) && statusPill("Subvencionado", "info")}{hasActiveBundle(row) && statusPill(`${row.memberData.active_bundle.remaining} viandas`, "ok")}{!hasActiveSubsidy(row) && !hasActiveBundle(row) && statusPill("Sin beneficio", "muted")}</div></td>
                  <td>{row.profile.profileStatus === "COMPLETO" ? statusPill("Completa", "ok") : statusPill("Incompleta", "warn")}</td>
                  <td><button className="button ghost socios-detail-button" onClick={() => openRow(row)}>{canManageMembers ? (row.existsInMembers ? "Ver / editar" : "Registrar ficha") : "Ver"}</button></td>
                </tr>;
              })}</tbody>
            </table></div>
          )}
          <div className="socios-pager"><span>Cada consulta lee hasta {PAGE_SIZE} registros base y elimina DNIs duplicados.</span>{hasMore ? <button className="button outline" onClick={() => void loadMembers(false)} disabled={loading}>{loading ? "Cargando..." : `Cargar ${PAGE_SIZE} más`}</button> : <span className="socios-end">Fin de las fuentes</span>}</div>
        </Card>
        {registration && canManageMembers ? (
          <RegisterMemberForm
            key={`${registration.profile.dni}-${registration.subsidizedData ? "subsidized" : "manual"}`}
            candidate={registration}
            onCancel={() => { setRegistration(null); setNotice(""); }}
            onRegister={registerMember}
          />
        ) : (
          <MemberDetail row={selected} onClose={() => setSelectedDni(null)} onSave={saveMember} onDelete={deleteMember} canEdit={canManageMembers} canDelete={canDeleteMembers} />
        )}
      </div>
    </div>
  );
}

function RegisterMemberForm({ candidate, onCancel, onRegister }: {
  candidate: RegistrationCandidate;
  onCancel: () => void;
  onRegister: (candidate: RegistrationCandidate, draft: MemberProfile) => Promise<void>;
}) {
  const [draft, setDraft] = useState<MemberProfile>(candidate.profile);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    try {
      await onRegister(candidate, draft);
    } catch (registerError: any) {
      setMessage(registerError?.message || String(registerError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <aside className="panel socios-detail socios-register-panel">
      <div className="socios-detail-header">
        <div>
          <span>Alta en el padrón maestro</span>
          <h2>Registrar socio</h2>
          {candidate.subsidizedData && statusPill("Detectado en Gabinete Social", "info")}
        </div>
        <button className="button ghost socios-close" onClick={onCancel} aria-label="Cancelar registro">×</button>
      </div>
      {candidate.subsidizedData && (
        <div className="socios-source-notice">
          Encontramos este DNI en subvencionados y precargamos su nombre. Al guardar, quedará incorporado a Socios sin perder el beneficio ni sus retiros.
        </div>
      )}
      {message && <div className="socios-message error">{message}</div>}
      <form className="socios-edit-form" onSubmit={submit}>
        <label>
          <span>DNI *</span>
          <input
            className="input"
            inputMode="numeric"
            value={draft.dni}
            disabled={Boolean(candidate.subsidizedData)}
            onChange={(event) => setDraft({ ...draft, dni: event.target.value.replace(/\D/g, "").slice(0, 8) })}
            placeholder="Solo números, sin puntos"
          />
        </label>
        <div className="socios-edit-grid">
          <label><span>Nombre *</span><input className="input" value={draft.firstName} onChange={(event) => setDraft({ ...draft, firstName: event.target.value })} /></label>
          <label><span>Apellido *</span><input className="input" value={draft.lastName} onChange={(event) => setDraft({ ...draft, lastName: event.target.value })} /></label>
          <label><span>Fecha de nacimiento</span><input type="date" className="input" value={draft.birthDate} onChange={(event) => setDraft({ ...draft, birthDate: event.target.value })} /></label>
          <label><span>Calle</span><input className="input" value={draft.address.street} onChange={(event) => setDraft({ ...draft, address: { ...draft.address, street: event.target.value } })} /></label>
          <label><span>Número</span><input className="input" value={draft.address.number} onChange={(event) => setDraft({ ...draft, address: { ...draft.address, number: event.target.value } })} /></label>
          <label><span>Localidad</span><input className="input" value={draft.address.locality} onChange={(event) => setDraft({ ...draft, address: { ...draft.address, locality: event.target.value } })} /></label>
        </div>
        <label>
          <span>Residencia</span>
          <select className="input" value={draft.residencyStatus} onChange={(event) => setDraft({ ...draft, residencyStatus: event.target.value as ResidencyStatus })}>
            <option value="SIN_VERIFICAR">Sin verificar</option>
            <option value="SAN_ISIDRO">San Isidro</option>
            <option value="FUERA_SAN_ISIDRO">Fuera de San Isidro</option>
          </select>
        </label>
        <div className="socios-form-actions">
          <button className="button" disabled={saving}>{saving ? "Registrando..." : "Registrar en Socios"}</button>
          <button type="button" className="button outline" onClick={onCancel} disabled={saving}>Cancelar</button>
        </div>
      </form>
    </aside>
  );
}

function SummaryCard({ label, value, tone = "muted", active = false, onClick }: {
  label: string;
  value: string | number;
  tone?: "ok" | "warn" | "info" | "muted";
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className={`socios-stat ${tone} ${onClick ? "filterable" : ""} ${active ? "active" : ""}`}
      onClick={onClick}
      aria-pressed={onClick ? active : undefined}
    >
      <span>{label}</span><strong>{value}</strong>
      {onClick && <small>{active ? "Filtro activo" : "Filtrar listado"}</small>}
    </button>
  );
}

function DetailItem({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="socios-detail-item"><span>{label}</span><strong>{value || "—"}</strong></div>;
}

function summarizeSales(sales: DocumentData[]): PurchaseSummary {
  const summary = emptyPurchaseSummary();
  sales.forEach((sale) => {
    if (sale?.voided) return;
    const dateKey = String(sale?.dateKey ?? "");
    summary.total += 1;
    if (dateKey && (!summary.firstDate || dateKey < summary.firstDate)) summary.firstDate = dateKey;
    if (dateKey && (!summary.lastDate || dateKey > summary.lastDate)) summary.lastDate = dateKey;
    if (sale?.paymentMethod === "EFECTIVO") summary.efectivo += 1;
    if (sale?.paymentMethod === "MP") summary.mercadoPago += 1;
    if (sale?.paymentMethod === "LOTE_PREPAGO") summary.lote += 1;
    if (sale?.paymentMethod === "SUBVENCIONADO") summary.subsidized += 1;
  });
  return summary;
}

function MemberDetail({ row, onClose, onSave, onDelete, canEdit, canDelete }: {
  row: MemberRow | null;
  onClose: () => void;
  onSave: (row: MemberRow, draft: MemberProfile) => Promise<void>;
  onDelete: (row: MemberRow) => Promise<void>;
  canEdit: boolean;
  canDelete: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<MemberProfile | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState("");
  const [activity, setActivity] = useState<PurchaseSummary | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    setEditing(false);
    setDraft(row?.profile ?? null);
    setMessage("");
    if (!row) { setActivity(null); setAudit([]); return; }
    let active = true;
    setDetailsLoading(true);
    Promise.all([
      getDocs(query(collection(db, "sales"), where("member.id", "==", row.dni))),
      getDocs(query(collection(db, "member_audit"), where("dni", "==", row.dni))),
    ]).then(([salesSnap, auditSnap]) => {
      if (!active) return;
      setActivity(summarizeSales(salesSnap.docs.map((snapshot) => snapshot.data())));
      setAudit(auditSnap.docs.map((snapshot) => ({ id: snapshot.id, ...snapshot.data() } as AuditEntry)).sort((a, b) => (asDate(b.createdAt)?.getTime() ?? 0) - (asDate(a.createdAt)?.getTime() ?? 0)));
    }).catch((detailError: any) => {
      if (active) setMessage(`No se pudo cargar la actividad: ${detailError?.message || String(detailError)}`);
    }).finally(() => { if (active) setDetailsLoading(false); });
    return () => { active = false; };
  }, [row?.dni, reloadToken]);

  if (!row) return <div className="panel socios-detail socios-detail-placeholder"><div className="socios-detail-icon">👤</div><strong>Seleccioná un socio</strong><span>Usá “Ver / editar” para consultar y administrar la ficha.</span></div>;

  const bundle = row.memberData?.active_bundle;
  const activeAlert = isMemberAlertActive(row.alert, todayKey());

  async function submitEdit(event: React.FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setSaving(true); setMessage("");
    try {
      await onSave(row!, draft);
      setEditing(false);
      setMessage("✅ Cambios guardados y auditoría registrada.");
      setReloadToken((value) => value + 1);
    } catch (saveError: any) { setMessage(saveError?.message || String(saveError)); }
    finally { setSaving(false); }
  }

  async function remove() {
    setDeleting(true); setMessage("");
    try { await onDelete(row!); }
    catch (deleteError: any) { setMessage(deleteError?.message || String(deleteError)); }
    finally { setDeleting(false); }
  }

  return <aside className="panel socios-detail">
    <div className="socios-detail-header"><div><span>Ficha del socio</span><h2>{displayName(row)}</h2><div className="socios-pills">{row.profile.profileStatus === "COMPLETO" ? statusPill("Ficha completa", "ok") : statusPill("Ficha incompleta", "warn")}{activeAlert && statusPill("Alerta activa", "danger")}</div></div><button className="button ghost socios-close" onClick={onClose} aria-label="Cerrar ficha">×</button></div>
    {message && <div className={`socios-message ${message.startsWith("✅") ? "success" : "error"}`}>{message}</div>}

    {canEdit && editing && draft ? <form className="socios-edit-form" onSubmit={submitEdit}>
      <h3>Editar datos personales</h3><label><span>DNI (no editable)</span><input className="input" value={row.dni} disabled /></label>
      <div className="socios-edit-grid">
        <label><span>Nombre *</span><input className="input" value={draft.firstName} onChange={(event) => setDraft({ ...draft, firstName: event.target.value })} /></label>
        <label><span>Apellido *</span><input className="input" value={draft.lastName} onChange={(event) => setDraft({ ...draft, lastName: event.target.value })} /></label>
        <label><span>Fecha de nacimiento</span><input type="date" className="input" value={draft.birthDate} onChange={(event) => setDraft({ ...draft, birthDate: event.target.value })} /></label>
        <label><span>Calle</span><input className="input" value={draft.address.street} onChange={(event) => setDraft({ ...draft, address: { ...draft.address, street: event.target.value } })} /></label>
        <label><span>Número</span><input className="input" value={draft.address.number} onChange={(event) => setDraft({ ...draft, address: { ...draft.address, number: event.target.value } })} /></label>
        <label><span>Localidad</span><input className="input" value={draft.address.locality} onChange={(event) => setDraft({ ...draft, address: { ...draft.address, locality: event.target.value } })} /></label>
      </div>
      <label><span>Residencia</span><select className="input" value={draft.residencyStatus} onChange={(event) => setDraft({ ...draft, residencyStatus: event.target.value as ResidencyStatus })}><option value="SIN_VERIFICAR">Sin verificar</option><option value="SAN_ISIDRO">San Isidro</option><option value="FUERA_SAN_ISIDRO">Fuera de San Isidro</option></select></label>
      <div className="socios-form-actions"><button className="button" disabled={saving}>{saving ? "Guardando..." : "Guardar cambios"}</button><button type="button" className="button outline" onClick={() => { setEditing(false); setDraft(row.profile); }} disabled={saving}>Cancelar</button></div>
    </form> : <section><div className="socios-section-heading"><h3>Datos personales</h3>{canEdit && row.existsInMembers && <button className="button outline socios-small-button" onClick={() => { setDraft(row.profile); setEditing(true); }}>Editar</button>}</div><div className="socios-detail-grid"><DetailItem label="DNI" value={row.dni} /><DetailItem label="Nacimiento" value={formatDateKey(row.profile.birthDate)} /><DetailItem label="Domicilio" value={addressLabel(row.profile)} /><DetailItem label="Residencia" value={residencyLabel(row.profile.residencyStatus)} /></div></section>}

    <section><h3>Beneficios</h3><div className="socios-detail-grid"><DetailItem label="Subvención" value={hasActiveSubsidy(row) ? "Activa" : row.subsidizedData ? "Inactiva o vencida" : "No registrada"} /><DetailItem label="Vencimiento subvención" value={formatDate(row.subsidizedData?.expiresAt)} /><DetailItem label="Retiros subvencionados" value={Number(row.subsidizedData?.totalWithdrawals ?? 0)} /><DetailItem label="Lote" value={hasActiveBundle(row) ? "Activo" : bundle ? "Agotado o vencido" : "No registrado"} /><DetailItem label="Viandas disponibles" value={Number(bundle?.remaining ?? 0)} /><DetailItem label="Vencimiento lote" value={formatDate(bundle?.expiresAt)} /></div></section>
    <section><h3>Alerta</h3>{activeAlert ? <div className={`socios-alert ${row.alert?.level === "IMPORTANTE" ? "important" : ""}`}><strong>{row.alert?.level === "IMPORTANTE" ? "Importante" : "Información"}</strong><p>{row.alert?.message}</p><span>Vigencia: {row.alert?.validUntil ? formatDateKey(row.alert.validUntil) : "sin vencimiento"}</span></div> : <div className="socios-muted-box">No tiene alertas activas.</div>}</section>
    <section><h3>Actividad registrada</h3>{detailsLoading ? <div className="socios-muted-box">Cargando actividad de este socio...</div> : activity ? <div className="socios-detail-grid"><DetailItem label="Compras totales" value={activity.total} /><DetailItem label="Primera compra" value={formatDateKey(activity.firstDate)} /><DetailItem label="Última compra" value={formatDateKey(activity.lastDate)} /><DetailItem label="Efectivo" value={activity.efectivo} /><DetailItem label="Mercado Pago" value={activity.mercadoPago} /><DetailItem label="Usos de lote" value={activity.lote} /><DetailItem label="Retiros subvencionados" value={activity.subsidized} /></div> : null}</section>
    <section><h3>Carnets vinculados</h3>{row.qrCodes.length ? <div className="socios-code-list">{row.qrCodes.map((code) => <code key={code}>{code}</code>)}</div> : <div className="socios-muted-box">No tiene códigos QR antiguos vinculados.</div>}</section>
    <section><h3>Trazabilidad</h3><div className="socios-detail-grid"><DetailItem label="Alta" value={formatDate(row.memberData?.createdAt || row.subsidizedData?.createdAt, true)} /><DetailItem label="Creada por" value={row.memberData?.createdBy?.email || row.memberData?.createdBy?.name || "—"} /><DetailItem label="Última actualización" value={formatDate(row.memberData?.updatedAt, true)} /><DetailItem label="Actualizada por" value={row.memberData?.updatedBy?.email || row.memberData?.updatedBy?.name || "—"} /></div>{audit.length > 0 && <div className="socios-audit-list">{audit.slice(0, 8).map((entry) => <div key={entry.id}><strong>{entry.action === "CREATE" ? "Alta" : entry.action === "UPDATE" ? "Edición" : entry.action === "IMPORT" ? "Importación Excel" : "Eliminación"}</strong><span>{entry.actor?.email || entry.actor?.name || "Usuario sin identificar"} · {formatDate(entry.createdAt, true)}</span></div>)}</div>}</section>
    {canDelete && row.existsInMembers && <section className="socios-danger-zone"><h3>Eliminar del padrón</h3><p>Se conservarán las ventas históricas. La eliminación quedará registrada con tu usuario.</p><button className="button danger" onClick={() => void remove()} disabled={deleting}>{deleting ? "Eliminando..." : `Eliminar socio ${row.dni}`}</button></section>}
  </aside>;
}
