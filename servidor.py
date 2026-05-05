#!/usr/bin/env python3
"""
Dashboard Operativo de Distribución — Servidor v3 (Seguro)
Ejecutar: python servidor.py
Requiere: pip install fastapi uvicorn pydantic
"""

import json
import os
import re
import time
import threading
from datetime import datetime, date, timedelta
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen, Request as URLRequest

import uvicorn
from fastapi import FastAPI, HTTPException, Request, Query
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ValidationError
from typing import List, Optional

# ─────────────────────────────────────────
#  CONFIGURACIÓN
# ─────────────────────────────────────────
def cargar_env():
    env = {}
    env_path = Path(__file__).parent / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    return env

_env = cargar_env()

TMS_API_KEY  = _env.get("TMS_API_KEY", "")
TMS_BASE_URL = _env.get("TMS_BASE_URL", "https://tms.com/api")
PUERTO             = int(_env.get("PUERTO", 8080))
ALLOWED_ORIGINS    = _env.get("ALLOWED_ORIGINS", "http://localhost:8080,http://127.0.0.1:8080")  # orígenes separados por coma
CACHE_VEHICULOS    = 30
CACHE_ORDENES      = 120
RATE_LIMIT_RPM     = 60

DIR_BASE         = Path(__file__).parent
AGENDA_FILE      = DIR_BASE / "agenda.json"
AGENDA_PROX_FILE = DIR_BASE / "agenda_prox.json"
AGENDA_MES_FILE  = DIR_BASE / "agenda_mes.json"
HIST_DIR         = DIR_BASE / "historial"

# ─────────────────────────────────────────
#  UTILIDADES DE SEGURIDAD
# ─────────────────────────────────────────
FECHA_REGEX = re.compile(r'^\d{4}-\d{2}-\d{2}$')

def es_fecha_valida(fecha_str: str) -> bool:
    return bool(FECHA_REGEX.match(fecha_str))

# ─────────────────────────────────────────
#  CACHÉ EN MEMORIA
# ─────────────────────────────────────────
_cache: dict = {}
_cache_lock = threading.Lock()

def cache_get(key):
    with _cache_lock:
        e = _cache.get(key)
        if e and (time.time() - e["ts"]) < e["ttl"]:
            return e["data"]
    return None

def cache_set(key, data, ttl):
    with _cache_lock:
        _cache[key] = {"data": data, "ts": time.time(), "ttl": ttl}

# ─────────────────────────────────────────
#  RATE LIMITING
# ─────────────────────────────────────────
_rate: dict = {}
_rate_lock = threading.Lock()

def rate_ok(ip: str) -> bool:
    now = time.time()
    with _rate_lock:
        _rate.setdefault(ip, [])
        _rate[ip] = [t for t in _rate[ip] if now - t < 60]
        if len(_rate[ip]) >= RATE_LIMIT_RPM:
            return False
        _rate[ip].append(now)
    return True

# ─────────────────────────────────────────
#  TMS API (segura)
# ─────────────────────────────────────────
def qm_get(path: str, params: dict = None) -> Optional[dict]:
    """
    Realiza una petición GET a la API del TMS usando parámetros codificados.
    """
    url = f"{TMS_BASE_URL}/{path}"
    if params:
        url += "?" + urlencode(params)
    req = URLRequest(url, headers={
        "accept": "application/json",
        "x-saas-apikey": TMS_API_KEY
    })
    try:
        with urlopen(req, timeout=10) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        print(f"  [QM error] {path}: {e}")
        return None

def get_vehiculos():
    cached = cache_get("vehiculos")
    if cached:
        return cached
    data = qm_get("vehicles")
    if data and "data" in data:
        result = [v for v in data["data"] if v.get("type") in ("VEHICLE", "VIRTUAL")]
        cache_set("vehiculos", result, CACHE_VEHICULOS)
        return result
    return cache_get("vehiculos") or []

