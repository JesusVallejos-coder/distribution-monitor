// script.js – Monitor operativo (seguro y funcional)
// Función de escape para prevenir XSS
function esc(str) {
    if (str === undefined || str === null) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

// Constantes
const CLIENTES_LISTA = ["A","B","C","D","F","G","H","I","J","K"];
const MOVILES_LISTA = ['Móvil 1','Móvil 2','Móvil 3','Móvil 4','Móvil 5','Móvil 6','Móvil 8'];
const ESTADOS_ENTREGA = ['Programado','En curso','Entregado','Parcial','No entregado','Reprogramado'];
const DIAS_BASE = [{dia:"Lunes",corto:"LUN"},{dia:"Martes",corto:"MAR"},{dia:"Miércoles",corto:"MIÉ"},{dia:"Jueves",corto:"JUE"},{dia:"Viernes",corto:"VIE"},{dia:"Sábado",corto:"SÁB"}];
const DIAS_DOW = ["DOM","LUN","MAR","MIÉ","JUE","VIE","SÁB"];
const MESES_ES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];

function generarOpcionesHora(sel) {
    const opts = ['<option value="">— Sin hora —</option>'];
    for (let h = 6; h <= 20; h++) for (const m of [0, 30]) {
        const v = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
        const h12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
        const ap = h < 12 ? 'AM' : 'PM';
        opts.push(`<option value="${v}"${sel === v ? ' selected' : ''}>${String(h12).padStart(2,'0')}:${String(m).padStart(2,'0')} ${ap}</option>`);
    }
    return opts.join('');
}

// Estado global
let S = { kpis:{}, moviles:[], clientes:[], mapa:[], rutas:[], evolucion:[], alertas:[], timestamp:"" };
let AGENDA = [];
let AGENDA_PROX = [];
let HISTORICOS = {};
let diasAnteriores = [];
let AGENDA_MES_CACHE = {};   // clave "YYYY-MM" → { "DD": [entregas] }

let mapaIniciado = false;
let leafletMap = null;
let leafletMarkers = {};
const ROTATE_INTERVAL = 30000;
let currentScreen = 0;
let rotateTimer = null;
let isMonitorMode = true;
let vistaActual = 'operativa';
const SCREENS = ['operativa', 'mapa', 'agenda'];
let adminExpanded = {};
let semanaActual = 'actual';
let filtroEstado = 'todos';
let vistaAgenda = 'semanal';   // 'semanal' | 'quincenal' | 'mensual'
let agendaOffset = 0;          // semanas/quincenas/meses de offset desde hoy
let modalFechaKey = null;      // fecha YYYY-MM-DD del modal abierto
let chartEvolucion = null;
let chartEstados = null;

