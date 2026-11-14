/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * MOAI Inmobiliaria - Conector MCP de Claude servido por la misma app (ruta /mcp).
 *
 * Los socios usan el link secreto de la empresa: https://<app>/mcp?key=<MCP_KEY>
 * (MCP_KEY es una variable de entorno en Render). Es el equivalente en TypeScript de
 * mcp_server/server.py (Prefect Horizon): mismas herramientas y formato de datos.
 */

import type { Express, Request, Response } from 'express';
import crypto from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

type Stored = { data: any; version: number };
export interface McpStore {
  readState: () => Promise<Stored>;
  writeState: (data: any, baseVersion: number) => Promise<number | null>;
}

// ───────────────────────────── Catálogos ─────────────────────────────
const INCOME_CATEGORIES: Record<string, string> = {
  comision_arriendos: 'Comisión Administración Arriendos',
  comision_ventas: 'Comisión por Venta de Inmuebles',
  recaudo_canon: 'Recaudo Canon de Arrendamiento (terceros)',
  servicio_reformas: 'Servicios MOAI Reformas',
  mantenimiento_locativo: 'Mantenimiento y Reparaciones Locativas',
  mudanzas_logistica: 'Servicio MOAI Mudanzas',
  asesorias_legales: 'Asesorías Jurídicas y Avalúos',
  anticipo_canones: 'Rendimiento Anticipo de Cánones',
  otros_ingresos: 'Otros Ingresos'
};
const EXPENSE_CATEGORIES: Record<string, string> = {
  dispersion_propietarios: 'Dispersión / Giro a Propietarios',
  comisiones_asesores: 'Comisiones a Asesores y Captadores',
  portales_marketing: 'Portales Inmobiliarios y Pauta',
  polizas_fianzas: 'Pólizas Colectivas y Fianzas',
  mantenimientos_inmuebles: 'Mantenimiento de Inmuebles (pago a técnicos)',
  administracion_ph: 'Administración de Edificios (PH)',
  oficina_servicios: 'Oficina Medellín y Servicios',
  nomina_seguridad_social: 'Nómina y Seguridad Social',
  software_tecnologia: 'Software y Tecnología',
  impuestos_tributario: 'Impuestos, ICA, IVA, Retefuente',
  honorarios_profesionales: 'Honorarios Contador / Abogados',
  otros_gastos: 'Gastos Varios'
};
const CUSTODY = new Set(['recaudo_canon', 'dispersion_propietarios']);
const CategoryId = z.enum([...Object.keys(INCOME_CATEGORIES), ...Object.keys(EXPENSE_CATEGORIES)] as [string, ...string[]]);
const EventType = z.enum([
  'cobro_canon',
  'dispersion_propietario',
  'pago_poliza',
  'pago_administracion',
  'nomina_comision',
  'impuesto_dian_ica',
  'servicio_general'
]);
const Fondo = z.enum(['moai_operativa', 'custodia_propietarios']);
const Fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato AAAA-MM-DD');

const INSTRUCTIONS =
  "Conector contable de MOAI Inmobiliaria (Medellín, Colombia). Montos en pesos colombianos (COP) como enteros. 'Canon' = arriendo; " +
  "'dispersión' = giro neto al propietario. Separa siempre la caja propia de MOAI (moai_operativa) del fondo de custodia de propietarios " +
  '(custodia_propietarios): el recaudo de canon y la dispersión van a custodia; comisiones y gastos operativos van a moai_operativa. ' +
  'Antes de registrar, confirma con el usuario los datos dudosos y usa listar_inmuebles para encontrar el código correcto del inmueble.';

