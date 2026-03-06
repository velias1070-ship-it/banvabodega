# UI/UX — Patrones de Interfaz

## Arquitectura de vistas

- **`/`** — Selector de rol (Operador / Administrador)
- **`/operador`** — Vista mobile-first (max-width 480px), menú grid 2x2: Ingreso, Salida, Traspaso, Stock
- **`/operador/picking`** — Picking Flex para operadores
- **`/operador/recepciones`** — Recepción de mercadería por operadores
- **`/operador/conteos`** — Conteos cíclicos por operadores
- **`/admin`** — Panel con sidebar de tabs (13 secciones: Dashboard, Recepciones, Picking, Pedidos ML, Etiquetas, Conteos, Operaciones, Inventario, Movimientos, Productos, Posiciones, Carga Stock, Config)
- **`/admin/mapa`** — Editor visual del mapa de bodega
- **`/admin/qr-codes`** — Generador/impresión de QR codes

## Design system

### Dark theme obligatorio
Variables CSS en `:root` de `globals.css`:
- Fondos: `--bg: #0a0e17`, `--bg2: #111827`, `--bg3: #1a2234`, `--bg4: #243049`
- Texto: `--txt: #e2e8f0`, `--txt2: #94a3b8`, `--txt3: #64748b`
- Colores semánticos: `--green` (éxito/entrada), `--red` (error/salida), `--blue` (info), `--amber` (warning), `--cyan` (accent/brand)
- Cada color tiene variantes `Bg` (10% opacity) y `Bd` (25% opacity) para fondos y bordes

### Fonts
- **Outfit** — UI general (sans-serif)
- **JetBrains Mono** — Datos numéricos, SKUs, códigos (clase `.mono`)

### Componentes CSS
No se usa ningún component library (no shadcn, no MUI). Todo es CSS custom con clases:
- `.card` — Contenedor con `bg2`, borde `bg4`, border-radius `14px`
- `.topbar` — Barra superior sticky con botón back y título
- `.tabs` / `.tab` — Tabs horizontales scrollables con borde inferior de color
- `.kpi` / `.kpi-grid` — Grid 2 columnas para métricas
- `.tbl` — Tablas con headers uppercase, font-size 12px
- `.scan-btn` — Botones de acción con gradientes (`.green`, `.blue`, `.red`)
- `.form-input` / `.form-label` — Inputs con fondo `bg3`, borde `bg4`
- `.qty-row` / `.qty-btn` — Selector de cantidad con +/- circulares

## Mobile-first para operadores

- Contenedor `.app` con `max-width: 480px; margin: 0 auto`
- `min-height: 100dvh` (dynamic viewport height para móviles)
- `userScalable: false` en viewport meta — la app es tipo PWA
- Manifest.json para instalación como app
- Botones grandes táctiles (padding 28px, font-size 36px para iconos)
- Safe area inset bottom: `padding-bottom: env(safe-area-inset-bottom)`

## Admin layout

- Clase `.app-admin` sin max-width (full width)
- Sidebar con `.admin-sidebar` + `.sidebar-btn` (botones verticales con icono + label)
- Topbar con fecha actual y botón de cerrar sesión

## Patrones de componentes

- Todo es `"use client"` — no hay Server Components
- Estado local con `useState` — no hay estado global (Redux, Zustand, etc.)
- Refresh pattern: `const [,setTick] = useState(0); const r = () => setTick(t => t+1);`
- Polling cada 10s para sync cloud: `setInterval(async () => { await refreshStore(); r(); }, 10_000)`
- Dynamic import para BarcodeScanner: `dynamic(() => import(...), { ssr: false })`
- Inline styles extensivos para variaciones — CSS classes solo para patrones repetidos
- Iconos con emojis nativos (no icon library)
- Estilos inline usan `style={{...}}` con camelCase

## Formularios

- Inputs controlados con `useState`
- Validación inline (no form library)
- `inputMode="numeric"` para campos numéricos en móvil
- Confirmaciones con `window.confirm()`