// ─── Reloj ──────────────────────────────────────────────────────────────────
function tick() {
    document.getElementById('clock').textContent = new Date().toLocaleTimeString('es-PY', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
}
tick();
setInterval(tick, 1000);

function fechaHoy() {
    const f = new Date().toLocaleDateString('es-PY', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
    return f.charAt(0).toUpperCase() + f.slice(1);
}
function diaHoyIdx() {
    return ({1:0, 2:1, 3:2, 4:3, 5:4, 6:5})[new Date().getDay()] ?? -1;
}
function tiempoRelativo(iso) {
    if (!iso) return 'sin dato';
    const min = Math.round((new Date() - new Date(iso)) / 60000);
    if (min < 2) return 'ahora';
    if (min < 60) return `hace ${min}m`;
    return `hace ${Math.round(min / 60)}h`;
}
function fechaAIdx(fechaStr) {
    const d = new Date(fechaStr + 'T12:00:00');
    return ({1:0, 2:1, 3:2, 4:3, 5:4, 6:5})[d.getDay()] ?? -1;
}
function setConn(ok) {
    const el = document.getElementById('conn-status');
    el.className = ok ? 'status-pill' : 'status-pill warning';
    el.innerHTML = `<div class="dot"></div><span>${ok ? 'Conectado' : 'Sin conexión'}</span>`;
}

// ─── Filtros ────────────────────────────────────────────────────────────────
function setFiltro(est, btn) {
    filtroEstado = est;
    document.querySelectorAll('.filtro-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderMoviles();
}

// ─── Alertas ────────────────────────────────────────────────────────────────
function renderAlertas() {
    const bar = document.getElementById('alertas-bar');
    const al = S.alertas || [];
    if (!al.length) {
        bar.innerHTML = '';
        bar.style.marginBottom = '0';
        return;
    }
    bar.style.marginBottom = '12px';
    bar.innerHTML = al.map(a => `<div class="alerta-pill ${esc(a.tipo)}">⚠ <strong>${esc(a.titulo)}</strong>&nbsp;— ${esc(a.detalle)} <span style="opacity:0.5;margin-left:4px;">${esc(a.ts)}</span></div>`).join('');
}

// ─── Gráficos ───────────────────────────────────────────────────────────────
const chartOpts = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
        legend: { display: false },
        tooltip: {
            backgroundColor: 'rgba(6,9,18,0.95)',
            titleColor: '#e2e8f4',
            bodyColor: '#8b9cc0',
            borderColor: 'rgba(56,139,253,0.2)',
            borderWidth: 1
        }
    },
    scales: {
        x: {
            ticks: { color: '#3d5080', font: { size: 9 } },
            grid: { color: 'rgba(56,139,253,0.06)' }
        },
        y: {
            ticks: { color: '#3d5080', font: { size: 9 } },
            grid: { color: 'rgba(56,139,253,0.06)' }
        }
    }
};

function initCharts() {
    const ctx1 = document.getElementById('chart-evolucion').getContext('2d');
    chartEvolucion = new Chart(ctx1, {
        type: 'bar',
        data: {
            labels: [],
            datasets: [
                { label: 'Entregados', data: [], backgroundColor: 'rgba(0,214,143,0.6)', borderColor: '#00d68f', borderWidth: 1 },
                { label: 'No entregados', data: [], backgroundColor: 'rgba(255,77,106,0.4)', borderColor: '#ff4d6a', borderWidth: 1 },
                { label: 'Acumulado', data: [], type: 'line', borderColor: '#388bfd', borderWidth: 2, pointRadius: 2, tension: 0.4, yAxisID: 'y1', fill: false }
            ]
        },
        options: {
            ...chartOpts,
            scales: {
                ...chartOpts.scales,
                y1: {
                    position: 'right',
                    ticks: { color: '#3d5080', font: { size: 9 } },
                    grid: { display: false }
                }
            }
        }
    });

    const ctx2 = document.getElementById('chart-estados').getContext('2d');
    chartEstados = new Chart(ctx2, {
        type: 'doughnut',
        data: {
            labels: ['Entregados', 'Pendientes', 'Parciales', 'No entregados'],
            datasets: [{
                data: [0, 0, 0, 0],
                backgroundColor: ['rgba(0,214,143,0.8)', 'rgba(255,181,71,0.8)', 'rgba(56,139,253,0.8)', 'rgba(255,77,106,0.8)'],
                borderColor: '#060912',
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'right',
                    labels: { color: '#8b9cc0', font: { size: 10 }, boxWidth: 12 }
                },
                tooltip: {
                    backgroundColor: 'rgba(6,9,18,0.95)',
                    titleColor: '#e2e8f4',
                    bodyColor: '#8b9cc0'
                }
            }
        }
    });
}

function updateCharts() {
    const ev = S.evolucion || [];
    if (chartEvolucion) {
        chartEvolucion.data.labels = ev.map(e => e.hora);
        chartEvolucion.data.datasets[0].data = ev.map(e => e.entregados);
        chartEvolucion.data.datasets[1].data = ev.map(e => e.no_entregados);
        chartEvolucion.data.datasets[2].data = ev.map(e => e.acumulado);
        chartEvolucion.update('none');
    }
    const k = S.kpis || {};
    if (chartEstados) {
        chartEstados.data.datasets[0].data = [k.entregados || 0, k.pendientes || 0, k.parciales || 0, k.no_entregados || 0];
        chartEstados.update('none');
    }
}

// ─── Mapa ──────────────────────────────────────────────────────────────────
function createTruckIcon(color, isMoving) {
    const c = isMoving ? color : '#4d5a73';
    return L.divIcon({
        html: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="32" height="32"><path fill="${c}" stroke="${c}" stroke-width="0.5" d="M20,8h-4V6c0-1.1-0.9-2-2-2H4C2.9,4,2,4.9,2,6v10c0,1.1,0.9,2,2,2h1c0,1.7,1.3,3,3,3s3-1.3,3-3h6c0,1.7,1.3,3,3,3s3-1.3,3-3h1v-4L20,8zM6,18.5c-0.8,0-1.5-0.7-1.5-1.5s0.7-1.5,1.5-1.5s1.5,0.7,1.5,1.5S6.8,18.5,6,18.5zM14,10H4V6h10V10zM18,18.5c-0.8,0-1.5-0.7-1.5-1.5s0.7-1.5,1.5-1.5s1.5,0.7,1.5,1.5S18.8,18.5,18,18.5zM20,12h-4v-2h2.5L20,12z"/></svg>`,
        className: '',
        iconSize: [32, 32],
        iconAnchor: [16, 16],
        popupAnchor: [0, -16]
    });
}
function centrarEnMovil(id) {
    const m = leafletMarkers[id];
    if (m) { leafletMap.setView(m.getLatLng(), 15); m.openPopup(); }
}
let mapaRutasLayers = [], mapaWaypointsLayers = [];
function limpiarCapasRutas() {
    mapaRutasLayers.forEach(l => { try { leafletMap.removeLayer(l); } catch (e) {} });
    mapaWaypointsLayers.forEach(l => { try { leafletMap.removeLayer(l); } catch (e) {} });
    mapaRutasLayers = [];
    mapaWaypointsLayers = [];
}
function colorWaypoint(estado, visitado) {
    if (!visitado) return '#3d5080';
    if (estado === 2) return '#00d68f';
    if (estado === 1) return '#ffb547';
    if (estado === 0) return '#ff4d6a';
    return '#4d5a73';
}
function initMapa() {
    if (mapaIniciado) return;
    mapaIniciado = true;
    leafletMap = L.map('mapa-leaflet', { zoomControl: true, attributionControl: true });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
        subdomains: 'abcd',
        maxZoom: 19
    }).addTo(leafletMap);
    setTimeout(() => leafletMap.invalidateSize(), 300);
}
function renderMapaData() {
    if (!mapaIniciado) return;
    limpiarCapasRutas();
    (S.rutas || []).forEach(ruta => {
        const pts = ruta.puntos || [];
        if (pts.length < 2) return;
        mapaRutasLayers.push(L.polyline(pts.map(p => [p.lat, p.lng]), { color: ruta.color, weight: 2.5, opacity: 0.5, dashArray: '6,5' }).addTo(leafletMap));
        pts.forEach((p, idx) => {
            const c = colorWaypoint(p.estado, p.visitado);
            const circ = L.circleMarker([p.lat, p.lng], { radius: p.visitado ? 8 : 6, color: c, fillColor: c, fillOpacity: 0.85, weight: 2 });
            circ.bindPopup(`<div style="font-size:12px;font-family:monospace;"><div style="font-weight:700;">${esc(ruta.nombre)}</div><div>${esc(p.cliente || 'Parada ' + (idx+1))}</div><div style="font-size:10px;color:#8b9cc0;">${p.estado === 2 ? 'Entregado' : p.estado === 1 ? 'Parcial' : p.estado === 0 ? 'No entregado' : 'Pendiente'}${p.hora ? ' · ' + esc(p.hora) : ''}</div></div>`);
            circ.addTo(leafletMap);
            mapaWaypointsLayers.push(circ);
        });
    });

    const bounds = [];
    (S.mapa || []).forEach(v => {
        const latlng = [v.lat, v.lng];
        bounds.push(latlng);
        const isMoving = v.ignicion && v.velocidad > 0;
        const popup = `<div style="font-size:11px;min-width:160px;font-family:'DM Mono',monospace;"><div style="font-weight:800;font-size:14px;margin-bottom:6px;color:${v.color}">${esc(v.nombre)}</div><div style="color:#8b9cc0;margin-bottom:4px;">${esc(v.chofer || 'Sin chofer')}</div><div style="font-size:10px;color:#3d5080;margin-bottom:6px;">${esc(v.patente || '')}</div><div style="display:flex;gap:12px;font-size:11px;"><span style="color:${v.ignicion ? '#00d68f' : '#3d5080'}">${v.ignicion ? '● Motor ON' : '○ Motor OFF'}</span>${v.velocidad > 0 ? `<span style="color:#ffb547">${v.velocidad} km/h</span>` : ''}</div><div style="font-size:9px;color:#3d5080;margin-top:6px;">${tiempoRelativo(v.timestamp)}</div></div>`;
        if (leafletMarkers[v.id]) {
            leafletMarkers[v.id].setLatLng(latlng);
            leafletMarkers[v.id].setIcon(createTruckIcon(v.color, isMoving));
            leafletMarkers[v.id].bindPopup(popup);
        } else {
            leafletMarkers[v.id] = L.marker(latlng, { icon: createTruckIcon(v.color, isMoving) }).bindPopup(popup).addTo(leafletMap);
        }
    });
    if (bounds.length > 0) {
        try { leafletMap.fitBounds(bounds, { padding: [70, 70], maxZoom: 13 }); } catch (e) {}
    }
    document.getElementById('mapa-lista').innerHTML = (S.mapa || []).map(v => `<div class="map-movil-pill" onclick="centrarEnMovil('${esc(v.id)}')"><div class="map-pill-dot" style="background:${v.ignicion ? v.color : '#4d5a73'}"></div><span class="map-pill-name">${esc(v.nombre)}</span><span class="map-pill-sub">${esc(v.chofer || '')}</span>${v.velocidad > 0 ? `<span class="map-pill-sub">· ${v.velocidad}km/h</span>` : ''}</div>`).join('');
    document.getElementById('mapa-leyenda').innerHTML = `<span style="display:flex;align-items:center;gap:4px;font-size:10px;color:#8b9cc0;"><span style="width:8px;height:8px;border-radius:50%;background:#00d68f;display:inline-block;"></span>Entregado</span>`;
    document.getElementById('mapa-upd').textContent = `Actualizado: ${S.timestamp || '--:--:--'}`;
}

// ─── Panel operativo ───────────────────────────────────────────────────────
function renderOperativa() {
    const k = S.kpis || {};
    document.getElementById('p1-fecha').textContent = fechaHoy();
    const pct = k.pct || 0;
    document.getElementById('k-total').textContent = k.total ?? '—';
    document.getElementById('k-ent').textContent = k.entregados ?? '—';
    document.getElementById('k-ent-sub').textContent = `${pct}% del total`;
    document.getElementById('k-pend').textContent = k.pendientes ?? '—';
    document.getElementById('k-noent').textContent = k.no_entregados ?? '—';
    document.getElementById('k-parc-sub').textContent = `${k.parciales || 0} parciales`;
    const pctEl = document.getElementById('k-pct');
    pctEl.textContent = pct + '%';
    pctEl.className = 'kpi-value ' + (pct >= 85 ? 'success' : pct >= 60 ? 'warning' : 'danger');
    document.getElementById('k-mov').textContent = k.activos ?? '—';
    document.getElementById('k-mov-sub').textContent = `de ${k.total_moviles || 0} en flota`;
    renderAlertas();
    renderMoviles();
    renderClientes();
    updateCharts();
}

function renderMoviles() {
    const mg = document.getElementById('moviles-grid');
    const q = document.getElementById('search-movil').value.toLowerCase();
    const labels = { 'en-ruta': 'EN RUTA', 'detenido': 'DETENIDO', 'inactivo': 'INACTIVO', 'retrasado': 'RETRASADO', 'finalizado': 'FINALIZ.' };
    let movs = S.moviles || [];
    if (filtroEstado !== 'todos') movs = movs.filter(m => m.estado === filtroEstado);
    if (q) movs = movs.filter(m => (m.nombre + m.chofer).toLowerCase().includes(q));
    if (!movs.length) {
        mg.innerHTML = `<div style="color:var(--text3);text-align:center;padding:20px;font-size:12px;font-family:var(--mono);grid-column:1/-1;">Sin datos${q || filtroEstado !== 'todos' ? ' (filtro activo)' : ''}</div>`;
        return;
    }
    mg.innerHTML = movs.map(m => `<div class="movil-card ${esc(m.estado)}"><div class="movil-top"><div class="movil-nombre">${esc(m.nombre)}</div><div class="movil-badge ${esc(m.estado)}">${labels[m.estado] || m.estado}</div></div><div class="movil-chofer">${esc(m.chofer || '—')}</div><div class="movil-patente">${esc(m.patente || '—')}</div>${m.total > 0 ? `<div class="movil-stats"><div class="movil-stat"><span class="s">${m.entregado}</span> ok</div><div class="movil-stat"><span class="w">${m.pendiente}</span> pend</div>${m.no_entregado > 0 ? `<div class="movil-stat"><span class="d">${m.no_entregado}</span> x</div>` : ''}</div>` : '<div class="movil-stats" style="font-size:10px;color:var(--text3);">Sin pedidos</div>'}</div>`).join('');
}

function renderClientes() {
    const tb = document.getElementById('clientes-tbl');
    const q = document.getElementById('search-cliente').value.toLowerCase();
    let clis = S.clientes || [];
    if (q) clis = clis.filter(c => c.nombre.toLowerCase().includes(q));
    if (!clis.length) {
        tb.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:16px;color:var(--text3);font-size:12px;">Sin datos</td></tr>`;
        return;
    }
    tb.innerHTML = clis.slice(0, 12).map(c => `<tr><td style="font-weight:600;font-size:13px;">${esc(c.nombre)}</td><td style="font-family:var(--mono);font-size:13px;">${c.total}</td><td><div style="font-size:13px;">${c.entregado}/${c.total}</div><div class="pbar"><div class="pbar-fill" style="width:${c.total > 0 ? Math.round(c.entregado / c.total * 100) : 0}%;background:var(--success);"></div></div></td><td><span class="badge ${esc(c.estado)}">${c.estado === 'completado' ? 'OK' : c.estado === 'pendiente' ? 'PEND' : c.estado === 'demorado' ? 'DEMO' : 'PARC'}</span></td></tr>`).join('');
}

// ─── Exportar CSV ──────────────────────────────────────────────────────────
function exportarCSV() {
    const rows = [['Móvil', 'Chofer', 'Patente', 'Estado', 'Pedidos', 'Entregados', 'Pendientes', 'No Entregados']];
    (S.moviles || []).forEach(m => rows.push([m.nombre, m.chofer, m.patente, m.estado, m.total, m.entregado, m.pendiente, m.no_entregado]));
    const csv = rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent('\ufeff' + csv);
    a.download = `distribucion_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    toast('CSV exportado ✓');
}

// ─── AGENDA – motor de datos ───────────────────────────────────────────────
function getEntregasParaFecha(fechaStr) {
    const hoy = new Date().toISOString().slice(0, 10);
    if (fechaStr < hoy && HISTORICOS[fechaStr]) return HISTORICOS[fechaStr];
    const d = new Date(fechaStr + 'T12:00:00');
    const dow = d.getDay();
    const idx = ({1:0,2:1,3:2,4:3,5:4,6:5})[dow];
    const hoyD = new Date();
    const lunes = new Date(hoyD);
    lunes.setDate(hoyD.getDate() - ((hoyD.getDay() + 6) % 7));
    const sabado = new Date(lunes);
    sabado.setDate(lunes.getDate() + 5);
    const fD = new Date(fechaStr + 'T12:00:00');
    if (fD >= lunes && fD <= sabado && idx !== undefined && AGENDA[idx]) return AGENDA[idx].entregas || [];
    const proxLunes = new Date(lunes);
    proxLunes.setDate(lunes.getDate() + 7);
    const proxSab = new Date(proxLunes);
    proxSab.setDate(proxLunes.getDate() + 5);
    if (fD >= proxLunes && fD <= proxSab && idx !== undefined && AGENDA_PROX[idx]) return AGENDA_PROX[idx].entregas || [];
    const mesKey = fechaStr.slice(0, 7);
    const diaKey = fechaStr.slice(8, 10);
    if (AGENDA_MES_CACHE[mesKey] && AGENDA_MES_CACHE[mesKey][diaKey]) return AGENDA_MES_CACHE[mesKey][diaKey];
    return [];
}

function setEntregasParaFecha(fechaStr, entregas) {
    const mesKey = fechaStr.slice(0, 7);
    const diaKey = fechaStr.slice(8, 10);
    if (!AGENDA_MES_CACHE[mesKey]) AGENDA_MES_CACHE[mesKey] = {};
    AGENDA_MES_CACHE[mesKey][diaKey] = entregas;
    const hoyD = new Date();
    const lunes = new Date(hoyD);
    lunes.setDate(hoyD.getDate() - ((hoyD.getDay() + 6) % 7));
    const sabado = new Date(lunes);
    sabado.setDate(lunes.getDate() + 5);
    const d = new Date(fechaStr + 'T12:00:00');
    const dow = d.getDay();
    const idx = ({1:0,2:1,3:2,4:3,5:4,6:5})[dow];
    if (d >= lunes && d <= sabado && idx !== undefined && AGENDA[idx]) AGENDA[idx].entregas = entregas;
    const proxLunes = new Date(lunes);
    proxLunes.setDate(lunes.getDate() + 7);
    const proxSab = new Date(proxLunes);
    proxSab.setDate(proxLunes.getDate() + 5);
    if (d >= proxLunes && d <= proxSab && idx !== undefined && AGENDA_PROX[idx]) AGENDA_PROX[idx].entregas = entregas;
}

// ─── AGENDA – render principal ─────────────────────────────────────────────
function setVistaAgenda(vista, btn) {
    vistaAgenda = vista;
    agendaOffset = 0;
    document.querySelectorAll('.agt-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderAgenda();
}
function navAgenda(dir) {
    agendaOffset += dir;
    renderAgenda();
}

function getLunesDeSemana(offset) {
    const hoy = new Date();
    const lunes = new Date(hoy);
    lunes.setDate(hoy.getDate() - ((hoy.getDay() + 6) % 7) + offset * 7);
    lunes.setHours(0, 0, 0, 0);
    return lunes;
}
function addDias(base, n) {
    const d = new Date(base);
    d.setDate(d.getDate() + n);
    return d;
}
function toISO(d) {
    return d.toISOString().slice(0, 10);
}

function renderAgenda() {
    const hoyStr = new Date().toISOString().slice(0, 10);
    const container = document.getElementById('agenda-container');
    const subEl = document.getElementById('agenda-sub-texto');
    const badge = document.getElementById('agenda-live-badge');
    if (S.kpis && S.kpis.total > 0) badge.style.display = 'block';
    else badge.style.display = 'none';

    if (vistaAgenda === 'semanal') {
        document.getElementById('agenda-titulo').textContent = 'Agenda Semanal';
        const lunes = getLunesDeSemana(agendaOffset);
        const sabado = addDias(lunes, 5);
        subEl.textContent = `${lunes.toLocaleDateString('es-PY',{day:'2-digit',month:'short'})} — ${sabado.toLocaleDateString('es-PY',{day:'2-digit',month:'short',year:'numeric'})}`;
        const dias = [];
        for (let i = 0; i < 6; i++) dias.push(addDias(lunes, i));
        const hoyIdx = dias.findIndex(d => toISO(d) === hoyStr);
        const cols = dias.map((d, i) => {
            const fechaStr = toISO(d);
            const esHoy = fechaStr === hoyStr;
            const esPasado = fechaStr < hoyStr;
            const entregas = getEntregasParaFecha(fechaStr);
            if (esHoy) {
                const movActivos = (S.moviles || []).filter(m => m.estado !== 'inactivo');
                const clientes = S.clientes || [];
                const k = S.kpis || {};
                const mSec = movActivos.length ? movActivos.map(m => `<div class="live-movil-row"><div class="live-movil-dot" style="background:${m.estado === 'en-ruta' ? 'var(--success)' : 'var(--warning)'}"></div><span class="live-movil-name">${esc(m.nombre)}</span><span class="live-movil-chofer">${esc(m.chofer)}</span><span class="live-movil-stats">${m.entregado}✓</span></div>`).join('') : '<div class="sin-datos-col">Sin activos</div>';
                const cSec = clientes.length ? clientes.slice(0, 6).map(c => `<div class="live-item"><span class="live-item-name">${esc(c.nombre)}</span><span class="live-item-sub">${c.entregado}/${c.total}</span></div>`).join('') : '<div class="sin-datos-col">Sin datos</div>';
                return `<div class="dia-col es-hoy"><div class="dia-col-header"><span class="dia-col-label hoy">HOY — ${d.toLocaleDateString('es-PY',{weekday:'short',day:'2-digit'})}</span><span class="dia-col-count hoy">${k.total || 0} ped.</span></div><div class="dia-col-bar"><div class="dia-col-bar-fill" style="width:${k.pct || 0}%;background:var(--hoy);"></div></div><div class="dia-col-body"><div class="hoy-live-section"><div class="hoy-live-block" style="flex:0 0 auto;"><div class="hoy-live-title">Móviles activos <span class="cnt">${movActivos.length}</span></div><div class="hoy-live-list">${mSec}</div></div><div class="hoy-live-block" style="flex:1;"><div class="hoy-live-title">Clientes <span class="cnt">${clientes.length}</span></div><div class="hoy-live-list">${cSec}</div></div></div></div></div>`;
            }
            const total = entregas.length;
            const body = !total ? `<div class="sin-datos-col">Sin entregas</div>` : entregas.slice(0, 8).map(e => `<div class="ent-card" onclick="abrirModal('${fechaStr}')"><div class="ent-card-top"><span class="ent-cliente">${esc(e.cliente || '—')}</span><span class="ent-movil">${esc(e.movil || '')}</span></div>${e.chofer ? `<div class="ent-chofer">${esc(e.chofer)}</div>` : ''}<span class="ent-estado ${esc((e.estado || 'Programado').replace(/\s+/g, '-'))}">${esc(e.estado || 'Programado')}</span></div>`).join('') + (total > 8 ? `<div class="sin-datos-col">+${total - 8} más — click para ver</div>` : '');
            const addBtn = `<button style="font-size:8px;color:var(--accent);background:none;border:none;cursor:pointer;padding:4px;font-family:var(--mono);" onclick="abrirModal('${fechaStr}')">+ Agregar</button>`;
            return `<div class="dia-col ${esPasado ? 'es-pasado' : ''}"><div class="dia-col-header"><span class="dia-col-label">${d.toLocaleDateString('es-PY',{weekday:'short',day:'2-digit'}).toUpperCase()}</span>${addBtn}</div><div class="dia-col-bar"><div class="dia-col-bar-fill" style="width:${total ? 70 : 5}%;background:${esPasado ? 'var(--success)' : 'var(--inactive)'}"></div></div><div class="dia-col-body">${body}</div></div>`;
        });
        const gtc = dias.map((_, i) => i === hoyIdx ? '2fr' : '1fr').join(' ');
        container.innerHTML = `<div class="agenda-cols" style="grid-template-columns:${gtc};flex:1;">${cols.join('')}</div>`;

    } else if (vistaAgenda === 'quincenal') {
        document.getElementById('agenda-titulo').textContent = 'Agenda Quincenal';
        const lunes = getLunesDeSemana(agendaOffset * 2);
        const fin = addDias(lunes, 13);
        subEl.textContent = `${lunes.toLocaleDateString('es-PY',{day:'2-digit',month:'short'})} — ${fin.toLocaleDateString('es-PY',{day:'2-digit',month:'short',year:'numeric'})}`;
        const dias = [];
        for (let i = 0; i < 14; i++) dias.push(addDias(lunes, i));
        const semanas = [dias.slice(0, 7), dias.slice(7, 14)];
        let html = '<div style="flex:1;display:flex;flex-direction:column;gap:8px;overflow-y:auto;">';
        semanas.forEach((sem, si) => {
            html += `<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:4px;">`;
            if (si === 0) DIAS_DOW.forEach(d => { html += `<div style="font-size:8px;font-weight:700;color:var(--text3);text-align:center;padding:3px 0;font-family:var(--mono);">${d}</div>`; });
            sem.forEach(d => {
                const fechaStr = toISO(d);
                const esHoy = fechaStr === hoyStr;
                const esPasado = fechaStr < hoyStr;
                const ent = getEntregasParaFecha(fechaStr);
                const chips = ent.slice(0, 3).map(e => `<div class="quin-chip ${esc((e.estado || 'Programado').replace(/\s+/g, '-'))}">${esc(e.cliente || '—')}</div>`).join('');
                const mas = ent.length > 3 ? `<div class="quin-day-more">+${ent.length - 3} más</div>` : '';
                html += `<div class="quin-day${esHoy ? ' hoy' : ''}${esPasado ? ' es-pasado' : ''}" onclick="abrirModal('${fechaStr}')"><div class="quin-day-name">${DIAS_DOW[d.getDay()]}</div><div class="quin-day-num">${d.getDate()}</div>${chips}${mas}${!ent.length ? `<div style="font-size:7px;color:var(--text3);font-family:var(--mono);">—</div>` : ''}</div>`;
            });
            html += '</div>';
        });
        html += '</div>';
        container.innerHTML = html;

    } else { // mensual
        const hoy = new Date();
        const year = hoy.getFullYear();
        const month = hoy.getMonth() + agendaOffset;
        const d = new Date(year, month, 1);
        const y = d.getFullYear();
        const m = d.getMonth();
        document.getElementById('agenda-titulo').textContent = `Agenda — ${MESES_ES[m]} ${y}`;
        subEl.textContent = 'Vista mensual';
        const mesKey = `${y}-${String(m + 1).padStart(2, '0')}`;
        if (!AGENDA_MES_CACHE[mesKey]) { fetchAgendaMes(y, m + 1); }
        const primerDia = new Date(y, m, 1);
        const dow = ((primerDia.getDay() + 6) % 7); // lun=0
        const diasEnMes = new Date(y, m + 1, 0).getDate();
        let html = '<div style="flex:1;display:flex;flex-direction:column;overflow:hidden;">';
        html += `<div class="mes-header">${DIAS_DOW.map(d => `<div class="mes-dow">${d}</div>`).join('')}</div>`;
        html += `<div class="mes-grid">`;
        for (let i = 0; i < dow; i++) html += `<div class="mes-day otro-mes"></div>`;
        for (let dia = 1; dia <= diasEnMes; dia++) {
            const fechaStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
            const esHoy = fechaStr === hoyStr;
            const ent = getEntregasParaFecha(fechaStr);
            const colores = { 'Entregado': '#00d68f', 'Programado': '#ffb547', 'En curso': '#388bfd', 'Parcial': '#388bfd', 'No entregado': '#ff4d6a', 'Reprogramado': '#7c3aed' };
            const dots = ent.slice(0, 5).map(e => `<div class="mes-dot" style="background:${colores[e.estado || 'Programado'] || '#3d5080'}"></div>`).join('');
            html += `<div class="mes-day${esHoy ? ' hoy' : ''}" onclick="abrirModal('${fechaStr}')"><div class="mes-day-num">${dia}</div><div class="mes-dots">${dots}</div>${ent.length > 0 ? `<div class="mes-day-count">${ent.length} ent.</div>` : ''}</div>`;
        }
        html += `</div></div>`;
        container.innerHTML = html;
    }
}

