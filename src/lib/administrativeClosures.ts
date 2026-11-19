import {
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import type { Timestamp } from "firebase/firestore";
import { db } from "../firebase";
import type { CenterId } from "./centers";

export type AdministrativeClosure = {
  id: string;
  centerId: CenterId;
  dateKey: string;
  paymentsCount: number;
  expected: { cash: number; virtual: number; total: number };
  counted: { cash: number; virtual: number; total: number };
  difference: { cash: number; virtual: number; total: number };
  byConcept: Record<string, { count: number; amount: number }>;
  notes: string;
  closedAt?: Timestamp | Date | null;
  closedBy: { uid: string; email: string; name: string };
};

export function administrativeClosureId(centerId: CenterId, dateKey: string) {
  return `${dateKey}_${centerId}`;
}

export function listenAdministrativeClosure(
  centerId: CenterId,
  dateKey: string,
  setter: (closure: AdministrativeClosure | null) => void,
) {
  const closureRef = doc(db, "administrative_closures", administrativeClosureId(centerId, dateKey));
  return onSnapshot(closureRef, (snapshot) => {
    setter(snapshot.exists() ? ({ id: snapshot.id, ...snapshot.data() } as AdministrativeClosure) : null);
  });
}

export async function createAdministrativeClosure(
  input: Omit<AdministrativeClosure, "id" | "closedAt">,
) {
  const closureRef = doc(db, "administrative_closures", administrativeClosureId(input.centerId, input.dateKey));
  await setDoc(closureRef, { ...input, closedAt: serverTimestamp() });
}
