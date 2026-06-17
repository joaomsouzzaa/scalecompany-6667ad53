-- Cobrança: categorias de mensagem + categoria nos itens de disparo.
-- 'dia_vencimento' = 1 mensagem única reutilizada (contas a receber do dia).
-- 'inadimplente'   = fluxo/cadência (1, 2, 3...) com memória por telefone.

alter table public.cobranca_mensagens
  add column if not exists categoria text not null default 'inadimplente';

create index if not exists cobranca_mensagens_categoria_idx on public.cobranca_mensagens(categoria);

-- Guarda a categoria do envio para o processador saber se avança (ou não) a cadência.
-- 'dia_vencimento' NÃO avança ultima_ordem_enviada; 'inadimplente' avança.
alter table public.cobranca_disparo_itens
  add column if not exists categoria text not null default 'inadimplente';
