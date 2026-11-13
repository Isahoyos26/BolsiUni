"""
MOAI Inmobiliaria — Conector MCP para Claude.

Permite que Claude lea y llene la contabilidad de la app MOAI (movimientos, inmuebles,
pagos programados y liquidaciones de canon) escribiendo en la misma base de datos
que usa la app web (tabla `moai_state` en Supabase).

Variables de entorno:
  SUPABASE_URL                 https://<proyecto>.supabase.co
  SUPABASE_SERVICE_ROLE_KEY    clave service_role del proyecto (secreta)
  MOAI_DB_FILE                 (opcional, solo pruebas locales) ruta a data/moai_database.json

Despliegue en Prefect Horizon: entrypoint `mcp_server/server.py:mcp`.
"""

from __future__ import annotations

import json
import os
import random
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Annotated, Any, Callable, Literal, Optional

import httpx
from fastmcp import FastMCP
from pydantic import Field

mcp = FastMCP(
    name="MOAI Inmobiliaria",
    instructions=(
        "Conector contable de MOAI Inmobiliaria (Medellín, Colombia). Montos en pesos "
        "colombianos (COP) como enteros. 'Canon' = arriendo; 'dispersión' = giro neto al "
        "propietario. Separa siempre la caja propia de MOAI (moai_operativa) del fondo de "
        "custodia de propietarios (custodia_propietarios): el recaudo de canon y la dispersión "
        "van a custodia; comisiones y gastos operativos van a moai_operativa. "
        "Antes de registrar, confirma con el usuario los datos dudosos y usa "
        "listar_inmuebles para encontrar el código correcto del inmueble."
    ),
)

# ───────────────────────────── Almacenamiento ─────────────────────────────

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
LOCAL_FILE = os.environ.get("MOAI_DB_FILE", "")


class ConflictError(Exception):
    pass


def _headers(extra: dict[str, str] | None = None) -> dict[str, str]:
    # Claves nuevas (sb_secret_...) van solo en `apikey`; las legacy (JWT service_role) también en Authorization.
    h = {
        "apikey": SUPABASE_KEY,
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }
    if SUPABASE_KEY.startswith("eyJ"):
        h["Authorization"] = f"Bearer {SUPABASE_KEY}"
    if extra:
        h.update(extra)
    return h


def _read() -> tuple[dict[str, Any], int]:
    if SUPABASE_URL and SUPABASE_KEY:
        r = httpx.get(
            f"{SUPABASE_URL}/rest/v1/moai_state",
            params={"id": "eq.1", "select": "data,version"},
            headers=_headers(),
            timeout=20,
        )
        r.raise_for_status()
        rows = r.json()
        if not rows:
            return {}, 0
        return rows[0]["data"] or {}, int(rows[0]["version"])
    if LOCAL_FILE:
        p = Path(LOCAL_FILE)
        if not p.exists():
            return {}, 0
        parsed = json.loads(p.read_text("utf-8"))
        if isinstance(parsed, dict) and "data" in parsed and isinstance(parsed.get("version"), int):
            return parsed["data"] or {}, parsed["version"]
        return parsed or {}, 0
    raise RuntimeError(
        "Conector sin configurar: define SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en Horizon."
    )


def _write(data: dict[str, Any], base_version: int) -> int:
    nxt = base_version + 1
    if SUPABASE_URL and SUPABASE_KEY:
        if base_version == 0:
            r = httpx.post(
                f"{SUPABASE_URL}/rest/v1/moai_state",
                params={"on_conflict": "id"},
                headers=_headers({"Prefer": "return=representation,resolution=ignore-duplicates"}),
                json={"id": 1, "data": data, "version": nxt},
                timeout=20,
            )
            r.raise_for_status()
            if len(r.json()) == 1:
                return nxt
        r = httpx.patch(
            f"{SUPABASE_URL}/rest/v1/moai_state",
            params={"id": "eq.1", "version": f"eq.{base_version}"},
            headers=_headers(),
            json={
                "data": data,
                "version": nxt,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            },
            timeout=20,
        )
        r.raise_for_status()
        if len(r.json()) != 1:
            raise ConflictError()
        return nxt
    _, current = _read()
    if current != base_version:
        raise ConflictError()
    Path(LOCAL_FILE).parent.mkdir(parents=True, exist_ok=True)
    Path(LOCAL_FILE).write_text(json.dumps({"version": nxt, "data": data}, ensure_ascii=False, indent=2), "utf-8")
    return nxt


