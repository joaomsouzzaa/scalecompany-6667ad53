import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { SaleNotificationBanner } from "@/components/SaleNotificationBanner";
import Index from "./pages/Index";
import Integracoes from "./pages/Integracoes";
import VendasEventos from "./pages/VendasEventos";
import IngressosEmitidos from "./pages/IngressosEmitidos";
import CadastroCidades from "./pages/CadastroCidades";
import DashboardGeral from "./pages/DashboardGeral";
import InsideSales from "./pages/InsideSales";
import CadastroProdutos from "./pages/CadastroProdutos";
import LeadsInsideSales from "./pages/LeadsInsideSales";
import Notificacoes from "./pages/Notificacoes";
import Cobranca from "./pages/Cobranca";
import Agentes from "./pages/Agentes";
import Chat from "./pages/Chat";
import Workflow from "./pages/Workflow";
import Designer from "./pages/Designer";
import Modulos from "./pages/Modulos";
import Performance from "./pages/Performance";
import Campanhas from "./pages/Campanhas";
import NotFound from "./pages/NotFound";

// Auto-refresh: todas as queries re-buscam a cada 10 min (mesmo sem F5, e em background).
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchInterval: 10 * 60 * 1000,
      refetchIntervalInBackground: true,
      refetchOnWindowFocus: true,
      staleTime: 60 * 1000,
    },
  },
});

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <SaleNotificationBanner />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Index />} />
          <Route path="/vendas-eventos" element={<VendasEventos />} />
          <Route path="/ingressos-emitidos" element={<IngressosEmitidos />} />
          <Route path="/eventos-geral" element={<DashboardGeral />} />
          <Route path="/integracoes" element={<Integracoes />} />
          <Route path="/inside-sales" element={<InsideSales />} />
          <Route path="/leads" element={<LeadsInsideSales />} />
          <Route path="/cadastro-produtos" element={<CadastroProdutos />} />
          <Route path="/cadastro-cidades" element={<CadastroCidades />} />
          <Route path="/notificacoes" element={<Notificacoes />} />
          <Route path="/cobranca" element={<Cobranca />} />
          <Route path="/agentes" element={<Agentes />} />
          <Route path="/chat" element={<Chat />} />
          <Route path="/workflow" element={<Workflow />} />
          <Route path="/designer" element={<Designer />} />
          <Route path="/modulos" element={<Modulos />} />
          <Route path="/performance" element={<Performance />} />
          <Route path="/campanhas" element={<Campanhas />} />
          {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