// ─── MODAL DÍA ─────────────────────────────────────────────────────────────
function abrirModal(fechaStr) {
    modalFechaKey = fechaStr;
    const d = new Date(fechaStr + 'T12:00:00');
    document.getElementById('modal-dia-titulo').textContent = d.toLocaleDateString('es-PY', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
    renderModalBody();
    document.getElementById('modal-dia').classList.add('open');
}
function cerrarModal() {
    document.getElementById('modal-dia').classList.remove('open');
    modalFechaKey = null;
}
function renderModalBody() {
    const entregas = getEntregasParaFecha(modalFechaKey) || [];
    const mb = document.getElementById('modal-dia-body');
    if (!entregas.length) {
        mb.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text3);font-size:10px;font-family:var(--mono);">Sin entregas — usá el botón + Agregar</div>`;
        return;
    }
    mb.innerHTML = entregas.map((e, i) => `<div style="background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:10px;display:grid;grid-template-columns:2fr 1fr 1fr auto;gap:6px;align-items:end;">
        <div><div class="admin-field-label">Cliente</div><input type="text" id="mdc-${i}" value="${esc(e.cliente || '')}"></div>
        <div><div class="admin-field-label">Móvil</div><select id="mdm-${i}">${['', ...MOVILES_LISTA].map(v => `<option${(e.movil || '') === v ? ' selected' : ''}>${v || '—'}</option>`).join('')}</select></div>
        <div><div class="admin-field-label">Estado</div><select id="mde-${i}">${ESTADOS_ENTREGA.map(s => `<option${(e.estado || 'Programado') === s ? ' selected' : ''}>${s}</option>`).join('')}</select></div>
        <button class="btn-del" onclick="eliminarEntradaModal(${i})">✕</button>
        <div style="grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;">
            <div><div class="admin-field-label">Chofer</div><input type="text" id="mdch-${i}" value="${esc(e.chofer || '')}"></div>
            <div><div class="admin-field-label">Zona</div><input type="text" id="mdz-${i}" value="${esc(e.zona || '')}"></div>
            <div><div class="admin-field-label">Hora</div><select id="mdh-${i}">${generarOpcionesHora(e.hora || '')}</select></div>
        </div>
    </div>`).join('');
}
function agregarEntradaModal() {
    const ent = getEntregasParaFecha(modalFechaKey) || [];
    ent.push({ cliente: '', chofer: '', movil: '', zona: '', hora: '', estado: 'Programado' });
    setEntregasParaFecha(modalFechaKey, ent);
    renderModalBody();
}
function eliminarEntradaModal(i) {
    const ent = [...(getEntregasParaFecha(modalFechaKey) || [])];
    ent.splice(i, 1);
    setEntregasParaFecha(modalFechaKey, ent);
    renderModalBody();
}
async function guardarModal() {
    const ent = getEntregasParaFecha(modalFechaKey) || [];
    const n = ent.length;
    const leidas = [];
    for (let i = 0; i < n; i++) {
        const g = id => { const el = document.getElementById(`${id}-${i}`); return el ? el.value.trim() : ''; };
        leidas.push({ cliente: g('mdc'), movil: g('mdm'), estado: g('mde'), chofer: g('mdch'), zona: g('mdz'), hora: g('mdh') });
    }
    setEntregasParaFecha(modalFechaKey, leidas);
    const mesKey = modalFechaKey.slice(0, 7);
    const [y, m] = mesKey.split('-').map(Number);
    await guardarAgendaMes(y, m);
    cerrarModal();
    renderAgenda();
    toast('Guardado ✓');
}