def _mutate(fn: Callable[[dict[str, Any]], Any]) -> Any:
    """Lee el estado, aplica `fn` (que modifica `data` en sitio) y guarda; reintenta si hay conflicto."""
    for _ in range(6):
        data, version = _read()
        for key in ("transactions", "properties", "scheduledPayments", "partners"):
            data.setdefault(key, [])
        result = fn(data)
        try:
            _write(data, version)
            return result
        except ConflictError:
            time.sleep(0.2 + random.random() * 0.5)
    raise RuntimeError("No se pudo guardar: la base de datos está muy ocupada. Intenta de nuevo.")


# ───────────────────────────── Utilidades ─────────────────────────────

INCOME_CATEGORIES = {
    "comision_arriendos": "Comisión Administración Arriendos",
    "comision_ventas": "Comisión por Venta de Inmuebles",
    "recaudo_canon": "Recaudo Canon de Arrendamiento (terceros)",
    "servicio_reformas": "Servicios MOAI Reformas",
    "mantenimiento_locativo": "Mantenimiento y Reparaciones Locativas",
    "mudanzas_logistica": "Servicio MOAI Mudanzas",
    "asesorias_legales": "Asesorías Jurídicas y Avalúos",
    "anticipo_canones": "Rendimiento Anticipo de Cánones",
    "otros_ingresos": "Otros Ingresos",
}
EXPENSE_CATEGORIES = {
    "dispersion_propietarios": "Dispersión / Giro a Propietarios",
    "comisiones_asesores": "Comisiones a Asesores y Captadores",
    "portales_marketing": "Portales Inmobiliarios y Pauta",
    "polizas_fianzas": "Pólizas Colectivas y Fianzas",
    "mantenimientos_inmuebles": "Mantenimiento de Inmuebles (pago a técnicos)",
    "administracion_ph": "Administración de Edificios (PH)",
    "oficina_servicios": "Oficina Medellín y Servicios",
    "nomina_seguridad_social": "Nómina y Seguridad Social",
    "software_tecnologia": "Software y Tecnología",
    "impuestos_tributario": "Impuestos, ICA, IVA, Retefuente",
    "honorarios_profesionales": "Honorarios Contador / Abogados",
    "otros_gastos": "Gastos Varios",
}
CUSTODY_CATEGORIES = {"recaudo_canon", "dispersion_propietarios"}

CategoryId = Literal[
    "comision_arriendos", "comision_ventas", "recaudo_canon", "servicio_reformas",
    "mantenimiento_locativo", "mudanzas_logistica", "asesorias_legales", "anticipo_canones",
    "otros_ingresos", "dispersion_propietarios", "comisiones_asesores", "portales_marketing",
    "polizas_fianzas", "mantenimientos_inmuebles", "administracion_ph", "oficina_servicios",
    "nomina_seguridad_social", "software_tecnologia", "impuestos_tributario",
    "honorarios_profesionales", "otros_gastos",
]
EventType = Literal[
    "cobro_canon", "dispersion_propietario", "pago_poliza", "pago_administracion",
    "nomina_comision", "impuesto_dian_ica", "servicio_general",
]
BOGOTA = timezone(timedelta(hours=-5))


def _today() -> str:
    return datetime.now(BOGOTA).strftime("%Y-%m-%d")


def _now_ms() -> int:
    return int(time.time() * 1000)


def _new_id(prefix: str) -> str:
    return f"{prefix}-{_now_ms()}-{random.randint(1000, 9999)}"


def _cop(n: float) -> str:
    return "$" + f"{round(n):,}".replace(",", ".")


def _find_property(data: dict[str, Any], code: str) -> Optional[dict[str, Any]]:
    c = code.strip().lower()
    props = data.get("properties", [])
    for p in props:
        if p.get("code", "").lower() == c or p.get("id", "").lower() == c:
            return p
    matches = [p for p in props if c in p.get("code", "").lower() or c in p.get("title", "").lower()]
    return matches[0] if len(matches) == 1 else None


