// src/lib/memberId.ts
import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "../firebase";
import { parseMemberQR } from "./parsers";

const PURE_DNI_RE = /^\d{7,9}$/;

/**
 * Resuelve el texto crudo de un QR/carnet escaneado al DNI canónico del socio.
 *
 * - Si lo escaneado ya es un DNI puro (7 a 9 dígitos), se devuelve tal cual.
 * - Si no lo es (carnets con un código interno, formato distinto, etc.), se
 *   busca una traducción ya guardada en la colección `qr_mappings`.
 * - Si tampoco existe esa traducción, se le pide al usuario que tipee el DNI
 *   una única vez, y se guarda la traducción para la próxima vez que se
 *   escanee ese mismo carnet.
 *
 * IMPORTANTE: esta misma función debe usarse en Caja (para cobrar) y en
 * Gabinete Social (para dar de alta subvencionados), de forma que ambas
 * pantallas usen siempre la misma clave (el DNI) en la colección
 * `subsidized_members`. Si cada pantalla resuelve el carnet de forma
 * distinta, un socio puede quedar cargado bajo una clave y buscado bajo
 * otra, y el sistema nunca lo reconoce como subvencionado.
 *
 * Devuelve `null` si el usuario cancela la vinculación o el QR está vacío.
 */
export async function resolveMemberDni(scannedText: string): Promise<string | null> {
  if (!scannedText || scannedText.trim() === "") return null;

  let rawId = "";
  try {
    rawId = parseMemberQR(scannedText).memberId;
  } catch {
    rawId = scannedText.trim();
  }
  if (!rawId) rawId = scannedText.trim();

  if (PURE_DNI_RE.test(rawId)) {
    return rawId;
  }

  const safeRawId = rawId.replace(/\//g, "-");
  const mappingRef = doc(db, "qr_mappings", safeRawId);
  const mappingSnap = await getDoc(mappingRef);

  if (mappingSnap.exists()) {
    return mappingSnap.data().dni as string;
  }

  const nuevoDni = window.prompt(
    `⚠️ CÓDIGO DESCONOCIDO DETECTADO ⚠️\n\n` +
    `Código: [ ${rawId} ]\n\n` +
    `Ingresá SOLO LOS NÚMEROS del DNI para vincular este carnet por única vez:`
  );

  if (!nuevoDni || !PURE_DNI_RE.test(nuevoDni.trim())) {
    return null;
  }

  const finalDni = nuevoDni.trim();
  await setDoc(mappingRef, { dni: finalDni, vinculadoEn: new Date() });
  return finalDni;
}
