"""
EduPlata (BolsiUni) — Conector MCP para Claude.

Permite que Claude lea y registre las finanzas de estudiante (movimientos, metas de ahorro,
pagos programados y presupuesto) en la misma base de datos que usa la app web
(tabla `eduplata_user_state` en Supabase, una fila por usuario).

Cada estudiante usa su link personal (generado en la app): https://<servidor>/mcp?key=edu_...
El conector busca al usuario por el hash SHA-256 de esa clave.

Variables de entorno:
  SUPABASE_URL                 https://<proyecto>.supabase.co
  SUPABASE_SERVICE_ROLE_KEY    clave service_role del proyecto (secreta)
  EDUPLATA_DB_FILE                 (opcional, solo pruebas locales) ruta a eduplata/data/eduplata_database.json (usuario "local")

Despliegue en Prefect Horizon: entrypoint `eduplata/mcp_server/server.py:mcp`.
"""

from __future__ import annotations

import json
import os
import random
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Annotated, Any, Callable, Literal, Optional

import hashlib

import httpx
from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from fastmcp.server.dependencies import get_http_request
from pydantic import Field

mcp = FastMCP(
    name="EduPlata - Finanzas Universitarias",
    instructions=(
        "Conector de finanzas personales de una estudiante universitaria en Colombia. "
        "Montos en pesos colombianos (COP) como enteros: '20 lucas' = 20000, 'un palo' = 1000000, "
        "'15k' = 15000. Cuando la usuaria cuente un gasto o ingreso, regístralo con "
        "registrar_movimiento eligiendo la categoría más adecuada; si falta el monto, pregunta. "
        "Después de registrar, cuenta el saldo nuevo en bolsillo."
    ),
)

# ───────────────────────────── Almacenamiento ─────────────────────────────

def _clean(value: str) -> str:
    return value.strip().strip('"').strip("'").strip()


def _normalize_url(value: str) -> str:
    """Tolera URLs pegadas sin https://, con espacios, comillas, / final o /rest/v1."""
    url = _clean(value)
    if not url:
        return ""
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    url = url.rstrip("/")
    if url.endswith("/rest/v1"):
        url = url[: -len("/rest/v1")]
    return url


SUPABASE_URL = _normalize_url(os.environ.get("SUPABASE_URL", ""))
SUPABASE_KEY = _clean(os.environ.get("SUPABASE_SERVICE_ROLE_KEY", ""))
LOCAL_FILE = os.environ.get("EDUPLATA_DB_FILE", "")


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


TABLE = "eduplata_user_state"


def _connector_key() -> Optional[str]:
    """Clave personal del link del conector: ?key=... (o cabecera X-EduPlata-Key)."""
    try:
        req = get_http_request()
    except RuntimeError:
        return None
    return _clean(req.query_params.get("key") or req.headers.get("x-eduplata-key") or "") or None


def _current_user_id() -> str:
    if not (SUPABASE_URL and SUPABASE_KEY):
        if LOCAL_FILE:
            return "local"
        raise ToolError("Conector sin configurar: define SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en Horizon.")
    key = _connector_key()
    if not key:
        raise ToolError(
            "Falta tu link personal. En la app EduPlata ve a Configuración → Conectar con Claude, "
            "genera tu link y úsalo como URL del conector en Claude."
        )
    # Sin caché: si el estudiante genera un link nuevo, el anterior deja de servir de inmediato
    digest = hashlib.sha256(key.encode()).hexdigest()
    r = httpx.get(
        f"{SUPABASE_URL}/rest/v1/{TABLE}",
        params={"connector_key_hash": f"eq.{digest}", "select": "user_id"},
        headers=_headers(),
        timeout=20,
    )
    r.raise_for_status()
    rows = r.json()
    if not rows:
        raise ToolError(
            "Este link del conector no es válido o fue reemplazado por uno nuevo. "
            "Genera tu link en la app (Configuración → Conectar con Claude) y actualízalo en Claude."
        )
    return rows[0]["user_id"]


def _read_local_all() -> dict[str, Any]:
    p = Path(LOCAL_FILE)
    if not p.exists():
        return {}
    parsed = json.loads(p.read_text("utf-8"))
    if isinstance(parsed, dict) and "users" in parsed:
        return parsed["users"]
    return {"local": {"data": parsed.get("data"), "version": parsed.get("version", 0)}}


