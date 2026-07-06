import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { MercadoPagoConfig, Preference } from "mercadopago";

admin.initializeApp();
//const db = admin.firestore();

// Tu token real de producción
const client = new MercadoPagoConfig({ accessToken: "MP_ACCESS_TOKEN" });

// ============================================================================
// 1. FUNCIÓN PARA GENERAR EL LINK DE PAGO
// ============================================================================
export const generarLinkLote = functions.https.onCall(async (request) => {
  if (!request.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Debe iniciar sesión.");
  }

  const { dni, cantidadViandas, montoTotal } = request.data;
  
  if (!dni || !cantidadViandas || !montoTotal) {
    throw new functions.https.HttpsError("invalid-argument", "Faltan datos.");
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
        external_reference: String(dni),
        metadata: {
          cantidad_viandas: Number(cantidadViandas), // Guardamos el número real acá
          vendedor_uid: request.auth.uid,
        },
        notification_url: "https://pl-comedor-si.vercel.app/",
       
        
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
        Authorization: `Bearer MP_ACCESS_TOKEN`,
      }
    });
    
    if (!mpResponse.ok) {
      console.error(`Error consultando pago ${paymentId}. Status: ${mpResponse.status}`);
      res.status(200).send("OK - No se pudo validar en MP");
      return;
    }

    const paymentData = await mpResponse.json();

    if (paymentData.status === "approved") {
      const dni = String(paymentData.external_reference).trim();
      const cantidadViandas = paymentData.metadata?.cantidad_viandas || 0;
      const montoTotal = paymentData.transaction_amount;

      const hoy = new Date();
      const vencimiento = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0, 23, 59, 59);

      const db = admin.firestore();
      const memberRef = db.collection("members").doc(dni);
      const memberSnap = await memberRef.get();

      // --- BLINDAJE: Si el socio no existe en la BD, lo creamos con campos base ---
      if (!memberSnap.exists) {
        await memberRef.set({
          id: dni,
          name: `Socio Nuevo (Creado por MP)`,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          active: true
        });
      }

      // --- CARGAMOS LAS VIANDAS (Ahora sí o sí existe el documento) ---
      await memberRef.set({
        active_bundle: {
          remaining: Number(cantidadViandas),
          expiresAt: admin.firestore.Timestamp.fromDate(vencimiento),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }
      }, { merge: true });

      // --- TICKET DE AUDITORÍA PARA LA TABLA ---
      await db.collection("bundle_sales").doc(String(paymentId)).set({
        dni: dni,
        cantidad: Number(cantidadViandas),
        monto: montoTotal,
        fecha: admin.firestore.FieldValue.serverTimestamp(),
        dateKey: `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}-${String(hoy.getDate()).padStart(2, '0')}`, // Inyectamos dateKey para el filtro de React
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