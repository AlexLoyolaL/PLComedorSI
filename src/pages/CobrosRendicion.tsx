import { useEffect, useMemo, useState } from "react";
import type { AdministrativePayment } from "../lib/administrativePayments";
import { administrativeTodayKey, listenAdministrativePayments } from "../lib/administrativePayments";
import {
  createAdministrativeClosure,
  listenAdministrativeClosure,
} from "../lib/administrativeClosures";
import type { AdministrativeClosure } from "../lib/administrativeClosures";
import { CENTER_LABELS, centerConceptLabel } from "../lib/centers";
import type { CenterId } from "../lib/centers";
import { useAuth } from "../state/AuthContext";
import { Card } from "../ui/Card";

function money(value: number) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0,
  }).format(value);
}

function dateTime(value: AdministrativeClosure["closedAt"]) {
  const date = value instanceof Date ? value : value?.toDate() ?? null;
  return date ? new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "short" }).format(date) : "—";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export default function CobrosRendicion({ centerId, canClose }: { centerId: CenterId; canClose: boolean }) {
  const { user } = useAuth();
  const [dateKey, setDateKey] = useState(administrativeTodayKey());
  const [payments, setPayments] = useState<AdministrativePayment[]>([]);
  const [closure, setClosure] = useState<AdministrativeClosure | null>(null);
  const [countedCash, setCountedCash] = useState("");
  const [countedVirtual, setCountedVirtual] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    setPayments([]);
    return listenAdministrativePayments({ centerId, dateKey, setter: setPayments });
  }, [centerId, dateKey]);

  useEffect(() => {
    setClosure(null);
    return listenAdministrativeClosure(centerId, dateKey, setClosure);
  }, [centerId, dateKey]);

  useEffect(() => {
    setCountedCash("");
    setCountedVirtual("");
    setNotes("");
    setMessage("");
  }, [centerId, dateKey]);

  const activePayments = useMemo(() => payments.filter((payment) => payment.status !== "VOID"), [payments]);
  const expected = useMemo(() => {
    const cash = activePayments.filter((payment) => payment.paymentMethod === "EFECTIVO")
      .reduce((sum, payment) => sum + Number(payment.totalAmount || 0), 0);
    const virtual = activePayments.filter((payment) => payment.paymentMethod === "MP")
      .reduce((sum, payment) => sum + Number(payment.totalAmount || 0), 0);
    return { cash, virtual, total: cash + virtual };
  }, [activePayments]);

  const byConcept = useMemo(() => {
    const result: Record<string, { count: number; cash: number; virtual: number; total: number }> = {};
    activePayments.forEach((payment) => payment.items.forEach((item) => {
      const current = result[item.concept] ?? { count: 0, cash: 0, virtual: 0, total: 0 };
      current.count += 1;
      current.total += item.amount;
      if (payment.paymentMethod === "EFECTIVO") current.cash += item.amount;
      else current.virtual += item.amount;
      result[item.concept] = current;
    }));
    return result;
  }, [activePayments]);

  const counted = {
    cash: Number(countedCash || 0),
    virtual: Number(countedVirtual || 0),
    total: Number(countedCash || 0) + Number(countedVirtual || 0),
  };
  const difference = {
    cash: counted.cash - expected.cash,
    virtual: counted.virtual - expected.virtual,
    total: counted.total - expected.total,
  };

  async function closeCash() {
    if (countedCash === "" || countedVirtual === "") {
      setMessage("Ingresá los importes efectivamente contabilizados en efectivo y pago virtual.");
      return;
    }
    setSaving(true);
    setMessage("");
    try {
      await createAdministrativeClosure({
        centerId,
        dateKey,
        paymentsCount: activePayments.length,
        expected,
        counted,
        difference,
        byConcept: Object.fromEntries(Object.entries(byConcept).map(([concept, value]) => [concept, {
          count: value.count,
          amount: value.total,
        }])),
        notes: notes.trim(),
        closedBy: { uid: user?.uid ?? "", email: user?.email ?? "", name: user?.displayName ?? "" },
      });
      setMessage("✅ Rendición cerrada y guardada para auditoría.");
    } catch (error: unknown) {
      setMessage(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return <div className="cobros-rendicion">
    <div className="cobros-rendicion-toolbar">
      <label><span>Fecha de rendición</span><input type="date" className="input" value={dateKey} onChange={(event) => setDateKey(event.target.value)} /></label>
      <div className="badge">{CENTER_LABELS[centerId]}</div>
    </div>

    <div className="cobros-summary">
      <div className="socios-stat"><span>Comprobantes vigentes</span><strong>{activePayments.length}</strong></div>
      <div className="socios-stat ok"><span>Total esperado</span><strong>{money(expected.total)}</strong></div>
      <div className="socios-stat"><span>Efectivo esperado</span><strong>{money(expected.cash)}</strong></div>
      <div className="socios-stat info"><span>Pago virtual esperado</span><strong>{money(expected.virtual)}</strong></div>
    </div>

    <Card title="Detalle por concepto">
      {Object.keys(byConcept).length === 0 ? <div className="socios-muted-box">No hay cuotas ni servicios vigentes para esta fecha y sede.</div> : <div className="cobros-table-wrap"><table className="table">
        <thead><tr><th>Concepto</th><th>Operaciones</th><th>Efectivo</th><th>Pago virtual</th><th>Total</th></tr></thead>
        <tbody>{Object.entries(byConcept).map(([concept, value]) => <tr key={concept}><td>{centerConceptLabel(centerId, concept as AdministrativePayment["items"][number]["concept"])}</td><td>{value.count}</td><td>{money(value.cash)}</td><td>{money(value.virtual)}</td><td><strong>{money(value.total)}</strong></td></tr>)}</tbody>
      </table></div>}
    </Card>

    {closure ? <Card title="Rendición cerrada">
      <div className="cobros-closure-banner"><strong>Cierre registrado el {dateTime(closure.closedAt)}</strong><span>{closure.closedBy.email || closure.closedBy.name}</span></div>
      <div className="socios-detail-grid">
        <div className="socios-detail-item"><span>Efectivo contado</span><strong>{money(closure.counted.cash)}</strong></div>
        <div className="socios-detail-item"><span>Diferencia efectivo</span><strong>{money(closure.difference.cash)}</strong></div>
        <div className="socios-detail-item"><span>Virtual contabilizado</span><strong>{money(closure.counted.virtual)}</strong></div>
        <div className="socios-detail-item"><span>Diferencia virtual</span><strong>{money(closure.difference.virtual)}</strong></div>
        <div className="socios-detail-item"><span>Total rendido</span><strong>{money(closure.counted.total)}</strong></div>
        <div className="socios-detail-item"><span>Diferencia total</span><strong>{money(closure.difference.total)}</strong></div>
      </div>
      {closure.notes && <div className="socios-muted-box">{closure.notes}</div>}
    </Card> : <Card title="Cerrar rendición">
      <div className="cobros-rendicion-form">
        <div className="cobros-two-cols">
          <label><span>Efectivo contado</span><input type="number" min="0" step="0.01" className="input" value={countedCash} placeholder={String(expected.cash)} onChange={(event) => setCountedCash(event.target.value)} /></label>
          <label><span>Pago virtual contabilizado</span><input type="number" min="0" step="0.01" className="input" value={countedVirtual} placeholder={String(expected.virtual)} onChange={(event) => setCountedVirtual(event.target.value)} /></label>
        </div>
        <div className="cobros-differences"><span>Diferencia efectivo: <strong>{money(difference.cash)}</strong></span><span>Diferencia virtual: <strong>{money(difference.virtual)}</strong></span><span>Diferencia total: <strong>{money(difference.total)}</strong></span></div>
        <label><span>Observaciones</span><textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
        {message && <div className={`socios-message ${message.startsWith("✅") ? "success" : "error"}`}>{message}</div>}
        <button className="button" onClick={() => void closeCash()} disabled={!canClose || saving}>{saving ? "Guardando..." : "Cerrar rendición"}</button>
      </div>
    </Card>}
  </div>;
}