def _read() -> tuple[dict[str, Any], int]:
    user_id = _current_user_id()
    if SUPABASE_URL and SUPABASE_KEY:
        r = httpx.get(
            f"{SUPABASE_URL}/rest/v1/{TABLE}",
            params={"user_id": f"eq.{user_id}", "select": "data,version"},
            headers=_headers(),
            timeout=20,
        )
        r.raise_for_status()
        rows = r.json()
        if not rows:
            return {}, 0
        return rows[0]["data"] or {}, int(rows[0]["version"])
    row = _read_local_all().get(user_id) or {}
    return row.get("data") or {}, int(row.get("version", 0))


def _write(data: dict[str, Any], base_version: int) -> int:
    user_id = _current_user_id()
    nxt = base_version + 1
    if SUPABASE_URL and SUPABASE_KEY:
        # La fila del usuario ya existe: se crea al generar el link del conector
        r = httpx.patch(
            f"{SUPABASE_URL}/rest/v1/{TABLE}",
            params={"user_id": f"eq.{user_id}", "version": f"eq.{base_version}"},
            headers=_headers(),
            json={"data": data, "version": nxt, "updated_at": datetime.now(timezone.utc).isoformat()},
            timeout=20,
        )
        r.raise_for_status()
        if len(r.json()) != 1:
            raise ConflictError()
        return nxt
    users = _read_local_all()
    if int((users.get(user_id) or {}).get("version", 0)) != base_version:
        raise ConflictError()
    users[user_id] = {"data": data, "version": nxt}
    Path(LOCAL_FILE).parent.mkdir(parents=True, exist_ok=True)
    Path(LOCAL_FILE).write_text(json.dumps({"users": users}, ensure_ascii=False, indent=2), "utf-8")
    return nxt


def _mutate(fn: Callable[[dict[str, Any]], Any]) -> Any:
    """Lee el estado, aplica `fn` (que modifica `data` en sitio) y guarda; reintenta si hay conflicto."""
    for _ in range(6):
        data, version = _read()
        for key in ("transactions", "goals", "scheduledPayments"):
            data.setdefault(key, [])
        result = fn(data)
        try:
            _write(data, version)
            return result
        except ConflictError:
            time.sleep(0.2 + random.random() * 0.5)
    raise RuntimeError("No se pudo guardar: la base de datos está muy ocupada. Intenta de nuevo.")


# ───────────────────────────── Utilidades ─────────────────────────────

EXPENSE_CATEGORIES = {
    "comida": "Comida (almuerzos, cafetería, tinto)",
    "transporte": "Transporte (Metro, bus, taxi, gasolina)",
    "fotocopias": "Fotocopias y útiles",
    "matricula": "Matrícula y semestre",
    "ocio": "Salidas y ocio",
    "suscripciones": "Suscripciones (Spotify, Netflix, Canva)",
    "vivienda": "Vivienda y arriendo, servicios",
    "salud": "Salud y bienestar, gimnasio",
    "otros": "Otros gastos (recargas, regalos, imprevistos)",
}
INCOME_CATEGORIES = {
    "mesada": "Mesada familiar",
    "trabajo": "Trabajo / medio tiempo / freelance / monitoría",
    "auxilio": "Beca / auxilio (Jóvenes en Acción, Renta Joven)",
    "emprendimiento": "Emprendimiento / ventas",
    "otros_ingresos": "Otros ingresos",
}
ExpenseCat = Literal["comida", "transporte", "fotocopias", "matricula", "ocio", "suscripciones", "vivienda", "salud", "otros"]
CategoryId = Literal[
    "comida", "transporte", "fotocopias", "matricula", "ocio", "suscripciones", "vivienda", "salud", "otros",
    "mesada", "trabajo", "auxilio", "emprendimiento", "otros_ingresos",
]
BOGOTA = timezone(timedelta(hours=-5))
EMPTY_LIMITS = {k: 0 for k in EXPENSE_CATEGORIES}


def _today() -> str:
    return datetime.now(BOGOTA).strftime("%Y-%m-%d")


def _now_ms() -> int:
    return int(time.time() * 1000)


def _new_id(prefix: str) -> str:
    return f"{prefix}-{_now_ms()}-{random.randint(1000, 9999)}"


def _cop(n: float) -> str:
    return ("-" if n < 0 else "") + "$" + f"{abs(round(n)):,}".replace(",", ".")