// ─── Fetch ─────────────────────────────────────────────────────────────────
async function fetchDashboard() {
    try {
        const r = await fetch('/api/dashboard');
        if (!r.ok) throw new Error(r.status);
        S = await r.json();
        setConn(true);
        renderOperativa();
        if (mapaIniciado) renderMapaData();
        renderAgendaMonitor();
    } catch (e) {
        setConn(false);
    }
}
async function fetchAgenda() {
    try {
        const r = await fetch('/api/agenda');
        const d = await r.json();
        AGENDA = d.data || [];
    } catch (e) {}
}
async function fetchAgendaProx() {
    try {
        const r = await fetch('/api/agenda/prox');
        const d = await r.json();
        AGENDA_PROX = d.data || [];
    } catch (e) {}
}
async function fetchAgendaMes(year, month) {
    try {
        const r = await fetch(`/api/agenda/mes?year=${year}&month=${month}`);
        const d = await r.json();
        const key = `${year}-${String(month).padStart(2, '0')}`;
        AGENDA_MES_CACHE[key] = d.data || {};
        renderAgenda();
    } catch (e) {}
}
async function guardarAgendaMes(year, month) {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    const data = AGENDA_MES_CACHE[key] || {};
    try {
        await fetch('/api/agenda/mes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ year, month, data })
        });
    } catch (e) {}
}
async function fetchDiasAnteriores() {
    try {
        const r = await fetch('/api/agenda/dias-anteriores');
        const d = await r.json();
        diasAnteriores = d.fechas || [];
    } catch (e) {}
}
async function fetchHistoricoFecha(fecha) {
    if (HISTORICOS[fecha]) return;
    try {
        const r = await fetch(`/api/agenda/historico?fecha=${fecha}`);
        if (!r.ok) return;
        const d = await r.json();
        HISTORICOS[fecha] = d.entregas || [];
    } catch (e) {}
}
async function cargarHistoricos() {
    await fetchDiasAnteriores();
    await Promise.all(diasAnteriores.map(f => fetchHistoricoFecha(f)));
}
function renderAgendaMonitor() {
    if (vistaActual === 'agenda') renderAgenda();
}

