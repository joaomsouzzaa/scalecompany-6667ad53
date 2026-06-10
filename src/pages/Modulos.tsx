import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/AppSidebar";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { LayoutGrid, CalendarRange, Users, TrendingUp, Sparkles } from "lucide-react";
import { useModulos, setModulo, type ModuloKey } from "@/hooks/useModulos";

const MODULOS: { key: ModuloKey; nome: string; desc: string; icon: any }[] = [
  { key: "eventos", nome: "Eventos", desc: "Dashboard WS, Resumo City e Vendas", icon: CalendarRange },
  { key: "inside", nome: "Inside Sales", desc: "Dashboard Geral e Leads", icon: Users },
  { key: "analytics", nome: "Analytics", desc: "Performance e Campanhas", icon: TrendingUp },
  { key: "growth", nome: "Growth", desc: "Notificações, Agentes, Chat, Workflow e Designer", icon: Sparkles },
];

export default function Modulos() {
  const modulos = useModulos();

  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full">
        <AppSidebar />
        <main className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden">
          <header className="sticky top-0 z-10 flex items-center gap-4 border-b border-border bg-background/80 backdrop-blur-sm px-6 py-3">
            <SidebarTrigger />
            <div>
              <h1 className="text-xl font-bold tracking-tight flex items-center gap-2"><LayoutGrid className="h-5 w-5 text-primary" /> Módulos</h1>
              <p className="text-sm text-muted-foreground">Ative ou oculte os grupos do menu lateral</p>
            </div>
          </header>

          <div className="p-6 max-w-2xl space-y-3">
            {MODULOS.map((m) => (
              <Card key={m.key}>
                <CardContent className="flex items-center justify-between gap-4 py-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                      <m.icon className="h-5 w-5 text-primary" />
                    </div>
                    <div className="min-w-0">
                      <Label className="font-medium">{m.nome}</Label>
                      <p className="text-xs text-muted-foreground">{m.desc}</p>
                    </div>
                  </div>
                  <Switch checked={modulos[m.key]} onCheckedChange={(v) => setModulo(m.key, v)} />
                </CardContent>
              </Card>
            ))}
            <p className="text-xs text-muted-foreground pt-2">
              Módulos desmarcados somem do menu lateral imediatamente. Você pode reativá-los aqui a qualquer momento.
            </p>
          </div>
        </main>
      </div>
    </SidebarProvider>
  );
}