def _balances(txs: list[dict[str, Any]]) -> dict[str, int]:
    out = {"caja_moai": 0, "custodia_propietarios": 0}
    for t in txs:
        sign = 1 if t.get("type") == "income" else -1
        key = "caja_moai" if t.get("fundType") == "moai_operativa" else "custodia_propietarios"
        out[key] += sign * int(t.get("amount", 0))
    return out


def _make_tx(**kw: Any) -> dict[str, Any]:
    tx = {"id": _new_id("tx-mcp"), "createdAt": _now_ms(), **kw}
    return {k: v for k, v in tx.items() if v is not None}


# ───────────────────────────── Herramientas de lectura ─────────────────────────────

@mcp.tool(annotations={"readOnlyHint": True})
def resumen_financiero(
    mes: Annotated[Optional[str], Field(description="Mes a resumir en formato AAAA-MM. Por defecto el mes actual.")] = None,
) -> dict[str, Any]:
    """Saldos de Caja MOAI y Fondo de Custodia, ingresos/gastos del mes por categoría y próximos pagos (15 días)."""
    data, _ = _read()
    txs = data.get("transactions", [])
    mes = mes or _today()[:7]
    del_mes = [t for t in txs if str(t.get("date", "")).startswith(mes)]
    por_categoria: dict[str, int] = {}
    ingresos_moai = gastos_moai = 0
    for t in del_mes:
        cat = t.get("category", "otros")
        por_categoria[cat] = por_categoria.get(cat, 0) + int(t.get("amount", 0))
        if t.get("fundType") == "moai_operativa":
            if t.get("type") == "income":
                ingresos_moai += int(t["amount"])
            else:
                gastos_moai += int(t["amount"])
    hoy = _today()
    limite = (datetime.now(BOGOTA) + timedelta(days=15)).strftime("%Y-%m-%d")
    proximos = sorted(
        [p for p in data.get("scheduledPayments", []) if p.get("status") == "pendiente" and p.get("dueDate", "") <= limite],
        key=lambda p: p.get("dueDate", ""),
    )
    return {
        "saldos_totales": _balances(txs),
        "mes": mes,
        "caja_moai_mes": {"ingresos": ingresos_moai, "gastos": gastos_moai, "utilidad": ingresos_moai - gastos_moai},
        "movimientos_mes": len(del_mes),
        "totales_por_categoria_mes": por_categoria,
        "pagos_proximos_15_dias": [
            {k: p.get(k) for k in ("id", "title", "amount", "dueDate", "eventType", "beneficiary", "propertyCode")}
            | {"vencido": p.get("dueDate", "") < hoy}
            for p in proximos
        ],
        "inmuebles": len(data.get("properties", [])),
    }


@mcp.tool(annotations={"readOnlyHint": True})
def listar_movimientos(
    desde: Annotated[Optional[str], Field(description="Fecha inicial AAAA-MM-DD")] = None,
    hasta: Annotated[Optional[str], Field(description="Fecha final AAAA-MM-DD")] = None,
    tipo: Annotated[Optional[Literal["ingreso", "gasto"]], Field(description="Filtrar por tipo")] = None,
    categoria: Annotated[Optional[CategoryId], Field(description="Filtrar por categoría")] = None,
    inmueble_codigo: Annotated[Optional[str], Field(description="Filtrar por código de inmueble")] = None,
    buscar: Annotated[Optional[str], Field(description="Texto a buscar en descripción o tercero")] = None,
    limite: Annotated[int, Field(ge=1, le=500)] = 50,
) -> list[dict[str, Any]]:
    """Lista movimientos contables del libro diario, del más reciente al más antiguo."""
    data, _ = _read()
    out = []
    for t in sorted(data.get("transactions", []), key=lambda t: (t.get("date", ""), t.get("createdAt", 0)), reverse=True):
        if desde and t.get("date", "") < desde:
            continue
        if hasta and t.get("date", "") > hasta:
            continue
        if tipo and t.get("type") != ("income" if tipo == "ingreso" else "expense"):
            continue
        if categoria and t.get("category") != categoria:
            continue
        if inmueble_codigo and inmueble_codigo.lower() not in str(t.get("propertyCode", "")).lower():
            continue
        if buscar and buscar.lower() not in (str(t.get("description", "")) + " " + str(t.get("recipientOrPayer", ""))).lower():
            continue
        out.append(t)
        if len(out) >= limite:
            break
    return out