def _balance(txs: list[dict[str, Any]]) -> int:
    return sum(int(t.get("amount", 0)) * (1 if t.get("type") == "income" else -1) for t in txs)


def _next_date(due: str, recurrence: str) -> str:
    d = datetime.strptime(due, "%Y-%m-%d").date()
    if recurrence == "semanal":
        return (d + timedelta(days=7)).isoformat()
    # mensual: igual que JS Date.setMonth (si el día no existe, se desborda al mes siguiente)
    y, m = (d.year + 1, 1) if d.month == 12 else (d.year, d.month + 1)
    try:
        return date(y, m, d.day).isoformat()
    except ValueError:
        first = date(y, m, 1)
        return (first + timedelta(days=d.day - 1)).isoformat()


def _find_goal(data: dict[str, Any], meta: str) -> Optional[dict[str, Any]]:
    q = meta.strip().lower()
    goals = data.get("goals", [])
    exact = [g for g in goals if g.get("id", "").lower() == q or g.get("title", "").lower() == q]
    if exact:
        return exact[0]
    partial = [g for g in goals if q in g.get("title", "").lower()]
    return partial[0] if len(partial) == 1 else None


# ───────────────────────────── Lectura ─────────────────────────────

@mcp.tool(annotations={"readOnlyHint": True})
def resumen(
    mes: Annotated[Optional[str], Field(description="Mes AAAA-MM; por defecto el actual")] = None,
) -> dict[str, Any]:
    """Saldo en bolsillo, ingresos y gastos del mes, gasto por categoría frente al presupuesto, metas y pagos próximos."""
    data, _ = _read()
    txs = data.get("transactions", [])
    mes = mes or _today()[:7]
    del_mes = [t for t in txs if str(t.get("date", "")).startswith(mes)]
    ingresos = sum(int(t["amount"]) for t in del_mes if t.get("type") == "income")
    gastos = sum(int(t["amount"]) for t in del_mes if t.get("type") == "expense")
    budget = data.get("budget") or {}
    limits = budget.get("categoryLimits") or {}
    por_cat: dict[str, dict[str, int]] = {}
    for t in del_mes:
        if t.get("type") == "expense":
            c = t.get("category", "otros")
            por_cat.setdefault(c, {"gastado": 0, "limite": int(limits.get(c, 0))})
            por_cat[c]["gastado"] += int(t["amount"])
    limite = (datetime.now(BOGOTA) + timedelta(days=15)).strftime("%Y-%m-%d")
    proximos = sorted(
        [p for p in data.get("scheduledPayments", []) if not p.get("isPaid") and p.get("dueDate", "") <= limite],
        key=lambda p: p.get("dueDate", ""),
    )
    return {
        "saldo_en_bolsillo": _balance(txs),
        "mes": mes,
        "ingresos_mes": ingresos,
        "gastos_mes": gastos,
        "presupuesto_mensual": int(budget.get("monthlyExpenseLimit", 0)),
        "gastos_por_categoria": por_cat,
        "metas": [
            {"id": g["id"], "meta": g.get("title"), "ahorrado": g.get("currentAmount"), "objetivo": g.get("targetAmount"), "fecha_limite": g.get("deadline")}
            for g in data.get("goals", [])
        ],
        "pagos_proximos_15_dias": [
            {k: p.get(k) for k in ("id", "description", "amount", "dueDate", "recurrence")} for p in proximos
        ],
    }


@mcp.tool(annotations={"readOnlyHint": True})
def listar_movimientos(
    desde: Annotated[Optional[str], Field(description="AAAA-MM-DD")] = None,
    hasta: Annotated[Optional[str], Field(description="AAAA-MM-DD")] = None,
    tipo: Optional[Literal["ingreso", "gasto"]] = None,
    categoria: Optional[CategoryId] = None,
    buscar: Annotated[Optional[str], Field(description="Texto en la nota")] = None,
    limite: Annotated[int, Field(ge=1, le=500)] = 50,
) -> list[dict[str, Any]]:
    """Lista movimientos, del más reciente al más antiguo."""
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
        if buscar and buscar.lower() not in str(t.get("note", "")).lower():
            continue
        out.append(t)
        if len(out) >= limite:
            break
    return out