def get_ordenes_hoy():
    cached = cache_get("ordenes_hoy")
    if cached:
        return cached
    hoy = date.today().strftime("%Y-%m-%d")
    data = qm_get("orders/search", {"from": hoy, "to": hoy, "limit": 1000})
    if data and "data" in data:
        cache_set("ordenes_hoy", data["data"], CACHE_ORDENES)
        return data["data"]
    return cache_get("ordenes_hoy") or []

def get_ordenes_fecha(fecha_str: str):
    cached = cache_get(f"ordenes_{fecha_str}")
    if cached:
        return cached
    data = qm_get("orders/search", {"from": fecha_str, "to": fecha_str, "limit": 1000})
    if data and "data" in data:
        cache_set(f"ordenes_{fecha_str}", data["data"], 3600)
        return data["data"]
    return []

def get_drivers():
    cached = cache_get("drivers")
    if cached:
        return cached
    data = qm_get("drivers")
    if data and "data" in data:
        result = {d["_id"]: d["name"].strip() for d in data["data"] if d.get("name")}
        cache_set("drivers", result, 3600)
        return result
    return cache_get("drivers") or {}

def get_rutas_hoy():
    cached = cache_get("rutas_hoy")
    if cached:
        return cached
    hoy = date.today().strftime("%Y-%m-%d")
    data = qm_get("consolidated-routes/search", {"from": hoy, "to": hoy, "limit": 100})
    if data and "data" in data:
        cache_set("rutas_hoy", data["data"], 120)
        return data["data"]
    return cache_get("rutas_hoy") or []

def get_rutas_fecha(fecha_str: str):
    cached = cache_get(f"rutas_{fecha_str}")
    if cached:
        return cached
    data = qm_get("consolidated-routes/search", {"from": fecha_str, "to": fecha_str, "limit": 100})
    if data and "data" in data:
        cache_set(f"rutas_{fecha_str}", data["data"], 3600)
        return data["data"]
    return []

# ── Funciones de procesamiento (sin cambios relevantes) ─────────────────────
def color_movil(v):
    for p in v.get("parameters", []):
        if p.get("parameterName") == "COLOR_MAQUINA_CHAMELEON":
            return p.get("parameterValue", "#3b82f6")
    return "#3b82f6"

def estado_movil_con_ruta(v, ruta_status, tiene_ordenes=False):
    tel = v.get("telemetry", {})
    ign = tel.get("ignition") == "1"
    spd = int(float(tel.get("speed", 0) or 0))
    if ruta_status == "overdue":
        return "retrasado"
    if ruta_status == "in_progress":
        return "en-ruta" if (ign and spd > 2) else "detenido"
    if ruta_status == "finished":
        return "finalizado"
    if ign and spd > 2:
        return "en-ruta"
    if ign:
        return "detenido"
    if tiene_ordenes:
        return "detenido"
    return "inactivo"

def _build_evolucion(ordenes):
    horas = {str(h).zfill(2): {"entregados": 0, "no_entregados": 0, "parciales": 0} for h in range(6, 22)}
    for o in ordenes:
        s = (o.get("orderStatus") or {}).get("status")
        ts = o.get("updatedAt") or o.get("createdAt") or ""
        if not ts:
            continue
        try:
            hora = datetime.fromisoformat(ts.replace("Z", "+00:00")).strftime("%H")
            if hora in horas:
                if s == 2:
                    horas[hora]["entregados"] += 1
                elif s == 1:
                    horas[hora]["parciales"] += 1
                elif s == 0:
                    horas[hora]["no_entregados"] += 1
        except:
            pass
    acum, result = 0, []
    for h, v in sorted(horas.items()):
        acum += v["entregados"]
        result.append({
            "hora": h + ":00",
            "entregados": v["entregados"],
            "no_entregados": v["no_entregados"],
            "parciales": v["parciales"],
            "acumulado": acum
        })
    return result