@mcp.tool(annotations={"readOnlyHint": True})
def listar_inmuebles(
    buscar: Annotated[Optional[str], Field(description="Texto en código, título, barrio, propietario o inquilino")] = None,
    estado: Annotated[Optional[Literal["arrendado", "disponible", "en_venta", "en_reforma"]], Field()] = None,
) -> list[dict[str, Any]]:
    """Lista la cartera de inmuebles administrados con propietario, inquilino y canon."""
    data, _ = _read()
    out = []
    for p in data.get("properties", []):
        text = " ".join(str(p.get(k, "")) for k in ("code", "title", "neighborhood", "ownerName", "tenantName")).lower()
        if buscar and buscar.lower() not in text:
            continue
        if estado and p.get("status") != estado:
            continue
        out.append(p)
    return out


@mcp.tool(annotations={"readOnlyHint": True})
def listar_pagos_programados(
    estado: Annotated[Optional[Literal["pendiente", "ejecutado", "vencido"]], Field()] = "pendiente",
) -> list[dict[str, Any]]:
    """Lista los pagos y cobros programados del calendario, ordenados por fecha de vencimiento."""
    data, _ = _read()
    pagos = [p for p in data.get("scheduledPayments", []) if not estado or p.get("status") == estado]
    return sorted(pagos, key=lambda p: p.get("dueDate", ""))


@mcp.tool(annotations={"readOnlyHint": True})
def listar_categorias() -> dict[str, dict[str, str]]:
    """Catálogo de categorías contables (id → nombre) para ingresos y gastos."""
    return {"ingresos": INCOME_CATEGORIES, "gastos": EXPENSE_CATEGORIES}


# ───────────────────────────── Herramientas de escritura ─────────────────────────────

@mcp.tool
def registrar_movimiento(
    tipo: Annotated[Literal["ingreso", "gasto"], Field(description="Ingreso o egreso")],
    monto: Annotated[int, Field(gt=0, description="Monto en COP, entero (ej: 2600000)")],
    categoria: Annotated[CategoryId, Field(description="Categoría contable (ver listar_categorias)")],
    descripcion: Annotated[str, Field(description="Concepto del movimiento")],
    fecha: Annotated[Optional[str], Field(description="AAAA-MM-DD; por defecto hoy (Bogotá)")] = None,
    tipo_fondo: Annotated[
        Optional[Literal["moai_operativa", "custodia_propietarios"]],
        Field(description="Si se omite se deduce de la categoría"),
    ] = None,
    inmueble_codigo: Annotated[Optional[str], Field(description="Código del inmueble, ej: MOAI-APT-402")] = None,
    tercero: Annotated[Optional[str], Field(description="Propietario, inquilino, proveedor o asesor")] = None,
    comprobante: Annotated[Optional[str], Field(description="Número de comprobante o factura")] = None,
) -> dict[str, Any]:
    """Registra un ingreso o egreso real en el libro diario de MOAI."""
    def apply(data: dict[str, Any]) -> dict[str, Any]:
        prop = _find_property(data, inmueble_codigo) if inmueble_codigo else None
        tx = _make_tx(
            type="income" if tipo == "ingreso" else "expense",
            fundType=tipo_fondo or ("custodia_propietarios" if categoria in CUSTODY_CATEGORIES else "moai_operativa"),
            amount=monto,
            category=categoria,
            date=fecha or _today(),
            description=descripcion,
            propertyId=prop["id"] if prop else None,
            propertyCode=prop["code"] if prop else inmueble_codigo,
            recipientOrPayer=tercero,
            referenceNumber=comprobante or f"MCP-{str(_now_ms())[-5:]}",
        )
        data["transactions"].insert(0, tx)
        return tx

    tx = _mutate(apply)
    return {"ok": True, "mensaje": f"{tipo.capitalize()} de {_cop(monto)} registrado.", "movimiento": tx}