@mcp.tool(annotations={"readOnlyHint": True})
def listar_pagos_programados(incluir_pagados: bool = False) -> list[dict[str, Any]]:
    """Lista pagos programados (por defecto solo los pendientes), ordenados por fecha."""
    data, _ = _read()
    pagos = [p for p in data.get("scheduledPayments", []) if incluir_pagados or not p.get("isPaid")]
    return sorted(pagos, key=lambda p: p.get("dueDate", ""))


@mcp.tool(annotations={"readOnlyHint": True})
def listar_categorias() -> dict[str, dict[str, str]]:
    """Catálogo de categorías (id → descripción) de gastos e ingresos."""
    return {"gastos": EXPENSE_CATEGORIES, "ingresos": INCOME_CATEGORIES}


# ───────────────────────────── Escritura ─────────────────────────────

@mcp.tool
def registrar_movimiento(
    tipo: Literal["ingreso", "gasto"],
    monto: Annotated[int, Field(gt=0, description="Monto en COP, entero (ej: 15000)")],
    categoria: Annotated[CategoryId, Field(description="Gastos: comida, transporte, fotocopias, matricula, ocio, suscripciones, vivienda, salud, otros. Ingresos: mesada, trabajo, auxilio, emprendimiento, otros_ingresos")],
    nota: Annotated[Optional[str], Field(description="Descripción corta, ej: 'Almuerzo en la U'")] = None,
    fecha: Annotated[Optional[str], Field(description="AAAA-MM-DD; por defecto hoy")] = None,
) -> dict[str, Any]:
    """Registra un gasto o ingreso. Aparece en la app web en unos segundos."""
    if (tipo == "gasto") != (categoria in EXPENSE_CATEGORIES):
        return {"ok": False, "error": f"La categoría '{categoria}' no corresponde a un {tipo}. Usa listar_categorias."}

    def apply(data: dict[str, Any]) -> tuple[dict[str, Any], int]:
        tx = {
            "id": _new_id("tx-claude"), "type": "income" if tipo == "ingreso" else "expense",
            "amount": monto, "category": categoria, "date": fecha or _today(),
            "note": nota or "", "createdAt": _now_ms(),
        }
        data["transactions"].insert(0, tx)
        return tx, _balance(data["transactions"])

    tx, saldo = _mutate(apply)
    return {"ok": True, "mensaje": f"{tipo.capitalize()} de {_cop(monto)} registrado. Saldo en bolsillo: {_cop(saldo)}.", "movimiento": tx, "saldo_en_bolsillo": saldo}


@mcp.tool(annotations={"destructiveHint": True})
def eliminar_movimiento(id: Annotated[str, Field(description="id del movimiento (ver listar_movimientos)")]) -> dict[str, Any]:
    """Elimina un movimiento. Confirma con la usuaria antes."""
    def apply(data: dict[str, Any]) -> Optional[dict[str, Any]]:
        for i, t in enumerate(data["transactions"]):
            if t.get("id") == id:
                return data["transactions"].pop(i)
        return None

    removed = _mutate(apply)
    return {"ok": bool(removed), "eliminado": removed} if removed else {"ok": False, "error": f"No existe {id}."}


@mcp.tool
def crear_meta_ahorro(
    titulo: Annotated[str, Field(description="Ej: 'Portátil nuevo'")],
    monto_objetivo: Annotated[int, Field(gt=0)],
    fecha_limite: Annotated[str, Field(description="AAAA-MM-DD")],
    ahorrado_actual: Annotated[int, Field(ge=0)] = 0,
    emoji: str = "🎯",
    notas: Optional[str] = None,
) -> dict[str, Any]:
    """Crea una meta de ahorro."""
    def apply(data: dict[str, Any]) -> dict[str, Any]:
        g = {
            "id": _new_id("goal-claude"), "title": titulo, "targetAmount": monto_objetivo,
            "currentAmount": ahorrado_actual, "deadline": fecha_limite, "emoji": emoji,
            "color": "#10b981", "createdAt": _now_ms(),
        }
        if notas:
            g["notes"] = notas
        data["goals"].append(g)
        return g

    return {"ok": True, "meta": _mutate(apply)}


@mcp.tool
def abonar_a_meta(
    meta: Annotated[str, Field(description="Nombre o id de la meta")],
    monto: Annotated[int, Field(gt=0)],
) -> dict[str, Any]:
    """Suma un abono a una meta de ahorro."""
    def apply(data: dict[str, Any]) -> Optional[dict[str, Any]]:
        g = _find_goal(data, meta)
        if g:
            g["currentAmount"] = int(g.get("currentAmount", 0)) + monto
        return g

    g = _mutate(apply)
    if not g:
        return {"ok": False, "error": f"No encontré una única meta '{meta}'. Revisa resumen()."}
    return {"ok": True, "mensaje": f"Abonado {_cop(monto)} a '{g['title']}': {_cop(g['currentAmount'])} de {_cop(g['targetAmount'])}.", "meta": g}


