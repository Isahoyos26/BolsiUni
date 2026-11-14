/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * EduPlata - Conector MCP de Claude servido por la misma app (ruta /mcp).
 *
 * Cada estudiante usa su link personal: https://<app>/mcp?key=edu_...
 */

import type { Express, Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

type Stored = { data: any; version: number };
export interface McpStore {
  readState: (userId: string) => Promise<Stored>;
  writeState: (userId: string, data: any, baseVersion: number) => Promise<number | null>;
  userIdForConnectorKey: (key: string) => Promise<string | null>;
}

// ───────────────────────────── Catálogos ─────────────────────────────
const EXPENSE_CATEGORIES: Record<string, string> = {
  comida: 'Comida (almuerzos, cafetería, tinto)',
  transporte: 'Transporte (Metro, bus, taxi, gasolina)',
  fotocopias: 'Fotocopias y útiles',
  matricula: 'Matrícula y semestre',
  ocio: 'Salidas y ocio',
  suscripciones: 'Suscripciones (Spotify, Netflix, Canva)',
  vivienda: 'Vivienda y arriendo, servicios',
  salud: 'Salud y bienestar, gimnasio',
  otros: 'Otros gastos (recargas, regalos, imprevistos)'
};
const INCOME_CATEGORIES: Record<string, string> = {
  mesada: 'Mesada familiar',
  trabajo: 'Trabajo / medio tiempo / freelance / monitoría',
  auxilio: 'Beca / auxilio (Jóvenes en Acción, Renta Joven)',
  emprendimiento: 'Emprendimiento / ventas',
  otros_ingresos: 'Otros ingresos'
};
const EXPENSE_IDS = Object.keys(EXPENSE_CATEGORIES) as [string, ...string[]];
const ALL_IDS = [...EXPENSE_IDS, ...Object.keys(INCOME_CATEGORIES)] as [string, ...string[]];
const ExpenseCat = z.enum(EXPENSE_IDS);
const CategoryId = z.enum(ALL_IDS);
const Fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato AAAA-MM-DD');

const INSTRUCTIONS =
  "Conector de finanzas personales de una estudiante universitaria en Colombia. Montos en pesos colombianos (COP) " +
  "como enteros: '20 lucas' = 20000, 'un palo' = 1000000, '15k' = 15000. Cuando la usuaria cuente un gasto o ingreso, " +
  'regístralo con registrar_movimiento eligiendo la categoría más adecuada; si falta el monto, pregunta. ' +
  'Después de registrar, cuenta el saldo nuevo en bolsillo.';

// ───────────────────────────── Utilidades ─────────────────────────────
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
const plusDays = (iso: string, days: number) => {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
};
const newId = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
const cop = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(Math.round(n)).toLocaleString('es-CO').replace(/,/g, '.')}`;
const balance = (txs: any[]) => txs.reduce((s, t) => s + Number(t.amount || 0) * (t.type === 'income' ? 1 : -1), 0);

/** Igual que JS Date.setMonth / la app: si el día no existe en el mes siguiente, se desborda. */
function nextDate(due: string, recurrence: string) {
  const [y, m, d] = due.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (recurrence === 'semanal') dt.setUTCDate(dt.getUTCDate() + 7);
  else dt.setUTCMonth(dt.getUTCMonth() + 1);
  return dt.toISOString().slice(0, 10);
}

function findGoal(data: any, meta: string) {
  const q = meta.trim().toLowerCase();
  const goals: any[] = data.goals || [];
  const exact = goals.filter(g => String(g.id).toLowerCase() === q || String(g.title || '').toLowerCase() === q);
  if (exact.length) return exact[0];
  const partial = goals.filter(g => String(g.title || '').toLowerCase().includes(q));
  return partial.length === 1 ? partial[0] : null;
}

const ok = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: (Array.isArray(value) ? { result: value } : value) as Record<string, unknown>
});

class ToolError extends Error {}

// ───────────────────────────── Servidor por petición ─────────────────────────────
function buildServer(store: McpStore, key: string | null) {
  async function userId(): Promise<string> {
    if (!key) {
      throw new ToolError(
        'Falta tu link personal. En la app EduPlata ve a Configuración → Conectar con Claude, genera tu link y úsalo como URL del conector en Claude.'
      );
    }
    const id = await store.userIdForConnectorKey(key);
    if (!id) {
      throw new ToolError(
        'Este link del conector no es válido o fue reemplazado por uno nuevo. Genera tu link en la app (Configuración → Conectar con Claude) y actualízalo en Claude.'
      );
    }
    return id;
  }

  const normalize = (data: any) => {
    const d = data && typeof data === 'object' ? data : {};
    for (const k of ['transactions', 'goals', 'scheduledPayments']) if (!Array.isArray(d[k])) d[k] = [];
    return d;
  };

  async function read() {
    const { data } = await store.readState(await userId());
    return normalize(data);
  }

  async function mutate<T>(fn: (data: any) => T): Promise<T> {
    const id = await userId();
    for (let i = 0; i < 6; i++) {
      const { data, version } = await store.readState(id);
      const d = normalize(data);
      const result = fn(d);
      if ((await store.writeState(id, d, version)) !== null) return result;
      await new Promise(r => setTimeout(r, 200 + Math.random() * 500));
    }
    throw new ToolError('No se pudo guardar: la base de datos está muy ocupada. Intenta de nuevo.');
  }

  const server = new McpServer({ name: 'EduPlata - Finanzas Universitarias', version: '1.0.0' }, { instructions: INSTRUCTIONS });

  // Envuelve cada herramienta: errores → mensaje claro para Claude
  const tool = (name: string, config: any, handler: (args: any) => Promise<unknown>) =>
    server.registerTool(name, config, (async (args: any) => {
      try {
        return ok(await handler(args ?? {}));
      } catch (err: any) {
        if (!(err instanceof ToolError)) console.error(`[EduPlata MCP] ${name}:`, err);
        return { isError: true, content: [{ type: 'text' as const, text: err instanceof ToolError ? err.message : 'Error interno del conector. Intenta de nuevo.' }] };
      }
    }) as any);

  const RO = { readOnlyHint: true };

  // ── Lectura ──
  tool(
    'resumen',
    {
      description: 'Saldo en bolsillo, ingresos y gastos del mes, gasto por categoría frente al presupuesto, metas y pagos próximos.',
      inputSchema: { mes: z.string().regex(/^\d{4}-\d{2}$/).optional().describe('Mes AAAA-MM; por defecto el actual') },
      annotations: RO
    },
    async ({ mes }) => {
      const data = await read();
      const txs: any[] = data.transactions;
      const month = mes || today().slice(0, 7);
      const delMes = txs.filter(t => String(t.date || '').startsWith(month));
      const limits = data.budget?.categoryLimits || {};
      const porCat: Record<string, { gastado: number; limite: number }> = {};
      for (const t of delMes) {
        if (t.type !== 'expense') continue;
        const c = t.category || 'otros';
        porCat[c] ??= { gastado: 0, limite: Number(limits[c] || 0) };
        porCat[c].gastado += Number(t.amount);
      }
      const limite = plusDays(today(), 15);
      const proximos = data.scheduledPayments
        .filter((p: any) => !p.isPaid && String(p.dueDate || '') <= limite)
        .sort((a: any, b: any) => String(a.dueDate).localeCompare(String(b.dueDate)));
      return {
        saldo_en_bolsillo: balance(txs),
        mes: month,
        ingresos_mes: delMes.filter(t => t.type === 'income').reduce((s, t) => s + Number(t.amount), 0),
        gastos_mes: delMes.filter(t => t.type === 'expense').reduce((s, t) => s + Number(t.amount), 0),
        presupuesto_mensual: Number(data.budget?.monthlyExpenseLimit || 0),
        gastos_por_categoria: porCat,
        metas: data.goals.map((g: any) => ({ id: g.id, meta: g.title, ahorrado: g.currentAmount, objetivo: g.targetAmount, fecha_limite: g.deadline })),
        pagos_proximos_15_dias: proximos.map((p: any) => ({ id: p.id, description: p.description, amount: p.amount, dueDate: p.dueDate, recurrence: p.recurrence }))
      };
    }
  );

  tool(
    'listar_movimientos',
    {
      description: 'Lista movimientos, del más reciente al más antiguo.',
      inputSchema: {
        desde: Fecha.optional(),
        hasta: Fecha.optional(),
        tipo: z.enum(['ingreso', 'gasto']).optional(),
        categoria: CategoryId.optional(),
        buscar: z.string().optional().describe('Texto en la nota'),
        limite: z.number().int().min(1).max(500).default(50)
      },
      annotations: RO
    },
    async ({ desde, hasta, tipo, categoria, buscar, limite = 50 }) => {
      const data = await read();
      return data.transactions
        .slice()
        .sort((a: any, b: any) => String(b.date).localeCompare(String(a.date)) || (b.createdAt || 0) - (a.createdAt || 0))
        .filter((t: any) => !desde || t.date >= desde)
        .filter((t: any) => !hasta || t.date <= hasta)
        .filter((t: any) => !tipo || t.type === (tipo === 'ingreso' ? 'income' : 'expense'))
        .filter((t: any) => !categoria || t.category === categoria)
        .filter((t: any) => !buscar || String(t.note || '').toLowerCase().includes(buscar.toLowerCase()))
        .slice(0, limite);
    }
  );

  tool(
    'listar_pagos_programados',
    {
      description: 'Lista pagos programados (por defecto solo los pendientes), ordenados por fecha.',
      inputSchema: { incluir_pagados: z.boolean().default(false) },
      annotations: RO
    },
    async ({ incluir_pagados = false }) => {
      const data = await read();
      return data.scheduledPayments
        .filter((p: any) => incluir_pagados || !p.isPaid)
        .sort((a: any, b: any) => String(a.dueDate).localeCompare(String(b.dueDate)));
    }
  );

  tool(
    'listar_categorias',
    { description: 'Catálogo de categorías (id → descripción) de gastos e ingresos.', annotations: RO },
    async () => ({ gastos: EXPENSE_CATEGORIES, ingresos: INCOME_CATEGORIES })
  );

  // ── Escritura ──
  tool(
    'registrar_movimiento',
    {
      description: 'Registra un gasto o ingreso. Aparece en la app web en unos segundos.',
      inputSchema: {
        tipo: z.enum(['ingreso', 'gasto']),
        monto: z.number().int().positive().describe('Monto en COP, entero (ej: 15000)'),
        categoria: CategoryId.describe(
          'Gastos: comida, transporte, fotocopias, matricula, ocio, suscripciones, vivienda, salud, otros. Ingresos: mesada, trabajo, auxilio, emprendimiento, otros_ingresos'
        ),
        nota: z.string().optional().describe("Descripción corta, ej: 'Almuerzo en la U'"),
        fecha: Fecha.optional().describe('AAAA-MM-DD; por defecto hoy')
      }
    },
    async ({ tipo, monto, categoria, nota, fecha }) => {
      if ((tipo === 'gasto') !== (categoria in EXPENSE_CATEGORIES)) {
        return { ok: false, error: `La categoría '${categoria}' no corresponde a un ${tipo}. Usa listar_categorias.` };
      }
      const { tx, saldo } = await mutate(data => {
        const tx = {
          id: newId('tx-claude'),
          type: tipo === 'ingreso' ? 'income' : 'expense',
          amount: monto,
          category: categoria,
          date: fecha || today(),
          note: nota || '',
          createdAt: Date.now()
        };
        data.transactions.unshift(tx);
        return { tx, saldo: balance(data.transactions) };
      });
      const label = tipo.charAt(0).toUpperCase() + tipo.slice(1);
      return { ok: true, mensaje: `${label} de ${cop(monto)} registrado. Saldo en bolsillo: ${cop(saldo)}.`, movimiento: tx, saldo_en_bolsillo: saldo };
    }
  );

  tool(
    'eliminar_movimiento',
    {
      description: 'Elimina un movimiento. Confirma con la usuaria antes.',
      inputSchema: { id: z.string().describe('id del movimiento (ver listar_movimientos)') },
      annotations: { destructiveHint: true }
    },
    async ({ id }) => {
      const removed = await mutate(data => {
        const i = data.transactions.findIndex((t: any) => t.id === id);
        return i >= 0 ? data.transactions.splice(i, 1)[0] : null;
      });
      return removed ? { ok: true, eliminado: removed } : { ok: false, error: `No existe ${id}.` };
    }
  );

  tool(
    'crear_meta_ahorro',
    {
      description: 'Crea una meta de ahorro.',
      inputSchema: {
        titulo: z.string().describe("Ej: 'Portátil nuevo'"),
        monto_objetivo: z.number().int().positive(),
        fecha_limite: Fecha,
        ahorrado_actual: z.number().int().min(0).default(0),
        emoji: z.string().default('🎯'),
        notas: z.string().optional()
      }
    },
    async ({ titulo, monto_objetivo, fecha_limite, ahorrado_actual = 0, emoji = '🎯', notas }) => {
      const meta = await mutate(data => {
        const g: any = {
          id: newId('goal-claude'),
          title: titulo,
          targetAmount: monto_objetivo,
          currentAmount: ahorrado_actual,
          deadline: fecha_limite,
          emoji,
          color: '#10b981',
          createdAt: Date.now()
        };
        if (notas) g.notes = notas;
        data.goals.push(g);
        return g;
      });
      return { ok: true, meta };
    }
  );

  tool(
    'abonar_a_meta',
    {
      description: 'Suma un abono a una meta de ahorro.',
      inputSchema: { meta: z.string().describe('Nombre o id de la meta'), monto: z.number().int().positive() }
    },
    async ({ meta, monto }) => {
      const g = await mutate(data => {
        const g = findGoal(data, meta);
        if (g) g.currentAmount = Number(g.currentAmount || 0) + monto;
        return g;
      });
      if (!g) return { ok: false, error: `No encontré una única meta '${meta}'. Revisa resumen().` };
      return { ok: true, mensaje: `Abonado ${cop(monto)} a '${g.title}': ${cop(g.currentAmount)} de ${cop(g.targetAmount)}.`, meta: g };
    }
  );

  tool(
    'programar_pago',
    {
      description: 'Programa un pago futuro (aparece en el calendario de la app).',
      inputSchema: {
        descripcion: z.string().describe("Ej: 'Arriendo pieza', 'Spotify'"),
        monto: z.number().int().positive(),
        fecha_vencimiento: Fecha,
        categoria: ExpenseCat.default('otros'),
        recurrencia: z.enum(['ninguna', 'semanal', 'mensual']).default('ninguna'),
        recordatorio_dias_antes: z.number().int().min(0).max(30).default(1)
      }
    },
    async ({ descripcion, monto, fecha_vencimiento, categoria = 'otros', recurrencia = 'ninguna', recordatorio_dias_antes = 1 }) => {
      const pago = await mutate(data => {
        const p = {
          id: newId('pay-claude'),
          description: descripcion,
          amount: monto,
          category: EXPENSE_CATEGORIES[categoria].split(' (')[0],
          categoryId: categoria,
          dueDate: fecha_vencimiento,
          recurrence: recurrencia,
          reminderDaysBefore: recordatorio_dias_antes,
          isPaid: false,
          createdAt: Date.now()
        };
        data.scheduledPayments.push(p);
        return p;
      });
      return { ok: true, pago };
    }
  );

  tool(
    'marcar_pago_hecho',
    {
      description: 'Marca un pago programado como pagado y lo registra como gasto de hoy. Si es recurrente, crea el siguiente.',
      inputSchema: { id: z.string().describe('id del pago programado') }
    },
    async ({ id }) => {
      const r = await mutate(data => {
        const p = data.scheduledPayments.find((x: any) => x.id === id);
        if (!p) return null;
        const hoy = today();
        const tx = {
          id: newId('tx-pay'),
          type: 'expense',
          amount: p.amount,
          category: p.categoryId || 'otros',
          date: hoy,
          note: `Pago: ${p.description || ''}`,
          createdAt: Date.now()
        };
        data.transactions.unshift(tx);
        if (p.recurrence === 'mensual' || p.recurrence === 'semanal') {
          const { paidAt, ...rest } = p;
          const nxt = { ...rest, id: newId('pay'), dueDate: nextDate(p.dueDate, p.recurrence), isPaid: false, createdAt: Date.now() };
          data.scheduledPayments = [...data.scheduledPayments.filter((x: any) => x.id !== id), nxt];
          return { movimiento: tx, siguiente_pago: nxt };
        }
        p.isPaid = true;
        p.paidAt = hoy;
        return { movimiento: tx, pago: p };
      });
      return r ? { ok: true, ...r } : { ok: false, error: `No existe el pago ${id}.` };
    }
  );

  tool(
    'configurar_presupuesto',
    {
      description: 'Ajusta el presupuesto mensual (solo cambia lo que se envíe).',
      inputSchema: {
        limite_gasto_mensual: z.number().int().min(0).optional(),
        meta_ingresos_mensual: z.number().int().min(0).optional(),
        limites_por_categoria: z.partialRecord(ExpenseCat, z.number().int().min(0)).optional().describe("Ej: {'comida': 400000, 'ocio': 100000}")
      }
    },
    async ({ limite_gasto_mensual, meta_ingresos_mensual, limites_por_categoria }) => {
      const presupuesto = await mutate(data => {
        const empty = Object.fromEntries(EXPENSE_IDS.map(k => [k, 0]));
        const b = data.budget || { monthlyIncomeTarget: 0, monthlyExpenseLimit: 0, categoryLimits: { ...empty } };
        b.categoryLimits ??= { ...empty };
        if (limite_gasto_mensual !== undefined) b.monthlyExpenseLimit = limite_gasto_mensual;
        if (meta_ingresos_mensual !== undefined) b.monthlyIncomeTarget = meta_ingresos_mensual;
        for (const [k, v] of Object.entries(limites_por_categoria || {})) b.categoryLimits[k] = Number(v);
        data.budget = b;
        return b;
      });
      return { ok: true, presupuesto };
    }
  );

  return server;
}

// ───────────────────────────── Ruta HTTP ─────────────────────────────
export function registerMcpRoute(app: Express, store: McpStore) {
  const keyFrom = (req: Request) => {
    const q = req.query.key;
    const raw = (typeof q === 'string' ? q : '') || String(req.headers['x-eduplata-key'] || '');
    return raw.trim() || null;
  };

  // Modo sin estado: un servidor y un transporte nuevos por cada petición
  app.post('/mcp', async (req: Request, res: Response) => {
    const server = buildServer(store, keyFrom(req));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[EduPlata MCP] Error:', err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Error interno' }, id: null });
      }
    }
  });

  const notAllowed = (req: Request, res: Response) =>
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Método no permitido.' }, id: null });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
}