@mcp.tool(annotations={"destructiveHint": True})
def eliminar_movimiento(
    id: Annotated[str, Field(description="id del movimiento (ver listar_movimientos)")],
) -> dict[str, Any]:
    """Elimina un movimiento del libro diario. Confirma con el usuario antes de usarla."""
    def apply(data: dict[str, Any]) -> Optional[dict[str, Any]]:
        for i, t in enumerate(data["transactions"]):
            if t.get("id") == id:
                return data["transactions"].pop(i)
        return None

    removed = _mutate(apply)
    if not removed:
        return {"ok": False, "error": f"No existe el movimiento {id}."}
    return {"ok": True, "eliminado": removed}


@mcp.tool
def guardar_inmueble(
    codigo: Annotated[str, Field(description="Código único, ej: MOAI-APT-402. Si ya existe, se actualiza.")],
    titulo: Annotated[Optional[str], Field(description="Ej: Apto 402 Edificio Laureles Real")] = None,
    direccion: Optional[str] = None,
    barrio: Optional[str] = None,
    ciudad: Optional[str] = None,
    tipo: Optional[Literal["apartamento", "casa", "local", "oficina", "bodega", "lote"]] = None,
    estado: Optional[Literal["arrendado", "disponible", "en_venta", "en_reforma"]] = None,
    canon_mensual: Annotated[Optional[int], Field(ge=0)] = None,
    cuota_administracion: Annotated[Optional[int], Field(ge=0, description="Cuota PH en COP")] = None,
    porcentaje_comision: Annotated[Optional[float], Field(ge=0, le=100)] = None,
    iva_sobre_comision: Optional[bool] = None,
    propietario: Optional[str] = None,
    propietario_documento: Optional[str] = None,
    propietario_banco: Optional[str] = None,
    propietario_tipo_cuenta: Optional[Literal["ahorros", "corriente"]] = None,
    propietario_numero_cuenta: Optional[str] = None,
    propietario_email: Optional[str] = None,
    propietario_telefono: Optional[str] = None,
    inquilino: Optional[str] = None,
    inquilino_documento: Optional[str] = None,
    inquilino_telefono: Optional[str] = None,
    dia_pago: Annotated[Optional[int], Field(ge=1, le=31, description="Día del mes en que vence el canon")] = None,
    aseguradora: Optional[Literal["El Libertador", "Unifianza", "FianzaCrédito", "Sura", "Directa", "Ninguna"]] = None,
    numero_poliza: Optional[str] = None,
) -> dict[str, Any]:
    """Crea un inmueble nuevo o actualiza uno existente (solo cambia los campos enviados)."""
    fields = {
        "title": titulo, "address": direccion, "neighborhood": barrio, "city": ciudad, "type": tipo,
        "status": estado, "monthlyRent": canon_mensual, "adminFee": cuota_administracion,
        "commissionRate": porcentaje_comision, "ivaOnCommission": iva_sobre_comision,
        "ownerName": propietario, "ownerDocument": propietario_documento, "ownerBank": propietario_banco,
        "ownerAccountType": propietario_tipo_cuenta, "ownerAccountNumber": propietario_numero_cuenta,
        "ownerEmail": propietario_email, "ownerPhone": propietario_telefono, "tenantName": inquilino,
        "tenantDocument": inquilino_documento, "tenantPhone": inquilino_telefono, "paymentDueDay": dia_pago,
        "insuranceCompany": aseguradora, "policyNumber": numero_poliza,
    }
    fields = {k: v for k, v in fields.items() if v is not None}

    def apply(data: dict[str, Any]) -> tuple[str, dict[str, Any]]:
        for p in data["properties"]:
            if p.get("code", "").lower() == codigo.strip().lower():
                p.update(fields)
                return "actualizado", p
        defaults = {
            "id": _new_id("prop"), "code": codigo.strip(), "title": codigo.strip(), "address": "",
            "neighborhood": "", "city": "Medellín", "type": "apartamento", "status": "disponible",
            "monthlyRent": 0, "adminFee": 0,
            "commissionRate": (data.get("companyProfile") or {}).get("defaultCommissionRate", 10),
            "ivaOnCommission": True, "ownerName": "", "ownerDocument": "", "ownerBank": "",
            "ownerAccountType": "ahorros", "ownerAccountNumber": "", "ownerEmail": "", "ownerPhone": "",
            "paymentDueDay": 5, "insuranceCompany": "Ninguna",
        }
        prop = defaults | fields
        data["properties"].insert(0, prop)
        return "creado", prop

    accion, prop = _mutate(apply)
    return {"ok": True, "mensaje": f"Inmueble {prop['code']} {accion}.", "inmueble": prop}