@mcp.tool
def programar_pago(
    descripcion: Annotated[str, Field(description="Ej: 'Arriendo pieza', 'Spotify'")],
    monto: Annotated[int, Field(gt=0)],
    fecha_vencimiento: Annotated[str, Field(description="AAAA-MM-DD")],
    categoria: ExpenseCat = "otros",
    recurrencia: Literal["ninguna", "semanal", "mensual"] = "ninguna",
    recordatorio_dias_antes: Annotated[int, Field(ge=0, le=30)] = 1,
) -> dict[str, Any]:
    """Programa un pago futuro (aparece en el calendario de la app)."""
    def apply(data: dict[str, Any]) -> dict[str, Any]:
        p = {
            "id": _new_id("pay-claude"), "description": descripcion, "amount": monto,
            "category": EXPENSE_CATEGORIES[categoria].split(" (")[0], "categoryId": categoria,
            "dueDate": fecha_vencimiento, "recurrence": recurrencia,
            "reminderDaysBefore": recordatorio_dias_antes, "isPaid": False, "createdAt": _now_ms(),
        }
        data["scheduledPayments"].append(p)
        return p

    return {"ok": True, "pago": _mutate(apply)}


@mcp.tool
def marcar_pago_hecho(id: Annotated[str, Field(description="id del pago programado")]) -> dict[str, Any]:
    """Marca un pago programado como pagado y lo registra como gasto de hoy. Si es recurrente, crea el siguiente."""
    def apply(data: dict[str, Any]) -> Optional[dict[str, Any]]:
        p = next((x for x in data["scheduledPayments"] if x.get("id") == id), None)
        if not p:
            return None
        hoy = _today()
        tx = {
            "id": _new_id("tx-pay"), "type": "expense", "amount": p["amount"],
            "category": p.get("categoryId") or "otros", "date": hoy,
            "note": f"Pago: {p.get('description', '')}", "createdAt": _now_ms(),
        }
        data["transactions"].insert(0, tx)
        if p.get("recurrence") in ("mensual", "semanal"):
            nxt = p | {"id": _new_id("pay"), "dueDate": _next_date(p["dueDate"], p["recurrence"]), "isPaid": False, "createdAt": _now_ms()}
            nxt.pop("paidAt", None)
            data["scheduledPayments"] = [x for x in data["scheduledPayments"] if x.get("id") != id] + [nxt]
            return {"movimiento": tx, "siguiente_pago": nxt}
        p["isPaid"], p["paidAt"] = True, hoy
        return {"movimiento": tx, "pago": p}

    r = _mutate(apply)
    return {"ok": True, **r} if r else {"ok": False, "error": f"No existe el pago {id}."}


@mcp.tool
def configurar_presupuesto(
    limite_gasto_mensual: Annotated[Optional[int], Field(ge=0)] = None,
    meta_ingresos_mensual: Annotated[Optional[int], Field(ge=0)] = None,
    limites_por_categoria: Annotated[Optional[dict[ExpenseCat, int]], Field(description="Ej: {'comida': 400000, 'ocio': 100000}")] = None,
) -> dict[str, Any]:
    """Ajusta el presupuesto mensual (solo cambia lo que se envíe)."""
    def apply(data: dict[str, Any]) -> dict[str, Any]:
        b = data.get("budget") or {"monthlyIncomeTarget": 0, "monthlyExpenseLimit": 0, "categoryLimits": dict(EMPTY_LIMITS)}
        b.setdefault("categoryLimits", dict(EMPTY_LIMITS))
        if limite_gasto_mensual is not None:
            b["monthlyExpenseLimit"] = limite_gasto_mensual
        if meta_ingresos_mensual is not None:
            b["monthlyIncomeTarget"] = meta_ingresos_mensual
        for k, v in (limites_por_categoria or {}).items():
            b["categoryLimits"][k] = int(v)
        data["budget"] = b
        return b

    return {"ok": True, "presupuesto": _mutate(apply)}


if __name__ == "__main__":
    mcp.run()