def _build_alertas(moviles, ordenes):
    alertas = []
    now = datetime.now()
    for m in moviles:
        if m["estado"] == "retrasado":
            alertas.append({
                "tipo": "danger",
                "titulo": f"Móvil retrasado: {m['nombre']}",
                "detalle": f"Chofer: {m['chofer']} — {m.get('no_entregado', 0)} sin entregar",
                "ts": now.strftime("%H:%M")
            })
        elif m["estado"] == "detenido" and m.get("total", 0) > 0 and m.get("pendiente", 0) > 0:
            alertas.append({
                "tipo": "warning",
                "titulo": f"Móvil detenido con pendientes: {m['nombre']}",
                "detalle": f"{m['pendiente']} pedidos pendientes",
                "ts": now.strftime("%H:%M")
            })
    total = len(ordenes)
    no_ent = sum(1 for o in ordenes if (o.get("orderStatus") or {}).get("status") == 0)
    if total > 0 and no_ent / total > 0.2:
        alertas.append({
            "tipo": "danger",
            "titulo": "Alta tasa de no entregados",
            "detalle": f"{no_ent} de {total} ({round(no_ent / total * 100)}%)",
            "ts": now.strftime("%H:%M")
        })
    return alertas[:10]

def procesar_dashboard():
    vehiculos = get_vehiculos()
    ordenes   = get_ordenes_hoy()
    drivers   = get_drivers()
    rutas     = get_rutas_hoy()
    device_map = {v["_id"]: v.get("name", "") for v in vehiculos}

    ruta_map = {}
    for r in rutas:
        did = r.get("deviceId")
        if not did:
            continue
        if did not in ruta_map or r.get("startDate", "") >= ruta_map[did].get("startDate", ""):
            ruta_map[did] = {
                "driverId": r.get("driverId"),
                "status": r.get("status", ""),
                "waypoints": r.get("waypoints", []),
                "routeId": r.get("_id"),
                "startDate": r.get("startDate", "")
            }

    movil_stats = {}
    for o in ordenes:
        did = o.get("assignedDeviceId")
        if not did:
            continue
        nombre = device_map.get(did, f"Dev:{did}")
        movil_stats.setdefault(nombre, {"total": 0, "entregado": 0, "pendiente": 0, "parcial": 0, "no_entregado": 0})
        movil_stats[nombre]["total"] += 1
        s = (o.get("orderStatus") or {}).get("status")
        if s == 2:
            movil_stats[nombre]["entregado"] += 1
        elif s == 1:
            movil_stats[nombre]["parcial"] += 1
        elif s == 0:
            movil_stats[nombre]["no_entregado"] += 1
        else:
            movil_stats[nombre]["pendiente"] += 1

    moviles = []
    for v in vehiculos:
        vid = v["_id"]
        n = v.get("name", "")
        st = movil_stats.get(n, {})
        tel = v.get("telemetry", {})
        ruta = ruta_map.get(vid, {})
        driver_id = ruta.get("driverId")
        nombre_chofer = drivers.get(driver_id, "").strip() if driver_id else ""
        if not nombre_chofer:
            for c in v.get("vehicleConstraints", []):
                if c.get("constraintName") == "selectChofer":
                    nombre_chofer = drivers.get(c.get("value"), "").strip()
                    break
        if not nombre_chofer:
            nombre_chofer = "Sin asignar"
        tiene_ordenes = st.get("total", 0) > 0
        estado = estado_movil_con_ruta(v, ruta.get("status"), tiene_ordenes)
        moviles.append({
            "id": vid,
            "nombre": n,
            "chofer": nombre_chofer,
            "patente": v.get("licensePlate", ""),
            "estado": estado,
            "ruta_status": ruta.get("status", ""),
            "color": color_movil(v),
            "velocidad": int(float(tel.get("speed", 0) or 0)),
            "ignicion": tel.get("ignition") == "1",
            "total": st.get("total", 0),
            "entregado": st.get("entregado", 0),
            "pendiente": st.get("pendiente", 0),
            "parcial": st.get("parcial", 0),
            "no_entregado": st.get("no_entregado", 0)
        })

    total = len(ordenes)
    entregados = sum(1 for o in ordenes if (o.get("orderStatus") or {}).get("status") == 2)
    parciales = sum(1 for o in ordenes if (o.get("orderStatus") or {}).get("status") == 1)
    no_entregados = sum(1 for o in ordenes if (o.get("orderStatus") or {}).get("status") == 0)
    pendientes = total - entregados - parciales - no_entregados
    pct = round(entregados / total * 100) if total else 0
    activos = sum(1 for m in moviles if m["estado"] != "inactivo")

    cli_map = {}
    for o in ordenes:
        label = o.get("label") or "Sin nombre"
        s = (o.get("orderStatus") or {}).get("status")
        cli_map.setdefault(label, {"total": 0, "entregado": 0, "pendiente": 0, "parcial": 0, "no_entregado": 0})
        cli_map[label]["total"] += 1
        if s == 2:
            cli_map[label]["entregado"] += 1
        elif s == 1:
            cli_map[label]["parcial"] += 1
        elif s == 0:
            cli_map[label]["no_entregado"] += 1
        else:
            cli_map[label]["pendiente"] += 1

    def est_cli(c):
        if c["no_entregado"] > 0:
            return "demorado"
        if c["pendiente"] > 0:
            return "pendiente"
        if c["parcial"] > 0:
            return "parcial"
        return "completado"

    clientes = sorted(
        [{"nombre": k, **v, "estado": est_cli(v)} for k, v in cli_map.items()],
        key=lambda x: x["total"],
        reverse=True
    )[:15]

    mapa_vehiculos = []
    for v in vehiculos:
        lat = v.get("latitude")
        lng = v.get("longitude")
        if not lat or not lng:
            continue
        vid = v["_id"]
        tel = v.get("telemetry", {})
        ruta = ruta_map.get(vid, {})
        driver_id = ruta.get("driverId")
        nombre_chofer = drivers.get(driver_id, "").strip() if driver_id else ""
        if not nombre_chofer:
            for c in v.get("vehicleConstraints", []):
                if c.get("constraintName") == "selectChofer":
                    nombre_chofer = drivers.get(c.get("value"), "").strip()
                    break
        if not nombre_chofer:
            nombre_chofer = "Sin asignar"
        mapa_vehiculos.append({
            "id": vid,
            "nombre": v.get("name", ""),
            "chofer": nombre_chofer,
            "patente": v.get("licensePlate", ""),
            "lat": float(lat),
            "lng": float(lng),
            "color": color_movil(v),
            "velocidad": int(float(tel.get("speed", 0) or 0)),
            "ignicion": tel.get("ignition") == "1",
            "curso": int(float(tel.get("course", 0) or 0)),
            "estado": estado_movil_con_ruta(v, ruta.get("status")),
            "timestamp": v.get("locationTimestamp", "")
        })

    mapa_rutas = []
    for r in rutas:
        did = r.get("deviceId")
        color = "#3b82f6"
        nombre_movil = device_map.get(did, "")
        for v in vehiculos:
            if v["_id"] == did:
                color = color_movil(v)
                break
        wps_sorted = sorted(r.get("waypoints", []), key=lambda w: w.get("visitOrder", 0))
        puntos = []
        for wp in wps_sorted:
            lat_wp = wp.get("latitude")
            lng_wp = wp.get("longitude")
            if not lat_wp or not lng_wp:
                continue
            st_wp = wp.get("status") or {}
            s_wp = st_wp.get("status") if isinstance(st_wp, dict) else None
            visited = wp.get("visited", False)
            cliente_wp = ""
            for act in wp.get("activities", []):
                for ord_ in act.get("orders", []):
                    if ord_.get("label"):
                        cliente_wp = ord_["label"]
                        break
                if cliente_wp:
                    break
            hora_visita = ""
            if wp.get("visitedAt"):
                try:
                    hora_visita = datetime.fromisoformat(wp["visitedAt"].replace("Z", "+00:00")).strftime("%H:%M")
                except:
                    pass
            puntos.append({
                "lat": float(lat_wp),
                "lng": float(lng_wp),
                "visitado": visited,
                "estado": s_wp,
                "cliente": cliente_wp,
                "hora": hora_visita,
                "orden": wp.get("visitOrder", 0)
            })
        if puntos:
            mapa_rutas.append({
                "deviceId": did,
                "nombre": nombre_movil,
                "color": color,
                "status": r.get("status", ""),
                "puntos": puntos
            })

    return {
        "kpis": {
            "total": total,
            "entregados": entregados,
            "pendientes": pendientes,
            "parciales": parciales,
            "no_entregados": no_entregados,
            "pct": pct,
            "activos": activos,
            "total_moviles": len(vehiculos)
        },
        "moviles": moviles,
        "clientes": clientes,
        "mapa": mapa_vehiculos,
        "rutas": mapa_rutas,
        "evolucion": _build_evolucion(ordenes),
        "alertas": _build_alertas(moviles, ordenes),
        "timestamp": datetime.now().strftime("%H:%M:%S"),
        "fecha": date.today().strftime("%d/%m/%Y")
    }