// ───────────────────────────── Utilidades ─────────────────────────────
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
const plusDays = (iso: string, days: number) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};
const nowMs = () => Date.now();
const newId = (prefix: string) => `${prefix}-${nowMs()}-${Math.floor(1000 + Math.random() * 9000)}`;
const cop = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(Math.round(n)).toLocaleString('es-CO').replace(/,/g, '.')}`;
const compact = <T extends Record<string, any>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as T;

function balances(txs: any[]) {
  const out = { caja_moai: 0, custodia_propietarios: 0 };
  for (const t of txs) {
    const sign = t.type === 'income' ? 1 : -1;
    out[t.fundType === 'moai_operativa' ? 'caja_moai' : 'custodia_propietarios'] += sign * Number(t.amount || 0);
  }
  return out;
}

function findProperty(data: any, code: string) {
  const c = code.trim().toLowerCase();
  const props: any[] = data.properties || [];
  const exact = props.find(p => String(p.code || '').toLowerCase() === c || String(p.id || '').toLowerCase() === c);
  if (exact) return exact;
  const matches = props.filter(p => String(p.code || '').toLowerCase().includes(c) || String(p.title || '').toLowerCase().includes(c));
  return matches.length === 1 ? matches[0] : null;
}

const makeTx = (kw: Record<string, any>) => compact({ id: newId('tx-mcp'), createdAt: nowMs(), ...kw });

const ok = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: (Array.isArray(value) ? { result: value } : value) as Record<string, unknown>
});

class ToolError extends Error {}

// ───────────────────────────── Servidor por petición ─────────────────────────────
function buildServer(store: McpStore, authorized: () => void) {
  const normalize = (data: any) => {
    const d = data && typeof data === 'object' ? data : {};
    for (const k of ['transactions', 'properties', 'scheduledPayments', 'partners']) if (!Array.isArray(d[k])) d[k] = [];
    return d;
  };

  async function read() {
    authorized();
    return normalize((await store.readState()).data);
  }

  async function mutate<T>(fn: (data: any) => T): Promise<T> {
    authorized();
    for (let i = 0; i < 6; i++) {
      const { data, version } = await store.readState();
      const d = normalize(data);
      const result = fn(d);
      if ((await store.writeState(d, version)) !== null) return result;
      await new Promise(r => setTimeout(r, 200 + Math.random() * 500));
    }
    throw new ToolError('No se pudo guardar: la base de datos está muy ocupada. Intenta de nuevo.');
  }

  const server = new McpServer({ name: 'MOAI Inmobiliaria', version: '1.0.0' }, { instructions: INSTRUCTIONS });
  const tool = (name: string, config: any, handler: (args: any) => Promise<unknown>) =>
    server.registerTool(name, config, (async (args: any) => {
      try {
        return ok(await handler(args ?? {}));
      } catch (err: any) {
        if (!(err instanceof ToolError)) console.error(`[MOAI MCP] ${name}:`, err);
        return {
          isError: true,
          content: [{ type: 'text' as const, text: err instanceof ToolError ? err.message : 'Error interno del conector. Intenta de nuevo.' }]
        };
      }
    }) as any);
  const RO = { readOnlyHint: true };

  // ── Lectura ──
  tool(
    'resumen_financiero',
    {
      description: 'Saldos de Caja MOAI y Fondo de Custodia, ingresos/gastos del mes por categoría y próximos pagos (15 días).',
      inputSchema: { mes: z.string().regex(/^\d{4}-\d{2}$/).optional().describe('Mes a resumir en formato AAAA-MM. Por defecto el mes actual.') },
      annotations: RO
    },
    async ({ mes }) => {
      const data = await read();
      const txs: any[] = data.transactions;
      const month = mes || today().slice(0, 7);
      const delMes = txs.filter(t => String(t.date || '').startsWith(month));
      const porCategoria: Record<string, number> = {};
      let ingresos = 0;
      let gastos = 0;
      for (const t of delMes) {
        const cat = t.category || 'otros';
        porCategoria[cat] = (porCategoria[cat] || 0) + Number(t.amount || 0);
        if (t.fundType === 'moai_operativa') {
          if (t.type === 'income') ingresos += Number(t.amount);
          else gastos += Number(t.amount);
        }
      }
      const hoy = today();
      const limite = plusDays(hoy, 15);
      const proximos = data.scheduledPayments
        .filter((p: any) => p.status === 'pendiente' && String(p.dueDate || '') <= limite)
        .sort((a: any, b: any) => String(a.dueDate).localeCompare(String(b.dueDate)));
      return {
        saldos_totales: balances(txs),
        mes: month,
        caja_moai_mes: { ingresos, gastos, utilidad: ingresos - gastos },
        movimientos_mes: delMes.length,
        totales_por_categoria_mes: porCategoria,
        pagos_proximos_15_dias: proximos.map((p: any) => ({
          id: p.id,
          title: p.title,
          amount: p.amount,
          dueDate: p.dueDate,
          eventType: p.eventType,
          beneficiary: p.beneficiary,
          propertyCode: p.propertyCode,
          vencido: String(p.dueDate || '') < hoy
        })),
        inmuebles: data.properties.length
      };
    }
  );

  tool(
    'listar_movimientos',
    {
      description: 'Lista movimientos contables del libro diario, del más reciente al más antiguo.',
      inputSchema: {
        desde: Fecha.optional(),
        hasta: Fecha.optional(),
        tipo: z.enum(['ingreso', 'gasto']).optional(),
        categoria: CategoryId.optional(),
        inmueble_codigo: z.string().optional().describe('Filtrar por código de inmueble'),
        buscar: z.string().optional().describe('Texto a buscar en descripción o tercero'),
        limite: z.number().int().min(1).max(500).default(50)
      },
      annotations: RO
    },
    async ({ desde, hasta, tipo, categoria, inmueble_codigo, buscar, limite = 50 }) => {
      const data = await read();
      return data.transactions
        .slice()
        .sort((a: any, b: any) => String(b.date).localeCompare(String(a.date)) || (b.createdAt || 0) - (a.createdAt || 0))
        .filter((t: any) => !desde || t.date >= desde)
        .filter((t: any) => !hasta || t.date <= hasta)
        .filter((t: any) => !tipo || t.type === (tipo === 'ingreso' ? 'income' : 'expense'))
        .filter((t: any) => !categoria || t.category === categoria)
        .filter((t: any) => !inmueble_codigo || String(t.propertyCode || '').toLowerCase().includes(inmueble_codigo.toLowerCase()))
        .filter((t: any) => !buscar || `${t.description || ''} ${t.recipientOrPayer || ''}`.toLowerCase().includes(buscar.toLowerCase()))
        .slice(0, limite);
    }
  );

  tool(
    'listar_inmuebles',
    {
      description: 'Lista la cartera de inmuebles administrados con propietario, inquilino y canon.',
      inputSchema: {
        buscar: z.string().optional().describe('Texto en código, título, barrio, propietario o inquilino'),
        estado: z.enum(['arrendado', 'disponible', 'en_venta', 'en_reforma']).optional()
      },
      annotations: RO
    },
    async ({ buscar, estado }) => {
      const data = await read();
      return data.properties.filter((p: any) => {
        const text = ['code', 'title', 'neighborhood', 'ownerName', 'tenantName'].map(k => String(p[k] || '')).join(' ').toLowerCase();
        return (!buscar || text.includes(buscar.toLowerCase())) && (!estado || p.status === estado);
      });
    }
  );

  tool(
    'listar_pagos_programados',
    {
      description: 'Lista los pagos y cobros programados del calendario, ordenados por fecha de vencimiento.',
      inputSchema: { estado: z.enum(['pendiente', 'ejecutado', 'vencido']).optional().default('pendiente') },
      annotations: RO
    },
    async ({ estado = 'pendiente' }) => {
      const data = await read();
      return data.scheduledPayments
        .filter((p: any) => !estado || p.status === estado)
        .sort((a: any, b: any) => String(a.dueDate).localeCompare(String(b.dueDate)));
    }
  );

  tool(
    'listar_categorias',
    { description: 'Catálogo de categorías contables (id → nombre) para ingresos y gastos.', annotations: RO },
    async () => ({ ingresos: INCOME_CATEGORIES, gastos: EXPENSE_CATEGORIES })
  );

  // ── Escritura ──
  tool(
    'registrar_movimiento',
    {
      description: 'Registra un ingreso o egreso real en el libro diario de MOAI.',
      inputSchema: {
        tipo: z.enum(['ingreso', 'gasto']).describe('Ingreso o egreso'),
        monto: z.number().int().positive().describe('Monto en COP, entero (ej: 2600000)'),
        categoria: CategoryId.describe('Categoría contable (ver listar_categorias)'),
        descripcion: z.string().describe('Concepto del movimiento'),
        fecha: Fecha.optional().describe('AAAA-MM-DD; por defecto hoy (Bogotá)'),
        tipo_fondo: Fondo.optional().describe('Si se omite se deduce de la categoría'),
        inmueble_codigo: z.string().optional().describe('Código del inmueble, ej: MOAI-APT-402'),
        tercero: z.string().optional().describe('Propietario, inquilino, proveedor o asesor'),
        comprobante: z.string().optional().describe('Número de comprobante o factura')
      }
    },
    async ({ tipo, monto, categoria, descripcion, fecha, tipo_fondo, inmueble_codigo, tercero, comprobante }) => {
      const tx = await mutate(data => {
        const prop = inmueble_codigo ? findProperty(data, inmueble_codigo) : null;
        const tx = makeTx({
          type: tipo === 'ingreso' ? 'income' : 'expense',
          fundType: tipo_fondo || (CUSTODY.has(categoria) ? 'custodia_propietarios' : 'moai_operativa'),
          amount: monto,
          category: categoria,
          date: fecha || today(),
          description: descripcion,
          propertyId: prop?.id,
          propertyCode: prop?.code ?? inmueble_codigo,
          recipientOrPayer: tercero,
          referenceNumber: comprobante || `MCP-${String(nowMs()).slice(-5)}`
        });
        data.transactions.unshift(tx);
        return tx;
      });
      return { ok: true, mensaje: `${tipo.charAt(0).toUpperCase() + tipo.slice(1)} de ${cop(monto)} registrado.`, movimiento: tx };
    }
  );

  tool(
    'eliminar_movimiento',
    {
      description: 'Elimina un movimiento del libro diario. Confirma con el usuario antes de usarla.',
      inputSchema: { id: z.string().describe('id del movimiento (ver listar_movimientos)') },
      annotations: { destructiveHint: true }
    },
    async ({ id }) => {
      const removed = await mutate(data => {
        const i = data.transactions.findIndex((t: any) => t.id === id);
        return i >= 0 ? data.transactions.splice(i, 1)[0] : null;
      });
      return removed ? { ok: true, eliminado: removed } : { ok: false, error: `No existe el movimiento ${id}.` };
    }
  );

  tool(
    'guardar_inmueble',
    {
      description: 'Crea un inmueble nuevo o actualiza uno existente (solo cambia los campos enviados).',
      inputSchema: {
        codigo: z.string().describe('Código único, ej: MOAI-APT-402. Si ya existe, se actualiza.'),
        titulo: z.string().optional().describe('Ej: Apto 402 Edificio Laureles Real'),
        direccion: z.string().optional(),
        barrio: z.string().optional(),
        ciudad: z.string().optional(),
        tipo: z.enum(['apartamento', 'casa', 'local', 'oficina', 'bodega', 'lote']).optional(),
        estado: z.enum(['arrendado', 'disponible', 'en_venta', 'en_reforma']).optional(),
        canon_mensual: z.number().int().min(0).optional(),
        cuota_administracion: z.number().int().min(0).optional().describe('Cuota PH en COP'),
        porcentaje_comision: z.number().min(0).max(100).optional(),
        iva_sobre_comision: z.boolean().optional(),
        propietario: z.string().optional(),
        propietario_documento: z.string().optional(),
        propietario_banco: z.string().optional(),
        propietario_tipo_cuenta: z.enum(['ahorros', 'corriente']).optional(),
        propietario_numero_cuenta: z.string().optional(),
        propietario_email: z.string().optional(),
        propietario_telefono: z.string().optional(),
        inquilino: z.string().optional(),
        inquilino_documento: z.string().optional(),
        inquilino_telefono: z.string().optional(),
        dia_pago: z.number().int().min(1).max(31).optional().describe('Día del mes en que vence el canon'),
        aseguradora: z.enum(['El Libertador', 'Unifianza', 'FianzaCrédito', 'Sura', 'Directa', 'Ninguna']).optional(),
        numero_poliza: z.string().optional()
      }
    },
    async a => {
      const fields: Record<string, any> = compact({
        title: a.titulo,
        address: a.direccion,
        neighborhood: a.barrio,
        city: a.ciudad,
        type: a.tipo,
        status: a.estado,
        monthlyRent: a.canon_mensual,
        adminFee: a.cuota_administracion,
        commissionRate: a.porcentaje_comision,
        ivaOnCommission: a.iva_sobre_comision,
        ownerName: a.propietario,
        ownerDocument: a.propietario_documento,
        ownerBank: a.propietario_banco,
        ownerAccountType: a.propietario_tipo_cuenta,
        ownerAccountNumber: a.propietario_numero_cuenta,
        ownerEmail: a.propietario_email,
        ownerPhone: a.propietario_telefono,
        tenantName: a.inquilino,
        tenantDocument: a.inquilino_documento,
        tenantPhone: a.inquilino_telefono,
        paymentDueDay: a.dia_pago,
        insuranceCompany: a.aseguradora,
        policyNumber: a.numero_poliza
      });
      const codigo = String(a.codigo).trim();
      const { accion, prop } = await mutate(data => {
        const existing = data.properties.find((p: any) => String(p.code || '').toLowerCase() === codigo.toLowerCase());
        if (existing) {
          Object.assign(existing, fields);
          return { accion: 'actualizado', prop: existing };
        }
        const prop = {
          id: newId('prop'),
          code: codigo,
          title: codigo,
          address: '',
          neighborhood: '',
          city: 'Medellín',
          type: 'apartamento',
          status: 'disponible',
          monthlyRent: 0,
          adminFee: 0,
          commissionRate: data.companyProfile?.defaultCommissionRate ?? 10,
          ivaOnCommission: true,
          ownerName: '',
          ownerDocument: '',
          ownerBank: '',
          ownerAccountType: 'ahorros',
          ownerAccountNumber: '',
          ownerEmail: '',
          ownerPhone: '',
          paymentDueDay: 5,
          insuranceCompany: 'Ninguna',
          ...fields
        };
        data.properties.unshift(prop);
        return { accion: 'creado', prop };
      });
      return { ok: true, mensaje: `Inmueble ${prop.code} ${accion}.`, inmueble: prop };
    }
  );

  tool(
    'programar_pago',
    {
      description: 'Programa un pago o cobro futuro en el calendario de MOAI.',
      inputSchema: {
        titulo: z.string().describe('Concepto del pago o cobro'),
        monto: z.number().int().positive().describe('Monto en COP'),
        fecha_vencimiento: Fecha,
        categoria: CategoryId.describe('Categoría contable'),
        tipo_evento: EventType.default('servicio_general'),
        recurrencia: z.enum(['ninguna', 'quincenal', 'mensual', 'anual']).default('ninguna'),
        beneficiario: z.string().default('MOAI Inmobiliaria').describe('A quién se paga o a quién se cobra'),
        inmueble_codigo: z.string().optional(),
        recordatorio_dias_antes: z.number().int().min(0).max(60).default(2),
        notas: z.string().optional()
      }
    },
    async a => {
      const name = INCOME_CATEGORIES[a.categoria] || EXPENSE_CATEGORIES[a.categoria] || a.categoria;
      const sp = await mutate(data => {
        const prop = a.inmueble_codigo ? findProperty(data, a.inmueble_codigo) : null;
        const sp = compact({
          id: newId('sch-mcp'),
          title: a.titulo,
          amount: a.monto,
          category: name,
          categoryId: a.categoria,
          eventType: a.tipo_evento ?? 'servicio_general',
          dueDate: a.fecha_vencimiento,
          recurrence: a.recurrencia ?? 'ninguna',
          reminderDaysBefore: a.recordatorio_dias_antes ?? 2,
          status: 'pendiente',
          beneficiary: a.beneficiario ?? 'MOAI Inmobiliaria',
          propertyId: prop?.id,
          propertyCode: prop?.code ?? a.inmueble_codigo,
          notes: a.notas
        });
        data.scheduledPayments.unshift(sp);
        return sp;
      });
      return { ok: true, mensaje: `Programado '${a.titulo}' por ${cop(a.monto)} para ${a.fecha_vencimiento}.`, pago: sp };
    }
  );

  tool(
    'ejecutar_pago_programado',
    {
      description: 'Marca un pago programado como ejecutado y lo asienta en el libro diario. Si es recurrente, lo reprograma.',
      inputSchema: {
        id: z.string().describe('id del pago programado (ver listar_pagos_programados)'),
        fecha: Fecha.optional().describe('Fecha real del pago AAAA-MM-DD; por defecto hoy')
      }
    },
    async ({ id, fecha }) => {
      const result = await mutate(data => {
        const sp = data.scheduledPayments.find((p: any) => p.id === id);
        if (!sp) return null;
        const tx = makeTx({
          type: sp.eventType === 'cobro_canon' ? 'income' : 'expense',
          fundType: sp.eventType === 'dispersion_propietario' ? 'custodia_propietarios' : 'moai_operativa',
          amount: sp.amount,
          category: sp.categoryId || 'otros_gastos',
          date: fecha || today(),
          description: sp.title,
          propertyCode: sp.propertyCode,
          recipientOrPayer: sp.beneficiary,
          referenceNumber: `PAG-${String(nowMs()).slice(-5)}`
        });
        data.transactions.unshift(tx);
        const rec = sp.recurrence || 'ninguna';
        if (rec === 'mensual' || rec === 'anual') {
          let [y, m, d] = String(sp.dueDate).split('-').map(Number);
          if (rec === 'mensual') {
            m += 1;
            if (m > 12) {
              m = 1;
              y += 1;
            }
          } else y += 1;
          sp.dueDate = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
          sp.status = 'pendiente';
        } else if (rec === 'quincenal') {
          sp.dueDate = plusDays(sp.dueDate, 15);
          sp.status = 'pendiente';
        } else {
          sp.status = 'ejecutado';
        }
        return { movimiento: tx, pago: sp };
      });
      return result ? { ok: true, ...result } : { ok: false, error: `No existe el pago programado ${id}.` };
    }
  );

  tool(
    'liquidar_canon',
    {
      description:
        'Liquida el canon a un propietario: comisión MOAI + IVA 19%, deducciones y neto a dispersar. ' +
        'Con confirmar=true registra recaudo (custodia), comisión (caja MOAI) y dispersión (custodia).',
      inputSchema: {
        inmueble_codigo: z.string().describe('Código del inmueble a liquidar'),
        confirmar: z.boolean().default(false).describe('false = solo calcula (vista previa). true = asienta los 3 movimientos.'),
        reparaciones: z.number().int().min(0).default(0).describe('Reparaciones a descontar al propietario (COP)'),
        cuota_administracion: z.number().int().min(0).optional().describe('Si se omite, usa la cuota PH del inmueble'),
        canon: z.number().int().positive().optional().describe('Si se omite, usa el canon del inmueble'),
        fecha: Fecha.optional().describe('AAAA-MM-DD; por defecto hoy')
      }
    },
    async ({ inmueble_codigo, confirmar = false, reparaciones = 0, cuota_administracion, canon, fecha }) => {
      const compute = (data: any) => {
        const prop = findProperty(data, inmueble_codigo);
        if (!prop) throw new ToolError(`No encontré el inmueble '${inmueble_codigo}'. Usa listar_inmuebles.`);
        const gross = canon || Number(prop.monthlyRent || 0);
        const rate = Number(prop.commissionRate ?? 10);
        const commission = Math.round((gross * rate) / 100);
        const iva = prop.ivaOnCommission ?? true ? Math.round(commission * 0.19) : 0;
        const admin = cuota_administracion ?? Number(prop.adminFee || 0);
        const net = Math.max(0, gross - commission - iva - admin - reparaciones);
        return {
          prop,
          canon_bruto: gross,
          porcentaje_comision: rate,
          comision: commission,
          iva,
          total_moai: commission + iva,
          cuota_administracion: admin,
          reparaciones,
          neto_a_dispersar: net
        };
      };
      const summary = ({ prop, ...c }: any) => ({
        ...c,
        inmueble: prop.code,
        propietario: prop.ownerName,
        cuenta: `${prop.ownerBank || ''} ${prop.ownerAccountType || ''} ${prop.ownerAccountNumber || ''}`.trim()
      });

      if (!confirmar) return { vista_previa: true, ...summary(compute(await read())) };

      const result = await mutate(data => {
        const c = compute(data);
        const p = c.prop;
        const day = fecha || today();
        const suffix = String(nowMs()).slice(-4);
        const base = { date: day, propertyId: p.id, propertyCode: p.code };
        const owner = p.ownerName || '';
        const txs = [
          makeTx({
            type: 'expense',
            fundType: 'custodia_propietarios',
            amount: c.neto_a_dispersar,
            category: 'dispersion_propietarios',
            description: `Dispersión bancaria canon neto ${p.code} a ${owner}`,
            recipientOrPayer: owner,
            referenceNumber: `TRF-LIQ-${suffix}`,
            ...base
          }),
          makeTx({
            type: 'income',
            fundType: 'moai_operativa',
            amount: c.total_moai,
            category: 'comision_arriendos',
            description: `Comisión administración ${p.code} (${c.porcentaje_comision}% + IVA)`,
            recipientOrPayer: 'MOAI Inmobiliaria S.A.S.',
            referenceNumber: `COM-LIQ-${suffix}`,
            ...base
          }),
          makeTx({
            type: 'income',
            fundType: 'custodia_propietarios',
            amount: c.canon_bruto,
            category: 'recaudo_canon',
            description: `Recaudo canon ${p.code} (${owner})`,
            recipientOrPayer: owner,
            referenceNumber: `REC-LIQ-${suffix}`,
            ...base
          })
        ];
        data.transactions.unshift(...txs);
        return { ...summary(c), movimientos_ids: txs.map(t => t.id) };
      });
      return { ok: true, asentado: true, ...result };
    }
  );

  return server;
}

// ───────────────────────────── Ruta HTTP ─────────────────────────────
export function registerMcpRoute(app: Express, store: McpStore) {
  const expected = (process.env.MCP_KEY || '').trim();
  const sameKey = (given: string) => {
    if (!expected || !given) return false;
    const a = crypto.createHash('sha256').update(given).digest();
    const b = crypto.createHash('sha256').update(expected).digest();
    return crypto.timingSafeEqual(a, b);
  };

  app.post('/mcp', async (req: Request, res: Response) => {
    const q = req.query.key;
    const given = ((typeof q === 'string' ? q : '') || String(req.headers['x-moai-key'] || '')).trim();
    const authorized = () => {
      if (!expected) throw new ToolError('Conector sin configurar: falta la variable MCP_KEY en Render.');
      if (!sameKey(given)) throw new ToolError('Link del conector inválido. Pide el link vigente de MOAI a quien administra la app.');
    };
    const server = buildServer(store, authorized);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[MOAI MCP] Error:', err);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Error interno' }, id: null });
    }
  });

  const notAllowed = (req: Request, res: Response) =>
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Método no permitido.' }, id: null });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
}
