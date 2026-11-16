import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { MercadoPagoConfig, Preference } from "mercadopago";

admin.initializeApp();
//const db = admin.firestore();

// 1. LEEMOS LA VARIABLE DE ENTORNO CORRECTAMENTE
const token = process.env.MP_ACCESS_TOKEN as string;
const client = new MercadoPagoConfig({ accessToken: token });
const PURE_DNI_RE = /^\d{7,8}$/;

function pureDni(value: unknown): string | null {
  const dni = String(value ?? "").trim();
  return PURE_DNI_RE.test(dni) ? dni : null;
}

// Compatibilidad para links viejos que se generaron pegando una fila completa
// (por ejemplo "14062067, APELLIDO NOMBRE, TELEFONO..."). Los links nuevos se
// validan de forma estricta y nunca deberían necesitar esta recuperación.
function canonicalDniFromExternalReference(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  const exact = pureDni(raw);
  if (exact) return exact;
  return raw.match(/^(\d{7,8})(?:\D|$)/)?.[1] ?? null;
}

// ============================================================================
// 1. FUNCIÓN PARA GENERAR EL LINK DE PAGO
// ============================================================================
export const generarLinkLote = functions.https.onCall(async (request) => {
  if (!request.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Debe iniciar sesión.");
  }

  const dni = pureDni(request.data?.dni);
  const cantidadViandas = Number(request.data?.cantidadViandas);
  const montoTotal = Number(request.data?.montoTotal);

  if (!dni) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "El DNI debe contener únicamente 7 u 8 números."
    );
  }
  if (!Number.isInteger(cantidadViandas) || cantidadViandas <= 0 || !Number.isFinite(montoTotal) || montoTotal <= 0) {
    throw new functions.https.HttpsError("invalid-argument", "Cantidad o monto inválido.");
  }

  try {
    const preference = new Preference(client);
    const response = await preference.create({
      body: {
        items: [
          {
            id: `LOTE_${cantidadViandas}`,
            title: `Abono Mensual: ${cantidadViandas} Viandas (Comedor)`,
            quantity: 1,
            unit_price: Number(montoTotal),
            currency_id: "ARS",
          },
        ],
        external_reference: dni,
        metadata: {
          cantidad_viandas: Number(cantidadViandas),
          vendedor_uid: request.auth.uid,
        },
        // 2. VOLVEMOS A PONER LA URL DE TU BACKEND PARA EL WEBHOOK
        notification_url: "https://mpwebhook-oa3n26zt7a-uc.a.run.app",
      },
    });

    return { init_point: response.init_point };
  } catch (error) {
    console.error("Error al crear preferencia:", error);
    throw new functions.https.HttpsError("internal", "Error comunicándose con MP.");
  }
});

// ============================================================================
// 2. EL WEBHOOK: VOLVEMOS AL FETCH MANUAL PERO CORREGIDO
// ============================================================================
export const mpWebhook = functions.https.onRequest(async (req, res) => {
  try {
    const paymentId = req.query.id || req.query['data.id'] || req.body?.data?.id || req.body?.id;

    if (!paymentId) {
      res.status(200).send("OK - Ignorado sin ID");
      return;
    }

    const mpResponse = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: {
        // 3. USAMOS LA VARIABLE DE ENTORNO EN EL FETCH
        Authorization: `Bearer ${token}`,
      }
    });
    
    if (!mpResponse.ok) {
      console.error(`Error consultando pago ${paymentId}. Status: ${mpResponse.status}`);
      res.status(200).send("OK - No se pudo validar en MP");
      return;
    }

    const paymentData = await mpResponse.json();

    if (paymentData.status === "approved") {
      const db = admin.firestore();

      // --- BLINDAJE DE IDEMPOTENCIA ---
      // Mercado Pago puede reenviar la notificación de un mismo pago más de
      // una vez (reintentos, reconciliación, notificaciones duplicadas). Sin
      // este control, cada reenvío volvía a pisar la fecha del pago con la
      // fecha "de hoy" y volvía a FIJAR (no sumar) el lote completo de
      // viandas, borrando el consumo que el socio ya había hecho de ese lote.
      // Si ya procesamos este paymentId como aprobado, no hacemos nada más.
      const rawExternalReference = String(paymentData.external_reference ?? "").trim();
      const dni = canonicalDniFromExternalReference(rawExternalReference);
      if (!dni) {
        console.error(`Pago ${paymentId} aprobado con external_reference inválida:`, rawExternalReference);
        res.status(200).send("OK - Referencia inválida");
        return;
      }
      if (dni !== rawExternalReference) {
        console.warn(`Pago ${paymentId}: DNI normalizado de una referencia heredada a ${dni}.`);
      }

      const bundleRef = db.collection("bundle_sales").doc(String(paymentId));
      const bundleSnap = await bundleRef.get();
      if (bundleSnap.exists && (bundleSnap.data() as any)?.estado === "approved") {
        console.log(`⏭️ Pago ${paymentId} ya estaba procesado. Notificación repetida, se ignora.`);
        res.status(200).send("OK - Ya procesado");
        return;
      }

      const cantidadViandas = paymentData.metadata?.cantidad_viandas || 0;
      const montoTotal = paymentData.transaction_amount;

      const hoy = new Date();
      const vencimiento = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0, 23, 59, 59);

      const memberRef = db.collection("members").doc(dni);
      const memberSnap = await memberRef.get();

      if (!memberSnap.exists) {
        await memberRef.set({
          id: dni,
          name: `Socio Nuevo (Creado por MP)`,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          active: true
        });
      }

      await memberRef.set({
        active_bundle: {
          remaining: Number(cantidadViandas),
          expiresAt: admin.firestore.Timestamp.fromDate(vencimiento),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }
      }, { merge: true });

      await bundleRef.set({
        dni: dni,
        cantidad: Number(cantidadViandas),
        monto: montoTotal,
        fecha: admin.firestore.FieldValue.serverTimestamp(),
        dateKey: `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}-${String(hoy.getDate()).padStart(2, '0')}`,
        estado: "approved"
      });
      
      console.log(`✅ CIRCUITO COMPLETO: Socio ${dni} actualizado con ${cantidadViandas} viandas.`);
    }

    res.status(200).send("OK");

  } catch (error) {
    console.error("Error crítico en Webhook:", error);
    res.status(500).send("Error interno");
  }
});