# ─────────────────────────────────────────
#  HISTÓRICO (usa fechas validadas)
# ─────────────────────────────────────────
def dias_anteriores_semana():
    hoy = date.today()
    lunes = hoy - timedelta(days=hoy.weekday())
    ayer = hoy - timedelta(days=1)
    dias = []
    d = lunes
    while d <= ayer:
        dias.append(d.isoformat())
        d += timedelta(days=1)
    return dias

def procesar_historico_agenda(fecha_str: str):
    # Asume que fecha_str ya está validada
    ordenes = get_ordenes_fecha(fecha_str)
    vehiculos = get_vehiculos()
    drivers = get_drivers()
    device_map = {v["_id"]: v.get("name", "") for v in vehiculos}
    vehicle_chofer = {}
    for v in vehiculos:
        for c in v.get("vehicleConstraints", []):
            if c.get("constraintName") == "selectChofer":
                vehicle_chofer[v["_id"]] = drivers.get(c.get("value"), "").strip()
                break
    rutas_dia = get_rutas_fecha(fecha_str)
    ruta_driver_map = {
        r.get("deviceId"): drivers.get(r.get("driverId"), "").strip()
        for r in rutas_dia
        if r.get("deviceId") and r.get("driverId")
    }

    def estado_orden(s):
        if s == 2:
            return "Entregado"
        if s == 1:
            return "Parcial"
        if s == 0:
            return "No entregado"
        return "Reprogramado"

    grupos = {}
    for o in ordenes:
        did = o.get("assignedDeviceId", "")
        label = o.get("label") or "Sin nombre"
        s = (o.get("orderStatus") or {}).get("status")
        movil = device_map.get(did, "")
        chofer = ruta_driver_map.get(did, "") or vehicle_chofer.get(did, "") or "Sin asignar"
        zona = o.get("zone") or o.get("sector") or o.get("city") or ""
        key = (label, movil)
        if key not in grupos:
            grupos[key] = {
                "cliente": label,
                "ciudad": o.get("city", "") or o.get("address", "") or "",
                "zona": zona,
                "chofer": chofer,
                "movil": movil,
                "estado": estado_orden(s)
            }
        else:
            prio = {"No entregado": 0, "Parcial": 1, "Reprogramado": 2, "Entregado": 3}
            nuevo = estado_orden(s)
            if prio.get(nuevo, 3) < prio.get(grupos[key]["estado"], 3):
                grupos[key]["estado"] = nuevo
    return sorted(grupos.values(), key=lambda x: x["cliente"])

