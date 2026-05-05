#  Distribution Monitor

Panel operativo en tiempo real para el seguimiento de flotas de distribución.

Interfaz web moderna y segura para visualizar el estado de la distribución diaria: rutas, posicionamiento GPS, agenda de entregas y gestión administrativa. Se conecta a la API de un sistema de gestión de transporte (TMS) externo para obtener datos de vehículos, órdenes y rutas.

![Python](https://img.shields.io/badge/Python-3.x-blue)
![FastAPI](https://img.shields.io/badge/FastAPI-latest-009688)
![License](https://img.shields.io/badge/License-MIT-green)

---

##  Tabla de contenidos

- [¿Qué hace?](#-qué-hace)
- [Tecnologías](#️-tecnologías)
- [Estructura del proyecto](#-estructura-del-proyecto)
- [Instalación](#️-instalación)
- [Uso](#-uso)
- [Seguridad](#-seguridad)
- [Historial y agenda](#️-historial-y-agenda)
- [Exportación CSV](#-exportación-csv)
- [Autor](#-autor)

---

##  ¿Qué hace?

- **Dashboard de KPIs en vivo:** total de pedidos, entregados, pendientes, no entregados, porcentaje de cumplimiento y móviles activos.
- **Estado de flota:** tarjetas por cada móvil con estado (en ruta, detenido, retrasado, etc.), chofer, patente y resumen de entregas.
- **Gráficos interactivos:** evolución de entregas a lo largo del día y distribución por estados (doughnut).
- **Mapa GPS en tiempo real:** posicionamiento de vehículos, trazas de rutas, puntos de parada con estado de visita y popups con detalle.
- **Agenda semanal / quincenal / mensual:** visualización de entregas programadas con estado (programado, en curso, entregado, etc.). Resalta el día actual con datos en vivo.
- **Administración de agenda:** interfaz para agregar, modificar y eliminar entregas por día (semana actual, próxima semana y planificación mensual).
- **Exportación a CSV:** descarga con el estado actual de la flota.
- **Alertas visuales:** notificaciones sobre móviles retrasados, detenidos con pendientes y alta tasa de no entregados.
- **Rotación automática de pantallas:** modo monitor que alterna entre Panel, Mapa y Agenda cada 30 segundos.

---

##  Tecnologías

| Categoría | Tecnología |
|-----------|------------|
| Backend | Python 3 + FastAPI + Uvicorn |
| Frontend | HTML5, CSS3, JavaScript (vanilla) |
| Mapas | Leaflet.js con tiles de CartoDB Voyager |
| Gráficos | Chart.js |
| Validación | Pydantic |
| Almacenamiento | Archivos JSON locales (agenda e histórico) |

---

##  Estructura del proyecto

```
distribution-monitor/
├── servidor.py          # Backend FastAPI (API REST, lógica de negocio, conexión TMS)
├── dashboard.html       # Interfaz principal
├── static/
│   ├── estilos.css      # Diseño oscuro de alto contraste para monitores
│   └── script.js        # Lógica del frontend (fetch, renderizado, agenda, mapa)
├── requirements.txt     # Dependencias Python
├── .env.example         # Plantilla de variables de entorno (sin valores reales)
├── .gitignore
└── README.md
```

---

##  Instalación

### 1. Clonar el repositorio

```bash
git clone https://github.com/JesusVallejos-coder/distribution-monitor.git
cd distribution-monitor
```

### 2. Crear y activar entorno virtual

```bash
python -m venv .venv

# Linux / macOS
source .venv/bin/activate

# Windows PowerShell
.venv\Scripts\Activate.ps1
```

### 3. Instalar dependencias

```bash
pip install -r requirements.txt
```

### 4. Configurar variables de entorno

Copiá `.env.example` y renombralo a `.env`. Completá con los valores reales:

```env
API_KEY=poner_api_key_aqui
BASE_URL=https://api.tu-tms.com
PUERTO=8080
ALLOWED_ORIGINS=http://localhost:8080,http://127.0.0.1:8080
```

> **Nota:** Las claves de API y la URL del TMS son confidenciales. El archivo `.env` no se sube al repositorio (está en `.gitignore`).

### 5. Ejecutar el servidor

```bash
python servidor.py
```

El dashboard estará disponible en `http://localhost:8080/dashboard.html`.

---

##  Uso

1. Abrí la URL en un navegador moderno (Chrome, Edge).
2. **Panel de control:** vista principal con KPIs y tarjetas de móviles.
3. **Mapa GPS:** ubicación en tiempo real de la flota.
4. **Agenda:** planificación semanal, quincenal o mensual. Hacé clic en un día para ver o editar entregas.
5. **Admin:** gestión completa de entregas para la semana actual y la próxima.

> En modo monitor, el sistema rota automáticamente entre las tres pantallas cada 30 segundos. Para salir del modo automático, hacé doble clic sobre la vista.

### Probar sin datos reales

Si no configurás la clave del TMS en el `.env`, la aplicación se iniciará igual pero todos los KPIs y listados aparecerán vacíos, permitiendo explorar la interfaz y la agenda sin depender de un proveedor externo.

---

##  Seguridad

- **Credenciales protegidas:** las claves del TMS se almacenan exclusivamente en `.env`, ignorado por Git.
- **Validación de entradas:** todas las fechas recibidas en la API son validadas contra formato y longitud.
- **Codificación de parámetros:** los datos enviados al TMS se codifican para evitar inyección.
- **Prevención de XSS:** el frontend escapa todo el contenido dinámico.
- **CORS configurable:** orígenes permitidos definidos por variable de entorno.
- **Rate limiting:** protección básica contra abusos en los endpoints de la API.
- **Documentación deshabilitada:** los endpoints `/docs` y `/redoc` están desactivados en producción.
- **Datos locales excluidos:** `agenda*.json` e `historial/` están en `.gitignore`.

---

##  Historial y agenda

Las agendas (semana actual, próxima semana y planificación mensual) se guardan en archivos JSON locales que no se suben al repositorio.

Cada día se genera automáticamente un snapshot del dashboard en la carpeta `historial/` (también ignorada por Git).

---

##  Exportación CSV

Haciendo clic en **"Exportar CSV"** se descarga un archivo con la situación actual de cada móvil: nombre, chofer, patente, estado, pedidos, entregados, pendientes y no entregados.

> Este archivo no incluye datos de clientes finales.

---

##  Autor

**Jesús Vallejos**
GitHub: [@JesusVallejos-coder](https://github.com/JesusVallejos-coder)

---

##  Licencia

Este proyecto está bajo la Licencia MIT. 