@mcp.tool
def programar_pago(
    titulo: Annotated[str, Field(description="Concepto del pago o cobro")],
    monto: Annotated[int, Field(gt=0, description="Monto en COP")],
    fecha_vencimiento: Annotated[str, Field(description="AAAA-MM-DD")],
    categoria: Annotated[CategoryId, Field(description="Categoría contable")],
    tipo_evento: EventType = "servicio_general",
    recurrencia: Literal["ninguna", "quincenal", "mensual", "anual"] = "ninguna",
    beneficiario: Annotated[str, Field(description="A quién se paga o a quién se cobra")] = "MOAI Inmobiliaria",
    inmueble_codigo: Optional[str] = None,
    recordatorio_dias_antes: Annotated[int, Field(ge=0, le=60)] = 2,
    notas: Optional[str] = None,
) -> dict[str, Any]:
    """Programa un pago o cobro futuro en el calendario de MOAI."""
    name = INCOME_CATEGORIES.get(categoria) or EXPENSE_CATEGORIES.get(categoria, categoria)

    def apply(data: dict[str, Any]) -> dict[str, Any]:
        prop = _find_property(data, inmueble_codigo) if inmueble_codigo else None
        sp = {
            "id": _new_id("sch-mcp"), "title": titulo, "amount": monto, "category": name,
            "categoryId": categoria, "eventType": tipo_evento, "dueDate": fecha_vencimiento,
            "recurrence": recurrencia, "reminderDaysBefore": recordatorio_dias_antes,
            "status": "pendiente", "beneficiary": beneficiario,
            "propertyId": prop["id"] if prop else None,
            "propertyCode": prop["code"] if prop else inmueble_codigo, "notes": notas,
        }
        sp = {k: v for k, v in sp.items() if v is not None}
        data["scheduledPayments"].insert(0, sp)
        return sp

    sp = _mutate(apply)
    return {"ok": True, "mensaje": f"Programado '{titulo}' por {_cop(monto)} para {fecha_vencimiento}.", "pago": sp}


@mcp.tool
def ejecutar_pago_programado(
    id: Annotated[str, Field(description="id del pago programado (ver listar_pagos_programados)")],
    fecha: Annotated[Optional[str], Field(description="Fecha real del pago AAAA-MM-DD; por defecto hoy")] = None,
) -> dict[str, Any]:
    """Marca un pago programado como ejecutado y lo asienta en el libro diario. Si es recurrente, lo reprograma."""
    def apply(data: dict[str, Any]) -> Optional[dict[str, Any]]:
        sp = next((p for p in data["scheduledPayments"] if p.get("id") == id), None)
        if not sp:
            return None
        tx = _make_tx(
            type="income" if sp.get("eventType") == "cobro_canon" else "expense",
            fundType="custodia_propietarios" if sp.get("eventType") == "dispersion_propietario" else "moai_operativa",
            amount=sp["amount"], category=sp.get("categoryId", "otros_gastos"), date=fecha or _today(),
            description=sp.get("title"), propertyCode=sp.get("propertyCode"),
            recipientOrPayer=sp.get("beneficiary"), referenceNumber=f"PAG-{str(_now_ms())[-5:]}",
        )
        data["transactions"].insert(0, tx)
        rec = sp.get("recurrence", "ninguna")
        if rec in ("mensual", "anual"):
            y, m, d = (int(x) for x in sp["dueDate"].split("-"))
            if rec == "mensual":
                m += 1
                if m > 12:
                    m, y = 1, y + 1
            else:
                y += 1
            sp["dueDate"] = f"{y}-{m:02d}-{d:02d}"
            sp["status"] = "pendiente"
        elif rec == "quincenal":
            sp["dueDate"] = (datetime.strptime(sp["dueDate"], "%Y-%m-%d") + timedelta(days=15)).strftime("%Y-%m-%d")
            sp["status"] = "pendiente"
        else:
            sp["status"] = "ejecutado"
        return {"movimiento": tx, "pago": sp}

    result = _mutate(apply)
    if not result:
        return {"ok": False, "error": f"No existe el pago programado {id}."}
    return {"ok": True, **result}