# ─────────────────────────────────────────
#  AGENDA (CRUD con archivos JSON)
# ─────────────────────────────────────────
DIAS_BASE = [
    {"dia": "Lunes", "corto": "LUN"},
    {"dia": "Martes", "corto": "MAR"},
    {"dia": "Miércoles", "corto": "MIÉ"},
    {"dia": "Jueves", "corto": "JUE"},
    {"dia": "Viernes", "corto": "VIE"},
    {"dia": "Sábado", "corto": "SÁB"}
]

def agenda_leer():
    if AGENDA_FILE.exists():
        try:
            return json.loads(AGENDA_FILE.read_text(encoding="utf-8"))
        except:
            pass
    return [{"dia": d["dia"], "corto": d["corto"], "entregas": []} for d in DIAS_BASE]

def agenda_guardar(data):
    AGENDA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

def agenda_prox_leer():
    if AGENDA_PROX_FILE.exists():
        try:
            return json.loads(AGENDA_PROX_FILE.read_text(encoding="utf-8"))
        except:
            pass
    hoy = date.today()
    dias_hasta = (7 - hoy.weekday()) % 7
    if dias_hasta == 0:
        dias_hasta = 7
    prox_lunes = hoy + timedelta(days=dias_hasta)
    dias = [{"dia": d["dia"], "corto": d["corto"], "entregas": []} for d in DIAS_BASE]
    for i, dia in enumerate(dias):
        dia["fecha"] = (prox_lunes + timedelta(days=i)).isoformat()
    return dias