// ============================================================================
// 3. REPARACIÓN CONTROLADA DE LOTES CREADOS CON UNA CLAVE DE SOCIO INVÁLIDA
// ============================================================================
export const repararLoteDni = functions.https.onCall(async (request) => {
  if (!request.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Debe iniciar sesión.");
  }

  const canonicalDni = pureDni(request.data?.dni);
  const legacyMemberId = String(request.data?.legacyMemberId ?? "").trim();
  if (!canonicalDni || !legacyMemberId || legacyMemberId === canonicalDni) {
    throw new functions.https.HttpsError("invalid-argument", "Datos de reparación inválidos.");
  }
  if (canonicalDniFromExternalReference(legacyMemberId) !== canonicalDni) {
    throw new functions.https.HttpsError("invalid-argument", "La clave anterior no corresponde al DNI indicado.");
  }

  const db = admin.firestore();
  const rolesSnap = await db.doc("app/roles").get();
  const roles = rolesSnap.data() ?? {};
  const uid = request.auth.uid;
  const canRepair = roles.root?.[uid] === true
    || roles.administradores?.[uid] === true
    || roles.administrativos?.[uid] === true;
  if (!canRepair) {
    throw new functions.https.HttpsError("permission-denied", "No tiene permisos para reparar lotes.");
  }

  const legacyRef = db.collection("members").doc(legacyMemberId);
  const canonicalRef = db.collection("members").doc(canonicalDni);
  let transferredRemaining = 0;

  await db.runTransaction(async (tx) => {
    const [legacySnap, canonicalSnap] = await Promise.all([
      tx.get(legacyRef),
      tx.get(canonicalRef),
    ]);
    if (!legacySnap.exists) {
      throw new functions.https.HttpsError("not-found", "No se encontró el lote mal asociado.");
    }

    const legacyData = legacySnap.data() ?? {};
    const legacyBundle = legacyData.active_bundle;
    transferredRemaining = Number(legacyBundle?.remaining ?? 0);
    if (!legacyBundle || transferredRemaining <= 0) {
      throw new functions.https.HttpsError("failed-precondition", "El registro anterior no tiene viandas disponibles.");
    }

    const canonicalData = canonicalSnap.data() ?? {};
    const currentBundle = canonicalData.active_bundle;
    const currentExpiresAt = currentBundle?.expiresAt?.toDate?.() as Date | undefined;
    const currentBundleIsActive = Number(currentBundle?.remaining ?? 0) > 0
      && (!currentExpiresAt || currentExpiresAt > new Date());
    if (currentBundleIsActive) {
      throw new functions.https.HttpsError(
        "already-exists",
        "El DNI correcto ya tiene otro lote activo; no se sobrescribió."
      );
    }

    tx.set(canonicalRef, {
      id: canonicalDni,
      ...(!canonicalSnap.exists ? {
        name: "Socio Nuevo (Creado por MP)",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        active: true,
      } : {}),
      active_bundle: {
        ...legacyBundle,
        repairedAt: admin.firestore.FieldValue.serverTimestamp(),
        repairedFrom: legacyMemberId,
      },
    }, { merge: true });

    tx.set(legacyRef, {
      active_bundle: {
        ...legacyBundle,
        remaining: 0,
        migratedTo: canonicalDni,
        migratedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
    }, { merge: true });
  });

  // Corrige también la referencia del comprobante, conservando la clave previa
  // para auditoría. El documento del socio anterior no se borra.
  const salesSnap = await db.collection("bundle_sales").where("dni", "==", legacyMemberId).get();
  if (!salesSnap.empty) {
    const batch = db.batch();
    salesSnap.docs.forEach((sale) => {
      batch.set(sale.ref, {
        dni: canonicalDni,
        legacyDni: legacyMemberId,
        repairedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    });
    await batch.commit();
  }

  return { dni: canonicalDni, remaining: transferredRemaining };
});