@mcp.tool
def liquidar_canon(
    inmueble_codigo: Annotated[str, Field(description="Código del inmueble a liquidar")],
    confirmar: Annotated[bool, Field(description="False = solo calcula (vista previa). True = asienta los 3 movimientos.")] = False,
    reparaciones: Annotated[int, Field(ge=0, description="Reparaciones a descontar al propietario (COP)")] = 0,
    cuota_administracion: Annotated[Optional[int], Field(ge=0, description="Si se omite, usa la cuota PH del inmueble")] = None,
    canon: Annotated[Optional[int], Field(gt=0, description="Si se omite, usa el canon del inmueble")] = None,
    fecha: Annotated[Optional[str], Field(description="AAAA-MM-DD; por defecto hoy")] = None,
) -> dict[str, Any]:
    """Liquida el canon a un propietario: comisión MOAI + IVA 19%, deducciones y neto a dispersar.
    Con confirmar=True registra recaudo (custodia), comisión (caja MOAI) y dispersión (custodia)."""
    def compute(data: dict[str, Any]) -> dict[str, Any]:
        prop = _find_property(data, inmueble_codigo)
        if not prop:
            raise ValueError(f"No encontré el inmueble '{inmueble_codigo}'. Usa listar_inmuebles.")
        gross = canon or int(prop.get("monthlyRent", 0))
        rate = float(prop.get("commissionRate", 10))
        commission = round(gross * rate / 100)
        iva = round(commission * 0.19) if prop.get("ivaOnCommission", True) else 0
        admin = cuota_administracion if cuota_administracion is not None else int(prop.get("adminFee", 0))
        net = max(0, gross - commission - iva - admin - reparaciones)
        return {
            "prop": prop, "canon_bruto": gross, "porcentaje_comision": rate, "comision": commission,
            "iva": iva, "total_moai": commission + iva, "cuota_administracion": admin,
            "reparaciones": reparaciones, "neto_a_dispersar": net,
        }

    def summary(c: dict[str, Any]) -> dict[str, Any]:
        p = c["prop"]
        return {k: v for k, v in c.items() if k != "prop"} | {
            "inmueble": p.get("code"), "propietario": p.get("ownerName"),
            "cuenta": f"{p.get('ownerBank', '')} {p.get('ownerAccountType', '')} {p.get('ownerAccountNumber', '')}".strip(),
        }

    if not confirmar:
        data, _ = _read()
        data.setdefault("properties", [])
        return {"vista_previa": True, **summary(compute(data))}

    def apply(data: dict[str, Any]) -> dict[str, Any]:
        c = compute(data)
        p, day, suffix = c["prop"], fecha or _today(), str(_now_ms())[-4:]
        base = {"date": day, "propertyId": p["id"], "propertyCode": p["code"]}
        owner = p.get("ownerName", "")
        txs = [
            _make_tx(type="expense", fundType="custodia_propietarios", amount=c["neto_a_dispersar"],
                     category="dispersion_propietarios",
                     description=f"Dispersión bancaria canon neto {p['code']} a {owner}",
                     recipientOrPayer=owner, referenceNumber=f"TRF-LIQ-{suffix}", **base),
            _make_tx(type="income", fundType="moai_operativa", amount=c["total_moai"],
                     category="comision_arriendos",
                     description=f"Comisión administración {p['code']} ({c['porcentaje_comision']:g}% + IVA)",
                     recipientOrPayer="MOAI Inmobiliaria S.A.S.", referenceNumber=f"COM-LIQ-{suffix}", **base),
            _make_tx(type="income", fundType="custodia_propietarios", amount=c["canon_bruto"],
                     category="recaudo_canon", description=f"Recaudo canon {p['code']} ({owner})",
                     recipientOrPayer=owner, referenceNumber=f"REC-LIQ-{suffix}", **base),
        ]
        data["transactions"][0:0] = txs
        return summary(c) | {"movimientos_ids": [t["id"] for t in txs]}

    return {"ok": True, "asentado": True, **_mutate(apply)}


if __name__ == "__main__":
    mcp.run()
