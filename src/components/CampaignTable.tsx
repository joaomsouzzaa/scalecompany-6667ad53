import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

const campaigns = [
  { name: "SP - Evento VIP Janeiro", status: "Ativa", invest: 3200, sales: 48, roas: 4.2, cpa: 66.67 },
  { name: "RJ - Lançamento Duplo", status: "Ativa", invest: 2100, sales: 32, roas: 3.8, cpa: 65.63 },
  { name: "BH - Campanha Individual", status: "Pausada", invest: 1500, sales: 18, roas: 2.9, cpa: 83.33 },
  { name: "CTB - Black Friday VIP", status: "Ativa", invest: 4800, sales: 72, roas: 5.1, cpa: 66.67 },
  { name: "SP - Remarketing Duplo", status: "Ativa", invest: 980, sales: 14, roas: 3.2, cpa: 70.0 },
];

export function CampaignTable() {
  return (
    <div className="rounded-xl border border-border bg-card shadow-sm">
      <div className="p-5 border-b border-border">
        <h3 className="text-base font-semibold text-card-foreground">
          Campanhas Ativas
        </h3>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Campanha</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Investimento</TableHead>
            <TableHead className="text-right">Vendas</TableHead>
            <TableHead className="text-right">ROAS</TableHead>
            <TableHead className="text-right">CPA</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {campaigns.map((c) => (
            <TableRow key={c.name}>
              <TableCell className="font-medium">{c.name}</TableCell>
              <TableCell>
                <Badge
                  variant={c.status === "Ativa" ? "default" : "secondary"}
                  className={c.status === "Ativa" ? "bg-[hsl(var(--success))] text-[hsl(var(--success-foreground))]" : ""}
                >
                  {c.status}
                </Badge>
              </TableCell>
              <TableCell className="text-right">
                R$ {c.invest.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </TableCell>
              <TableCell className="text-right">{c.sales}</TableCell>
              <TableCell className="text-right">{c.roas.toFixed(1)}x</TableCell>
              <TableCell className="text-right">
                R$ {c.cpa.toFixed(2)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
