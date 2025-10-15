export function Card({ title, right, children }:{
  title: string; right?: React.ReactNode; children: React.ReactNode
}){
  return (
    <div className="panel">
      <div style={{display:"flex", alignItems:"center", marginBottom:8}}>
        <div className="title">{title}</div>
        <div style={{marginLeft:"auto"}}>{right}</div>
      </div>
      {children}
    </div>
  );
}