// ─── Admin ─────────────────────────────────────────────────────────────────
function claseEstado(est) {
    return 's-' + (est || 'Programado').replace(/\s+/g, '-');
}
function renderAgendaAdmin() {
    const wrap = document.getElementById('agenda-admin-list');
    const data = semanaActual === 'actual' ? AGENDA : AGENDA_PROX;
    const hoyIdx = diaHoyIdx();
    wrap.innerHTML = data.map((dia, di) => {
        const esPasado = semanaActual === 'actual' && di < hoyIdx;
        const esHoy = semanaActual === 'actual' && di === hoyIdx;
        const tagCls = esHoy ? 'hoy' : esPasado ? 'pasado' : '';
        const tagLabel = esHoy ? 'HOY' : esPasado ? 'Pasado' : 'Próximo';
        const expanded = adminExpanded[`${semanaActual}-${di}`] !== false;
        const rows = !dia.entregas.length ? `<div style="font-size:10px;color:var(--text3);padding:12px;text-align:center;">Sin entregas — + Agregar</div>` : dia.entregas.map((_, ei) => adminRow(di, ei)).join('');
        return `<div class="admin-section"><div class="admin-section-header" onclick="toggleAdminDia('${semanaActual}',${di})"><div class="admin-section-title">${esc(dia.dia)}<span class="admin-dia-tag ${tagCls}">${tagLabel}</span><span style="font-size:9px;color:var(--text3);">${dia.entregas.length} entrega${dia.entregas.length !== 1 ? 's' : ''}</span></div><div style="display:flex;gap:8px;"><button class="btn-link" onclick="event.stopPropagation();addEntrega(${di})">+ Agregar</button><span style="color:var(--text3);">${expanded ? '▲' : '▼'}</span></div></div>${expanded ? `<div class="admin-section-body">${rows}</div>` : ''}</div>`;
    }).join('');
}
function toggleAdminDia(semana, di) {
    const k = `${semana}-${di}`;
    adminExpanded[k] = adminExpanded[k] === false ? true : false;
    renderAgendaAdmin();
}
function adminRow(di, ei) {
    const data = semanaActual === 'actual' ? AGENDA : AGENDA_PROX;
    const e = data[di].entregas[ei];
    const pfx = `${semanaActual}-${di}-${ei}`;
    const dlId = `dl-${pfx}`;
    const mvOpts = ['', ...MOVILES_LISTA].map(m => `<option value="${m}"${(e.movil || '') === m ? ' selected' : ''}>${m || '— Seleccionar —'}</option>`).join('');
    const estOpts = ESTADOS_ENTREGA.map(s => `<option value="${s}"${(e.estado || 'Programado') === s ? ' selected' : ''}>${s}</option>`).join('');
    return `<div class="admin-ent-row"><div><div class="admin-field-label">Cliente</div><datalist id="${dlId}">${CLIENTES_LISTA.map(c => `<option value="${esc(c)}">`).join('')}</datalist><input type="text" id="ecl-${pfx}" list="${dlId}" value="${esc(e.cliente || '')}"></div><div><div class="admin-field-label">Chofer</div><input type="text" id="ech-${pfx}" value="${esc(e.chofer || '')}"></div><div><div class="admin-field-label">Móvil</div><select id="emv-${pfx}">${mvOpts}</select></div><div><div class="admin-field-label">Hora</div><select id="ehr-${pfx}" class="hora-select">${generarOpcionesHora(e.hora || '')}</select></div><div><div class="admin-field-label">Estado</div><select id="eest-${pfx}" class="est-select ${claseEstado(e.estado || 'Programado')}" onchange="actualizarColorEstado(this)">${estOpts}</select></div><button class="btn-del" onclick="delEntrega(${di},${ei})">✕</button></div>`;
}
function actualizarColorEstado(sel) {
    const cs = ['s-Programado', 's-En-curso', 's-Entregado', 's-Parcial', 's-No-entregado', 's-Reprogramado'];
    sel.classList.remove(...cs);
    sel.classList.add(claseEstado(sel.value));
}
function addEntrega(di) {
    const data = semanaActual === 'actual' ? AGENDA : AGENDA_PROX;
    data[di].entregas.push({ cliente: '', chofer: '', movil: '', hora: '', estado: 'Programado' });
    adminExpanded[`${semanaActual}-${di}`] = true;
    renderAgendaAdmin();
}
function delEntrega(di, ei) {
    const data = semanaActual === 'actual' ? AGENDA : AGENDA_PROX;
    data[di].entregas.splice(ei, 1);
    renderAgendaAdmin();
}
function agregarHoy() {
    if (semanaActual === 'actual') {
        const h = diaHoyIdx();
        if (h >= 0 && h < AGENDA.length) { addEntrega(h); toast('Entrega agregada a hoy'); }
    } else {
        addEntrega(0);
        toast('Entrega agregada al lunes');
    }
}
function leerDOM() {
    const data = semanaActual === 'actual' ? AGENDA : AGENDA_PROX;
    data.forEach((dia, di) => {
        dia.entregas.forEach((_, ei) => {
            const pfx = `${semanaActual}-${di}-${ei}`;
            const g = id => { const el = document.getElementById(`${id}${pfx}`); return el ? el.value.trim() : ''; };
            data[di].entregas[ei].cliente = g('ecl');
            data[di].entregas[ei].chofer = g('ech');
            data[di].entregas[ei].movil = g('emv');
            data[di].entregas[ei].hora = g('ehr');
            data[di].entregas[ei].estado = g('eest') || 'Programado';
        });
    });
}
async function guardarAgenda() {
    leerDOM();
    if (semanaActual === 'actual') {
        try {
            const r = await fetch('/api/agenda', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: AGENDA }) });
            const d = await r.json();
            if (d.ok) { toast('Agenda guardada ✓'); renderAgenda(); } else toast('Error');
        } catch (e) { toast('Error de conexión', true); }
    } else {
        try {
            const r = await fetch('/api/agenda/prox', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: AGENDA_PROX }) });
            const d = await r.json();
            if (d.ok) { toast('Agenda próxima guardada ✓'); } else toast('Error');
        } catch (e) { toast('Error de conexión', true); }
    }
}
function cambiarSemanaAdmin() {
    semanaActual = document.getElementById('admin-semana-select').value;
    renderAgendaAdmin();
}

