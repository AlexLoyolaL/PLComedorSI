import { useEffect, useMemo, useState } from "react";
import { listenSalesByDate, keyFromDate, todayKey } from "../lib/sales";
import { Card } from "../ui/Card";

type Row = {
  id: string;
  ts: any;
  seller: any;
  member: { id: string };
  itemType: "MENU"|"VEGGIE";
  destination: { mode: "COMEDOR"|"VIANDA"; table: string|null };
  voided: boolean;
};

export default function Supervisor() {
  const [date, setDate] = useState<string>(todayKey());     // YYYY-MM-DD
  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    return listenSalesByDate(date, setRows);
  }, [date]);

  const csv = useMemo(() => {
    const header = ["hora","vendedor","socio","tipo","destino","mesa"];
    const lines = rows.map(r => [
      r.ts?.toDate ? r.ts.toDate().toLocaleTimeString() : "",
      r.seller?.email ?? "",
      r.member?.id ?? "",
      r.itemType,
      r.destination?.mode ?? "",
      r.destination?.table ?? ""
    ]);
    return [header, ...lines].map(a => a.join(",")).join("\n");
  }, [rows]);

  function downloadCsv() {
    const blob = new Blob([csv], {type:"text/csv;charset=utf-8"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `ventas_${date}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="grid cols-1">
      <Card title="Supervisor">
        <div style={{display:"flex", gap:12, alignItems:"center", marginBottom:12}}>
          <label style={{fontWeight:600}}>Fecha:</label>
          <input
            type="date"
            className="input"
            value={date}
            onChange={e => setDate(e.target.value)}
            style={{width:180}}
          />
          <button className="button" onClick={downloadCsv}>Exportar CSV</button>
        </div>

        <table className="table">
          <thead>
            <tr><th>Hora</th><th>Vendedor</th><th>Socio</th><th>Tipo</th><th>Destino</th><th>Mesa</th></tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} style={{opacity: r.voided ? .5 : 1}}>
                <td>{r.ts?.toDate ? r.ts.toDate().toLocaleTimeString() : ""}</td>
                <td>{r.seller?.email ?? ""}</td>
                <td>{r.member?.id ?? ""}</td>
                <td>{r.itemType}</td>
                <td>{r.destination?.mode ?? ""}</td>
                <td>{r.destination?.table ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
