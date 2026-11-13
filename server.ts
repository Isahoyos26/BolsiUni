/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * MOAI Inmobiliaria - Servidor Backend Express & Proxy Claude (Anthropic)
 * Gestión contable para inmobiliaria en Medellín (Colombia):
 * Cánones de arrendamiento, comisiones, dispersiones a propietarios y pagos programados.
 */

import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper para fecha y día de la semana en Colombia (America/Bogota)
function getBogotaDateTime() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long'
  });

  const parts = formatter.formatToParts(now);
  let year = '', month = '', day = '', weekday = '';
  for (const part of parts) {
    if (part.type === 'year') year = part.value;
    if (part.type === 'month') month = part.value;
    if (part.type === 'day') day = part.value;
    if (part.type === 'weekday') weekday = part.value;
  }
  const todayDate = `${year}-${month}-${day}`;
  const dayOfWeek = weekday ? weekday.charAt(0).toUpperCase() + weekday.slice(1) : 'Hoy';
  return { todayDate, dayOfWeek };
}

// Herramientas estructuradas para Claude enfocadas en MOAI Inmobiliaria
const CLAUDE_REAL_ESTATE_TOOLS = [
  {
    name: 'registrar_movimiento',
    description: 'Registra un ingreso o egreso real de la inmobiliaria o del fondo de recaudos.',
    input_schema: {
      type: 'object',
      properties: {
        tipo: {
          type: 'string',
          enum: ['gasto', 'ingreso'],
          description: 'Si es un egreso o un ingreso'
        },
        tipo_fondo: {
          type: 'string',
          enum: ['moai_operativa', 'custodia_propietarios'],
          description: 'moai_operativa para caja propia de la inmobiliaria; custodia_propietarios para recaudo bruto de cánones o dispersiones a dueños'
        },
        monto: {
          type: 'integer',
          description: 'Monto en COP como número entero sin puntos ni comas, ej: 2600000, 309400, 19500000'
        },
        categoria: {
          type: 'string',
          enum: [
            'Comisión Arriendos',
            'Comisión Ventas',
            'Recaudo Canon (Terceros)',
            'Servicio Reformas',
            'Mantenimientos Locativos',
            'Mudanzas',
            'Asesorías & Avalúos',
            'Dispersión Propietarios',
            'Comisiones Asesores',
            'Portales & Marketing',
            'Pólizas Aseguradoras',
            'Administración Edificios',
            'Oficina Medellín',
            'Nómina & Seguridad Social',
            'Software & Tecnología',
            'Impuestos & ICA',
            'Honorarios Contables',
            'Otros'
          ],
          description: 'Categoría contable específica de la operación'
        },
        inmueble_codigo: {
          type: 'string',
          description: 'Código del inmueble si aplica (ej: MOAI-APT-402, MOAI-CAS-108, o descripción breve de la propiedad)'
        },
        beneficiario_o_pagador: {
          type: 'string',
          description: 'Nombre del propietario, inquilino, proveedor o asesor involucrado'
        },
        descripcion: {
          type: 'string',
          description: 'Descripción detallada del movimiento'
        },
        fecha: {
          type: 'string',
          description: 'Fecha en formato AAAA-MM-DD'
        }
      },
      required: ['tipo', 'monto', 'categoria', 'descripcion', 'fecha']
    }
  },
  {
    name: 'programar_pago',
    description: 'Programa una fecha futura de cobro de canon, dispersión a propietario o pago de servicios/pólizas.',
    input_schema: {
      type: 'object',
      properties: {
        titulo: {
          type: 'string',
          description: 'Título o concepto del pago/cobro programado'
        },
        monto: {
          type: 'integer',
          description: 'Monto en COP entero sin puntos ni comas'
        },
        categoria: {
          type: 'string',
          description: 'Categoría contable del compromiso'
        },
        tipo_evento: {
          type: 'string',
          enum: [
            'cobro_canon',
            'dispersion_propietario',
            'pago_poliza',
            'pago_administracion',
            'nomina_comision',
            'impuesto_dian_ica',
            'servicio_general'
          ],
          description: 'Tipo de evento financiero programado'
        },
        beneficiario: {
          type: 'string',
          description: 'Beneficiario del pago o persona a cobrar'
        },
        inmueble_codigo: {
          type: 'string',
          description: 'Código del inmueble si aplica'
        },
        fecha_vencimiento: {
          type: 'string',
          description: 'Fecha de vencimiento en formato AAAA-MM-DD'
        },
        recurrencia: {
          type: 'string',
          enum: ['ninguna', 'quincenal', 'mensual', 'anual'],
          description: 'Frecuencia de recurrencia'
        },
        recordatorio_dias_antes: {
          type: 'integer',
          description: 'Días previos para enviar la alerta (por defecto 2)'
        }
      },
      required: ['titulo', 'monto', 'categoria', 'fecha_vencimiento', 'recurrencia']
    }
  },
  {
    name: 'liquidar_canon',
    description: 'Calcula la liquidación de canon para un propietario con comisión MOAI e IVA.',
    input_schema: {
      type: 'object',
      properties: {
        inmueble_codigo: {
          type: 'string',
          description: 'Código del inmueble (ej: MOAI-APT-402)'
        },
        canon_bruto: {
          type: 'integer',
          description: 'Valor del canon mensual en COP'
        },
        porcentaje_comision: {
          type: 'number',
          description: 'Porcentaje de administración pactado (ej: 8 o 10)'
        },
        propietario: {
          type: 'string',
          description: 'Nombre del propietario'
        },
        deducciones: {
          type: 'integer',
          description: 'Deducciones adicionales como cuota PH o reparaciones locativas'
        }
      },
      required: ['canon_bruto', 'propietario']
    }
  },
  {
    name: 'pedir_aclaracion',
    description: 'Pide aclaración al socio cuando falte el monto, el inmueble o no sea claro si es comisión, canon o gasto.',
    input_schema: {
      type: 'object',
      properties: {
        pregunta: {
          type: 'string',
          description: 'Pregunta clara y profesional en contexto inmobiliario colombiano'
        }
      },
      required: ['pregunta']
    }
  }
];