def agenda_prox_guardar(data):
    AGENDA_PROX_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

def agenda_mes_leer(year: int, month: int):
    key = f"{year}-{str(month).zfill(2)}"
    if AGENDA_MES_FILE.exists():
        try:
            data = json.loads(AGENDA_MES_FILE.read_text(encoding="utf-8"))
            return data.get(key, {})
        except:
            pass
    return {}

def agenda_mes_guardar(year: int, month: int, data: dict):
    key = f"{year}-{str(month).zfill(2)}"
    all_data = {}
    if AGENDA_MES_FILE.exists():
        try:
            all_data = json.loads(AGENDA_MES_FILE.read_text(encoding="utf-8"))
        except:
            pass
    all_data[key] = data
    AGENDA_MES_FILE.write_text(json.dumps(all_data, ensure_ascii=False, indent=2), encoding="utf-8")

def historial_snap():
    HIST_DIR.mkdir(exist_ok=True)
    snap = procesar_dashboard()
    (HIST_DIR / f"{date.today().isoformat()}.json").write_text(
        json.dumps(snap, ensure_ascii=False, indent=2), encoding="utf-8"
    )

def historial_listar():
    if not HIST_DIR.exists():
        return []
    return sorted([f.stem for f in HIST_DIR.glob("*.json")], reverse=True)

def historial_leer(fecha):
    f = HIST_DIR / f"{fecha}.json"
    if not f.exists():
        return None
    return json.loads(f.read_text(encoding="utf-8"))

# ─────────────────────────────────────────
#  MODELOS Pydantic para validación de POST
# ─────────────────────────────────────────
class EntregaItem(BaseModel):
    cliente: Optional[str] = ""
    chofer: Optional[str] = ""
    movil: Optional[str] = ""
    zona: Optional[str] = ""
    hora: Optional[str] = ""
    estado: Optional[str] = "Programado"

class DiaAgenda(BaseModel):
    dia: str
    corto: str
    entregas: List[EntregaItem] = []

class AgendaPayload(BaseModel):
    data: List[DiaAgenda]

class AgendaMesPayload(BaseModel):
    year: int
    month: int
    data: dict  # día -> lista de entregas

# ─────────────────────────────────────────
#  FASTAPI
# ─────────────────────────────────────────
app = FastAPI(title="Monitor Distribución", docs_url=None, redoc_url=None)

# CORS configurable
origins = [origin.strip() for origin in ALLOWED_ORIGINS.split(",") if origin.strip()]
if not origins:
    origins = ["*"]  # si no se define, permite todo (menos seguro)

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def rate_limit_mw(request: Request, call_next):
    if request.url.path.startswith("/api/"):
        if not rate_ok(request.client.host):
            return JSONResponse({"error": "Demasiadas solicitudes"}, status_code=429)
    return await call_next(request)

# ── Endpoints ────────────────────────────────────────────────────────────────
@app.get("/api/dashboard")
async def api_dashboard():
    try:
        return procesar_dashboard()
    except Exception as e:
        # No exponer el error interno
        print(f"Error en dashboard: {e}")
        raise HTTPException(500, "Error interno del servidor")

@app.get("/api/agenda")
async def api_agenda_get():
    return {"data": agenda_leer()}

