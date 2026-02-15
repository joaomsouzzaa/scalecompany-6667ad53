import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

interface SalesChartProps {
  data: { name: string; investimento: number; faturamento: number }[];
}

export function SalesChart({ data }: SalesChartProps) {
  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <h3 className="text-base font-semibold text-card-foreground mb-4">
        Investimento vs Faturamento
      </h3>
      <div className="h-[300px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data}>
            <defs>
              <linearGradient id="investGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="hsl(0, 72%, 51%)" stopOpacity={0.3} />
                <stop offset="95%" stopColor="hsl(0, 72%, 51%)" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="fatGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="hsl(152, 69%, 41%)" stopOpacity={0.3} />
                <stop offset="95%" stopColor="hsl(152, 69%, 41%)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 13%, 91%)" />
            <XAxis dataKey="name" tick={{ fontSize: 12 }} stroke="hsl(220, 9%, 46%)" />
            <YAxis tick={{ fontSize: 12 }} stroke="hsl(220, 9%, 46%)" />
            <Tooltip
              contentStyle={{
                backgroundColor: "hsl(0, 0%, 100%)",
                border: "1px solid hsl(220, 13%, 91%)",
                borderRadius: "8px",
                fontSize: "13px",
              }}
              formatter={(value: number) =>
                `R$ ${value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
              }
            />
            <Area
              type="monotone"
              dataKey="investimento"
              stroke="hsl(0, 72%, 51%)"
              fill="url(#investGrad)"
              strokeWidth={2}
              name="Investimento"
            />
            <Area
              type="monotone"
              dataKey="faturamento"
              stroke="hsl(152, 69%, 41%)"
              fill="url(#fatGrad)"
              strokeWidth={2}
              name="Faturamento"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