// Parser heurístico colombiano especializado en jerga inmobiliaria (offline / backup)
function parseRealEstateFallback(text: string, todayDate: string) {
  const lower = text.toLowerCase().trim();
  const tools: Array<{ toolName: string; parameters: any }> = [];

  // Función para parsear montos en pesos colombianos y jerga
  const parseAmount = (str: string): number | null => {
    // X millones (ej: 18 millones, 650 millones, 2.5 millones)
    const millionMatch = str.match(/(\d+(?:[.,]\d+)?)\s*(?:millones?|palos?)\b/);
    if (millionMatch) {
      const val = parseFloat(millionMatch[1].replace(',', '.'));
      return Math.round(val * 1000000);
    }

    if (/un palo|1 palo/.test(str)) return 1000000;
    if (/medio palo/.test(str)) return 500000;

    // X lucas / X barras
    const lucasMatch = str.match(/(\d+(?:[.,]\d+)?)\s*(?:lucas?|barras?)/);
    if (lucasMatch) {
      const val = parseFloat(lucasMatch[1].replace(',', '.'));
      return Math.round(val * 1000);
    }

    // X k (ej: 250k)
    const kMatch = str.match(/(\d+(?:[.,]\d+)?)\s*k\b/);
    if (kMatch) {
      const val = parseFloat(kMatch[1].replace(',', '.'));
      return Math.round(val * 1000);
    }

    // X mil (ej: 450 mil)
    const milMatch = str.match(/(\d+(?:[.,]\d+)?)\s*mil\b/);
    if (milMatch) {
      const val = parseFloat(milMatch[1].replace(',', '.'));
      return Math.round(val * 1000);
    }

    // Números directos con puntos de miles (ej: 2.600.000, 450.000, 1800000)
    const rawNumberMatch = str.match(/\$?\s*(\d{1,3}(?:\.\d{3})+|\d{4,10})/);
    if (rawNumberMatch) {
      const clean = rawNumberMatch[1].replace(/\./g, '');
      return parseInt(clean, 10);
    }

    return null;
  };

  // Detectar código de inmueble si se menciona (ej: apto 402, casa 108, local 5)
  let inmuebleCodigo = '';
  const aptoMatch = lower.match(/(?:apto|apartamento)\s*(\d+[a-z]?)/i);
  if (aptoMatch) inmuebleCodigo = `Apto ${aptoMatch[1].toUpperCase()}`;
  const casaMatch = lower.match(/(?:casa)\s*(\d+[a-z]?)/i);
  if (casaMatch) inmuebleCodigo = `Casa ${casaMatch[1].toUpperCase()}`;
  const localMatch = lower.match(/(?:local)\s*(\d+[a-z]?)/i);
  if (localMatch) inmuebleCodigo = `Local ${localMatch[1].toUpperCase()}`;

  // Detectar si es evento futuro o programado
  const isFuture = /programar|cada mes|cada semana|vence|el \d+|para el \d+|tengo que pagar|toca pagar|toca cobrar|cobro el/i.test(lower);
  const isRecurrent = /cada mes|mensual|todos los meses/i.test(lower);

  // Parsear fecha relativa
  let dueDate = todayDate;
  const dayOfMonthMatch = lower.match(/(?:el|cada)\s*(\d{1,2})/);
  if (dayOfMonthMatch) {
    const targetDay = parseInt(dayOfMonthMatch[1], 10);
    const [yStr, mStr, dStr] = todayDate.split('-');
    let year = parseInt(yStr, 10);
    let month = parseInt(mStr, 10);
    const currentDay = parseInt(dStr, 10);
    if (targetDay < currentDay) {
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
    dueDate = `${year}-${String(month).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;
  }

  // 1. Programación de pago / cobro
  if (isFuture) {
    const amount = parseAmount(lower);
    if (!amount) {
      tools.push({
        toolName: 'pedir_aclaracion',
        parameters: { pregunta: '¿De cuánto es el monto a programar para esta fecha?' }
      });
      return tools;
    }

    let eventType = 'servicio_general';
    let cat = 'Otros';
    let title = 'Compromiso programado';
    let beneficiary = 'MOAI Inmobiliaria';

    if (/canon|arriendo|alquiler|inquilino/i.test(lower)) {
      eventType = 'cobro_canon';
      cat = 'Recaudo Canon (Terceros)';
      title = `Recaudo Canon ${inmuebleCodigo || ''}`.trim();
      beneficiary = 'Inquilino';
    } else if (/dispersion|propietari|dueno|giro/i.test(lower)) {
      eventType = 'dispersion_propietario';
      cat = 'Dispersión Propietarios';
      title = `Dispersión Canon ${inmuebleCodigo || ''}`.trim();
      beneficiary = 'Propietario';
    } else if (/poliza|libertador|unifianza|seguro/i.test(lower)) {
      eventType = 'pago_poliza';
      cat = 'Pólizas Aseguradoras';
      title = 'Pago Póliza Colectiva Arrendamientos';
      beneficiary = 'Aseguradora';
    } else if (/pauta|finca raiz|ciencuadras|portal|marketing/i.test(lower)) {
      eventType = 'servicio_general';
      cat = 'Portales & Marketing';
      title = 'Renovación Portales Inmobiliarios';
      beneficiary = 'Portal Inmobiliario';
    } else if (/dian|ica|impuesto/i.test(lower)) {
      eventType = 'impuesto_dian_ica';
      cat = 'Impuestos & ICA';
      title = 'Declaración y Pago Impuestos';
      beneficiary = 'DIAN / Alcaldía de Medellín';
    }

    tools.push({
      toolName: 'programar_pago',
      parameters: {
        titulo: title,
        monto: amount,
        categoria: cat,
        tipo_evento: eventType,
        beneficiario: beneficiary,
        inmueble_codigo: inmuebleCodigo || undefined,
        fecha_vencimiento: dueDate,
        recurrencia: isRecurrent ? 'mensual' : 'ninguna',
        recordatorio_dias_antes: 2
      }
    });
    return tools;
  }

  // 2. Liquidación de canon
  if (/liquidar|liquidacion/i.test(lower) && /canon|arriendo/i.test(lower)) {
    const amount = parseAmount(lower);
    if (amount) {
      tools.push({
        toolName: 'liquidar_canon',
        parameters: {
          inmueble_codigo: inmuebleCodigo || 'MOAI-INM',
          canon_bruto: amount,
          porcentaje_comision: 10,
          propietario: 'Propietario Inmueble',
          deducciones: 0
        }
      });
      return tools;
    }
  }

  // 3. Registro de movimiento real
  const amount = parseAmount(lower);
  if (!amount) {
    tools.push({
      toolName: 'pedir_aclaracion',
      parameters: {
        pregunta: '¿Podrías indicar el monto en pesos colombianos para registrar este movimiento contable en MOAI?'
      }
    });
    return tools;
  }

  // Clasificar tipo y categoría
  let isExpense = /pagu|gast|salid|compr|transfer|pagad|factur|pauta|arriendo oficina|nomina|plomer/i.test(lower);
  let isIncome = /cobram|recib|ingres|comision|canon|consign|vendim|margen/i.test(lower);

  if (!isExpense && !isIncome) {
    isIncome = /comision|canon|recaudo|venta/i.test(lower);
    isExpense = !isIncome;
  }

  let cat = isExpense ? 'Otros' : 'Comisión Arriendos';
  let fundType = 'moai_operativa';
  let desc = text;

  if (/canon|arriendo pagado por inquilino|recaudo canon/i.test(lower)) {
    isIncome = true;
    isExpense = false;
    cat = 'Recaudo Canon (Terceros)';
    fundType = 'custodia_propietarios';
    desc = `Recaudo canon mensual ${inmuebleCodigo || ''}`.trim();
  } else if (/comision.*(arriend|renta)/i.test(lower)) {
    isIncome = true;
    isExpense = false;
    cat = 'Comisión Arriendos';
    fundType = 'moai_operativa';
    desc = `Comisión administración de canon ${inmuebleCodigo || ''}`.trim();
  } else if (/venta|corretaje|comision.*venta/i.test(lower)) {
    isIncome = true;
    isExpense = false;
    cat = 'Comisión Ventas';
    fundType = 'moai_operativa';
    desc = `Comisión por corretaje y venta ${inmuebleCodigo || ''}`.trim();
  } else if (/reforma|remodel|obra/i.test(lower)) {
    isIncome = true;
    isExpense = false;
    cat = 'Servicio Reformas';
    fundType = 'moai_operativa';
    desc = 'Servicio y margen de obra MOAI Reformas';
  } else if (/dispersion|giro.*propietari|pago.*dueno/i.test(lower)) {
    isExpense = true;
    isIncome = false;
    cat = 'Dispersión Propietarios';
    fundType = 'custodia_propietarios';
    desc = `Dispersión bancaria a propietario ${inmuebleCodigo || ''}`.trim();
  } else if (/pauta|finca raiz|ciencuadras|portal|marketing/i.test(lower)) {
    isExpense = true;
    isIncome = false;
    cat = 'Portales & Marketing';
    fundType = 'moai_operativa';
    desc = 'Pauta en portales inmobiliarios';
  } else if (/poliza|fianza|libertador|unifianza/i.test(lower)) {
    isExpense = true;
    isIncome = false;
    cat = 'Pólizas Aseguradoras';
    fundType = 'moai_operativa';
    desc = 'Pago póliza colectiva seguros arrendamiento';
  } else if (/plomer|pintur|reparac|arreglo|fuga|mantenimiento/i.test(lower)) {
    isExpense = true;
    isIncome = false;
    cat = 'Mantenimientos Locativos';
    fundType = 'moai_operativa';
    desc = `Mantenimiento locativo ${inmuebleCodigo || ''}`.trim();
  } else if (/oficina|epm|sede/i.test(lower)) {
    isExpense = true;
    isIncome = false;
    cat = 'Oficina Medellín';
    fundType = 'moai_operativa';
    desc = 'Gastos de sede MOAI Calle 32C # 80A 45';
  } else if (/asesor|captador|comision.*vendedor/i.test(lower)) {
    isExpense = true;
    isIncome = false;
    cat = 'Comisiones Asesores';
    fundType = 'moai_operativa';
    desc = 'Pago comisiones a asesor inmobiliario';
  }

  tools.push({
    toolName: 'registrar_movimiento',
    parameters: {
      tipo: isIncome ? 'ingreso' : 'gasto',
      tipo_fondo: fundType,
      monto: amount,
      categoria: cat,
      inmueble_codigo: inmuebleCodigo || undefined,
      descripcion: desc,
      fecha: todayDate
    }
  });

  return tools;
}

async function startServer() {
  const app = express();
  const PORT = parseInt(process.env.PORT || '3000', 10);

  app.use(express.json({ limit: '10mb' }));

  // Protección opcional con contraseña (recomendado al publicar la app en internet).
  // Si APP_PASSWORD está definido, el navegador pide usuario/contraseña (usuario: cualquiera).
  const APP_PASSWORD = process.env.APP_PASSWORD || '';
  if (APP_PASSWORD) {
    app.use((req, res, next) => {
      if (req.path === '/api/health') return next();
      const header = req.headers.authorization || '';
      const [scheme, encoded] = header.split(' ');
      if (scheme === 'Basic' && encoded) {
        const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
        const password = decoded.slice(decoded.indexOf(':') + 1);
        if (password === APP_PASSWORD) return next();
      }
      res.set('WWW-Authenticate', 'Basic realm="MOAI Inmobiliaria"');
      return res.status(401).send('Autenticación requerida');
    });
  }

  // Endpoint de salud
  app.get('/api/health', (req: Request, res: Response) => {
    res.json({
      status: 'ok',
      company: 'MOAI Inmobiliaria S.A.S.',
      city: 'Medellín, Colombia',
      hasAnthropicKey: Boolean(process.env.ANTHROPIC_API_KEY),
      storage: useSupabase ? 'supabase' : 'file'
    });
  });

  // ───────────── Almacenamiento (Supabase si está configurado, si no archivo local) ─────────────
  // El estado completo de la app se guarda como un único documento JSON con número de versión.
  // La versión permite detectar escrituras concurrentes (app web vs. conector MCP de Claude).
  // Tolera URLs pegadas sin https://, con espacios, comillas, / final o /rest/v1
  const clean = (v: string) => v.trim().replace(/^['"]|['"]$/g, '').trim();
  const rawUrl = clean(process.env.SUPABASE_URL || '');
  const SUPABASE_URL = rawUrl
    ? (/^https?:\/\//.test(rawUrl) ? rawUrl : `https://${rawUrl}`).replace(/\/+$/, '').replace(/\/rest\/v1$/, '')
    : '';
  const SUPABASE_KEY = clean(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
  const useSupabase = Boolean(SUPABASE_URL && SUPABASE_KEY);
  const DB_FILE_PATH = path.resolve(__dirname, 'data', 'moai_database.json');

  if (!useSupabase && !fs.existsSync(path.resolve(__dirname, 'data'))) {
    fs.mkdirSync(path.resolve(__dirname, 'data'), { recursive: true });
  }
  console.log(`[MOAI DB] Almacenamiento: ${useSupabase ? 'Supabase' : 'archivo local ' + DB_FILE_PATH}`);

  // Claves nuevas (sb_secret_...) van solo en `apikey`; las legacy (JWT service_role) también en Authorization.
  const sbHeaders = (): Record<string, string> => ({
    apikey: SUPABASE_KEY,
    ...(SUPABASE_KEY.startsWith('eyJ') ? { Authorization: `Bearer ${SUPABASE_KEY}` } : {}),
    'Content-Type': 'application/json',
    Prefer: 'return=representation'
  });

  type StoredState = { data: any; version: number };

  async function readState(): Promise<StoredState> {
    if (useSupabase) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/moai_state?id=eq.1&select=data,version`, { headers: sbHeaders() });
      if (!r.ok) throw new Error(`Supabase GET ${r.status}: ${await r.text()}`);
      const rows = await r.json();
      if (rows.length === 0) return { data: null, version: 0 };
      return { data: rows[0].data && Object.keys(rows[0].data).length ? rows[0].data : null, version: Number(rows[0].version) };
    }
    if (!fs.existsSync(DB_FILE_PATH)) return { data: null, version: 0 };
    const parsed = JSON.parse(fs.readFileSync(DB_FILE_PATH, 'utf-8'));
    // Compatibilidad con el formato anterior (solo los datos, sin versión)
    if (parsed && typeof parsed.version === 'number' && 'data' in parsed) return parsed;
    return { data: parsed, version: 0 };
  }

  // Escribe solo si la versión guardada sigue siendo baseVersion. Devuelve null si hubo conflicto.
  async function writeState(data: any, baseVersion: number): Promise<number | null> {
    const next = baseVersion + 1;
    if (useSupabase) {
      if (baseVersion === 0) {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/moai_state?on_conflict=id`, {
          method: 'POST',
          headers: { ...sbHeaders(), Prefer: 'return=representation,resolution=ignore-duplicates' },
          body: JSON.stringify({ id: 1, data, version: next })
        });
        if (!r.ok) throw new Error(`Supabase POST ${r.status}: ${await r.text()}`);
        const rows = await r.json();
        if (rows.length === 1) return next;
        // La fila ya existía (sembrada con version 0): intentar actualización condicional
      }
      const r = await fetch(`${SUPABASE_URL}/rest/v1/moai_state?id=eq.1&version=eq.${baseVersion}`, {
        method: 'PATCH',
        headers: sbHeaders(),
        body: JSON.stringify({ data, version: next, updated_at: new Date().toISOString() })
      });
      if (!r.ok) throw new Error(`Supabase PATCH ${r.status}: ${await r.text()}`);
      const rows = await r.json();
      return rows.length === 1 ? next : null;
    }
    const current = await readState();
    if (current.version !== baseVersion) return null;
    fs.writeFileSync(DB_FILE_PATH, JSON.stringify({ version: next, data }, null, 2), 'utf-8');
    return next;
  }

  // Cargar base de datos
  app.get('/api/database', async (req: Request, res: Response) => {
    try {
      const { data, version } = await readState();
      return res.json({ success: true, data, version });
    } catch (err: any) {
      console.error('[MOAI DB] Error leyendo base de datos:', err);
      return res.status(500).json({ success: false, error: 'Error leyendo base de datos.' });
    }
  });

  // Guardar base de datos. Body: { data, baseVersion }. Responde 409 con el estado actual si hubo conflicto.
  app.post('/api/database', async (req: Request, res: Response) => {
    try {
      const { data, baseVersion } = req.body || {};
      if (!data || typeof data !== 'object' || typeof baseVersion !== 'number') {
        return res.status(400).json({ success: false, error: 'Se requiere { data, baseVersion }.' });
      }
      const version = await writeState(data, baseVersion);
      if (version === null) {
        const current = await readState();
        return res.status(409).json({ success: false, conflict: true, data: current.data, version: current.version });
      }
      return res.json({ success: true, version });
    } catch (err: any) {
      console.error('[MOAI DB] Error guardando base de datos:', err);
      return res.status(500).json({ success: false, error: 'Error guardando base de datos.' });
    }
  });

  // Proxy seguro para la API de Claude (Anthropic)
  app.post('/api/claude/chat', async (req: Request, res: Response) => {
    try {
      const { message, history = [] } = req.body;

      if (!message || typeof message !== 'string') {
        return res.status(400).json({ success: false, error: 'Mensaje requerido.' });
      }

      const { todayDate, dayOfWeek } = getBogotaDateTime();
      const apiKey = process.env.ANTHROPIC_API_KEY;

      // Si no hay API key configurada, ejecutar el parser heurístico inmobiliario
      if (!apiKey || apiKey.trim() === '' || apiKey.includes('MY_CLAUDE_API_KEY')) {
        console.log('[MOAI Backend] Usando parser heurístico inmobiliario (sin API key de Claude)');
        const toolsFound = parseRealEstateFallback(message, todayDate);
        return res.json({
          success: true,
          mode: 'heuristic',
          text: toolsFound.length > 0 
            ? 'Entendido. He estructurado la operación contable para MOAI Inmobiliaria:' 
            : 'He recibido tu mensaje contable.',
          tools: toolsFound.map((t, idx) => ({
            id: `tool-${Date.now()}-${idx}`,
            toolName: t.toolName,
            parameters: t.parameters,
            status: 'pending'
          }))
        });
      }

      // Prompt de sistema para MOAI Inmobiliaria
      const systemPrompt = `Eres el asistente contable y financiero de MOAI Inmobiliaria (Medellín, Colombia - www.inmobiliariamoai.com). Hoy es ${dayOfWeek} ${todayDate} (hora de Colombia).
Tu única tarea es convertir lo que escriben o dictan los socios y administradores de MOAI en movimientos contables y pagos programados usando las herramientas disponibles.

Reglas fundamentales:
- Entiende jerga inmobiliaria y financiera colombiana: 'canon' es el valor de arriendo; 'dispersión' es el pago al propietario del inmueble; 'comisión' (normalmente 8% a 10% en arriendos, 3% en ventas); '18 millones' = 18000000; '2.600.000' = 2600000; '450k' = 450000; 'un palo' = 1000000; 'lucas' o 'barras' = 1000.
- Distingue claramente entre:
  * Ingreso MOAI (Comisiones, reformas, avalúos, mantenimientos con margen) -> tipo_fondo: 'moai_operativa'
  * Recaudo bruto de canon (dinero de terceros que se custodia temporalmente) -> tipo_fondo: 'custodia_propietarios'
  * Dispersión a propietarios (pago del canon neto al dueño) -> tipo: 'gasto', tipo_fondo: 'custodia_propietarios'
  * Gastos operativos (portales Finca Raíz/Ciencuadras, pólizas El Libertador/Unifianza, oficina Calle 32C # 80A 45, nómina, asesores) -> tipo: 'gasto', tipo_fondo: 'moai_operativa'
- Si el usuario habla de compromisos futuros ('tengo que pagar el 10', 'cobro de canon el 5 de cada mes', 'póliza vence el 30'), usa programar_pago.
- Si falta el monto o el contexto no es claro, usa pedir_aclaracion sin inventar cifras.`;

      const formattedMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
      for (const h of history.slice(-6)) {
        if (h.sender === 'user' && h.text) formattedMessages.push({ role: 'user', content: h.text });
        else if (h.sender === 'assistant' && h.text) formattedMessages.push({ role: 'assistant', content: h.text });
      }
      formattedMessages.push({ role: 'user', content: message });

      const candidateModels = ['claude-haiku-5-5', 'claude-3-5-haiku-20241022', 'claude-3-haiku-20240307'];
      let claudeResponseData: any = null;

      for (const modelName of candidateModels) {
        try {
          const resp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'x-api-key': apiKey.trim(),
              'anthropic-version': '2023-06-01',
              'content-type': 'application/json'
            },
            body: JSON.stringify({
              model: modelName,
              max_tokens: 1024,
              system: systemPrompt,
              messages: formattedMessages,
              tools: CLAUDE_REAL_ESTATE_TOOLS
            })
          });

          if (resp.ok) {
            claudeResponseData = await resp.json();
            break;
          }
        } catch (e) {
          console.warn(`[MOAI] Error con modelo ${modelName}:`, e);
        }
      }

      if (!claudeResponseData) {
        const toolsFound = parseRealEstateFallback(message, todayDate);
        return res.json({
          success: true,
          mode: 'heuristic_fallback',
          text: 'He procesado tu registro inmobiliario con el motor local de MOAI:',
          tools: toolsFound.map((t, idx) => ({
            id: `tool-${Date.now()}-${idx}`,
            toolName: t.toolName,
            parameters: t.parameters,
            status: 'pending'
          }))
        });
      }

      // Procesar contenido devuelto por Claude
      let replyText = '';
      const toolsCalls: any[] = [];

      if (Array.isArray(claudeResponseData.content)) {
        for (const block of claudeResponseData.content) {
          if (block.type === 'text') {
            replyText += (replyText ? '\n' : '') + block.text;
          } else if (block.type === 'tool_use') {
            toolsCalls.push({
              id: block.id || `tool-${Date.now()}-${Math.random()}`,
              toolName: block.name,
              parameters: block.input,
              status: 'pending'
            });
          }
        }
      }

      return res.json({
        success: true,
        mode: 'claude',
        text: replyText || (toolsCalls.length > 0 ? 'He estructurado la operación contable para tu confirmación:' : 'Operación analizada.'),
        tools: toolsCalls
      });

    } catch (err: any) {
      console.error('[MOAI Backend] Error inesperado en /api/claude/chat:', err);
      const { todayDate } = getBogotaDateTime();
      const toolsFound = parseRealEstateFallback(req.body?.message || '', todayDate);
      return res.json({
        success: true,
        mode: 'heuristic_recovery',
        text: 'Registro procesado localmente en MOAI:',
        tools: toolsFound.map((t, idx) => ({
          id: `tool-${Date.now()}-${idx}`,
          toolName: t.toolName,
          parameters: t.parameters,
          status: 'pending'
        }))
      });
    }
  });

  // Montar Vite middlewares en desarrollo o servir dist en producción
  if (process.env.NODE_ENV !== 'production') {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[MOAI Inmobiliaria] Servidor contable listo en http://localhost:${PORT}`);
  });
}

startServer();