// ─── Navegación ────────────────────────────────────────────────────────────
function gotoView(name, btn) {
    isMonitorMode = false;
    clearTimeout(rotateTimer);
    stopProg();
    vistaActual = name;
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    document.getElementById('view-' + name).classList.add('active');
    if (btn) btn.classList.add('active');
    if (name === 'mapa') { initMapa(); setTimeout(() => leafletMap && leafletMap.invalidateSize(), 200); renderMapaData(); }
    if (name === 'agenda') renderAgenda();
    if (name === 'admin') renderAgendaAdmin();
}
function startMonitor() {
    isMonitorMode = true;
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    clearTimeout(rotateTimer);
    showScreen(0);
}
function showScreen(n) {
    currentScreen = n;
    vistaActual = SCREENS[n];
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-' + SCREENS[n]).classList.add('active');
    if (n === 1) { initMapa(); setTimeout(() => leafletMap && leafletMap.invalidateSize(), 300); renderMapaData(); }
    if (n === 2) renderAgenda();
    startProg();
    if (isMonitorMode) rotateTimer = setTimeout(() => showScreen((n + 1) % SCREENS.length), ROTATE_INTERVAL);
}
function startProg() {
    const b = document.getElementById('prog');
    b.style.transition = 'none';
    b.style.width = '0%';
    requestAnimationFrame(() => requestAnimationFrame(() => {
        b.style.transition = `width ${ROTATE_INTERVAL / 1000}s linear`;
        b.style.width = '100%';
    }));
}
function stopProg() {
    const b = document.getElementById('prog');
    b.style.transition = 'none';
    b.style.width = '0%';
}
function toast(msg, error = false) {
    const el = document.getElementById('toast');
    el.style.background = error ? 'var(--danger-bg)' : 'var(--success-bg)';
    el.style.color = error ? 'var(--danger)' : 'var(--success)';
    el.style.border = `1px solid ${error ? 'var(--danger-border)' : 'var(--success-border)'}`;
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(el._t);
    el._t = setTimeout(() => el.style.opacity = '0', 2800);
}

// ─── Init ──────────────────────────────────────────────────────────────────
initCharts();
async function init() {
    await Promise.all([fetchDashboard(), fetchAgenda(), fetchAgendaProx()]);
    cargarHistoricos();
    const hoy = new Date();
    await fetchAgendaMes(hoy.getFullYear(), hoy.getMonth() + 1);
    setTimeout(() => startMonitor(), 500);
    setInterval(fetchDashboard, 30000);
    setInterval(() => { fetchAgenda(); fetchAgendaProx(); }, 60000);
    setInterval(cargarHistoricos, 600000);
}
document.querySelector('.views').addEventListener('dblclick', () => {
    if (isMonitorMode) {
        clearTimeout(rotateTimer);
        stopProg();
        isMonitorMode = false;
        toast('Modo manual');
    }
});
init();