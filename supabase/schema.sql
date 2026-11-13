-- MOAI Inmobiliaria: estado compartido entre la app web y el conector MCP de Claude.
-- Ejecutar una vez en Supabase → SQL Editor.
create table if not exists public.moai_state (
  id         int primary key default 1 check (id = 1),
  data       jsonb not null default '{}'::jsonb,
  version    bigint not null default 0,
  updated_at timestamptz not null default now()
);

-- Fila única (versión 0 = vacía; la app la llena al abrirse por primera vez)
insert into public.moai_state (id) values (1) on conflict (id) do nothing;

-- RLS activo y sin políticas: solo la clave service_role (usada en los servidores) puede leer/escribir.
alter table public.moai_state enable row level security;

-- EduPlata (app de estudiantes, carpeta eduplata/): misma estructura, tabla propia.
create table if not exists public.eduplata_state (
  id         int primary key default 1 check (id = 1),
  data       jsonb not null default '{}'::jsonb,
  version    bigint not null default 0,
  updated_at timestamptz not null default now()
);
insert into public.eduplata_state (id) values (1) on conflict (id) do nothing;
alter table public.eduplata_state enable row level security;