@app.post("/api/agenda")
async def api_agenda_post(payload: AgendaPayload):
    try:
        # payload.data es una lista de DiaAgenda, la convertimos a dict para guardar
        # pero nuestro archivo espera exactamente esa estructura, así que podemos serializar directamente
        agenda_guardar(payload.model_dump()["data"])
        try:
            historial_snap()
        except:
            pass
        return {"ok": True, "msg": "Agenda guardada"}
    except ValidationError as e:
        raise HTTPException(400, detail=f"Datos inválidos: {e}")

@app.get("/api/agenda/prox")
async def api_agenda_prox_get():
    return {"data": agenda_prox_leer()}

@app.post("/api/agenda/prox")
async def api_agenda_prox_post(payload: AgendaPayload):
    try:
        agenda_prox_guardar(payload.model_dump()["data"])
        return {"ok": True, "msg": "Agenda próxima semana guardada"}
    except ValidationError as e:
        raise HTTPException(400, detail=f"Datos inválidos: {e}")

@app.get("/api/agenda/mes")
async def api_agenda_mes_get(year: int = Query(default=None), month: int = Query(default=None)):
    hoy = date.today()
    y = year or hoy.year
    m = month or hoy.month
    # Validación simple de mes/año
    if not (1 <= m <= 12) or y < 2020:
        raise HTTPException(400, "Mes o año inválido")
    return {"year": y, "month": m, "data": agenda_mes_leer(y, m)}

@app.post("/api/agenda/mes")
async def api_agenda_mes_post(payload: AgendaMesPayload):
    try:
        y = payload.year
        m = payload.month
        if not (1 <= m <= 12) or y < 2020:
            raise HTTPException(400, "Mes o año inválido")
        agenda_mes_guardar(y, m, payload.data)
        return {"ok": True, "msg": "Agenda mensual guardada"}
    except ValidationError as e:
        raise HTTPException(400, detail=f"Datos inválidos: {e}")

@app.get("/api/agenda/historico")
async def api_historico(fecha: str = Query(...)):
    if not es_fecha_valida(fecha):
        raise HTTPException(400, "Formato de fecha inválido (YYYY-MM-DD)")
    if fecha >= date.today().isoformat():
        raise HTTPException(400, "Solo fechas anteriores a hoy")
    return {"fecha": fecha, "entregas": procesar_historico_agenda(fecha)}

@app.get("/api/agenda/dias-anteriores")
async def api_dias_anteriores():
    return {"fechas": dias_anteriores_semana()}

@app.get("/api/historial")
async def api_historial_list():
    return {"fechas": historial_listar()}

@app.get("/api/historial/{fecha}")
async def api_historial_fecha(fecha: str):
    if not es_fecha_valida(fecha):
        raise HTTPException(400, "Formato de fecha inválido")
    snap = historial_leer(fecha)
    if not snap:
        raise HTTPException(404, "No encontrado")
    return snap

@app.post("/api/historial/snap")
async def api_snap():
    try:
        historial_snap()
        return {"ok": True, "msg": "Snapshot guardado"}
    except Exception as e:
        print(f"Error en snap: {e}")
        raise HTTPException(500, "Error interno del servidor")

# Montar archivos estáticos al final, para que las rutas API tengan prioridad
app.mount("/static", StaticFiles(directory=str(DIR_BASE / "static")), name="static_files")
app.mount("/", StaticFiles(directory=str(DIR_BASE), html=True), name="root_static")

# ─────────────────────────────────────────
#  MAIN
# ─────────────────────────────────────────
def main():
    HIST_DIR.mkdir(exist_ok=True)
    if not TMS_API_KEY:
        print("\n  ⚠  ERROR: TMS_API_KEY no configurada en .env\n")
        return
    print(f"\n{'='*56}\n  Dashboard Operativo — Distribución v3 (Seguro)\n{'='*56}")
    print(f"  Monitor:   http://localhost:{PUERTO}/dashboard.html")
    print(f"  Framework: FastAPI + uvicorn (async)")
    print(f"{'='*56}\n")
    uvicorn.run(app, host="0.0.0.0", port=PUERTO, log_level="warning")

if __name__ == "__main__":
    main()