import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/AppSidebar";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Sparkles, Plus, MessageSquare, Bot, Workflow } from "lucide-react";
import { toast } from "sonner";

// Esqueleto da feature de Agentes (IA / automação). A lógica de cada agente
// será definida em seguida — aqui fica a estrutura visual e a navegação.
export default function Agentes() {
  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full">
        <AppSidebar />
        <main className="flex-1 overflow-auto">
          <header className="sticky top-0 z-10 flex items-center gap-4 border-b border-border bg-background/80 backdrop-blur-sm px-6 py-3">
            <SidebarTrigger />
            <div className="flex-1">
              <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-primary" /> Agentes
              </h1>
              <p className="text-sm text-muted-foreground">
                Agentes de IA e automações inteligentes
              </p>
            </div>
            <Button onClick={() => toast.info("Em breve: criação de agentes. Defina o que o agente deve fazer.")}>
              <Plus className="mr-2 h-4 w-4" /> Novo agente
            </Button>
          </header>

          <div className="p-6 space-y-6">
            <Card className="border-dashed">
              <CardContent className="py-12 text-center">
                <div className="mx-auto mb-4 h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center">
                  <Sparkles className="h-6 w-6 text-primary" />
                </div>
                <h2 className="text-lg font-semibold">Nenhum agente configurado ainda</h2>
                <p className="text-sm text-muted-foreground max-w-md mx-auto mt-1">
                  Esta área vai hospedar seus agentes de IA / automação. Em seguida definimos
                  o que cada agente faz (gatilhos, ações e integrações).
                </p>
                <Button className="mt-4" onClick={() => toast.info("Defina o tipo de agente que deseja criar.")}>
                  <Plus className="mr-2 h-4 w-4" /> Criar primeiro agente
                </Button>
              </CardContent>
            </Card>

            {/* Tipos de agente (ideias — ajustaremos conforme você definir) */}
            <div>
              <p className="text-sm font-medium text-muted-foreground mb-2">Exemplos de agentes (a definir)</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <MessageSquare className="h-4 w-4 text-primary" /> Agente de Atendimento
                    </CardTitle>
                    <CardDescription>Responde leads/clientes automaticamente no WhatsApp.</CardDescription>
                  </CardHeader>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <Bot className="h-4 w-4 text-primary" /> Agente de Insights
                    </CardTitle>
                    <CardDescription>Analisa vendas/campanhas e sugere ações.</CardDescription>
                  </CardHeader>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <Workflow className="h-4 w-4 text-primary" /> Agente de Automação
                    </CardTitle>
                    <CardDescription>Executa fluxos quando algo acontece (ex.: nova venda).</CardDescription>
                  </CardHeader>
                </Card>
              </div>
            </div>
          </div>
        </main>
      </div>
    </SidebarProvider>
  );
}
