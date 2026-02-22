# BANVA Bodega — Sistema de Inventario

Webapp de inventario para bodega con dos interfaces:
- **📱 Operador**: Escaneo rápido, búsqueda de productos, mapa de bodega
- **⚙️ Admin**: Dashboard, gestión de SKUs, ubicaciones, movimientos, conteos cíclicos, alertas

## Deploy en Vercel

### Opción 1: Deploy directo desde GitHub

1. Sube este proyecto a un repo en GitHub:
```bash
cd banva-bodega
git init
git add .
git commit -m "BANVA Bodega v1"
git branch -M main
git remote add origin https://github.com/TU-USUARIO/banva-bodega.git
git push -u origin main
```

2. Ve a [vercel.com](https://vercel.com) → New Project → Import Git Repository
3. Selecciona el repo `banva-bodega`
4. Click "Deploy" — Vercel detecta Next.js automáticamente
5. En 1-2 minutos tienes tu URL: `banva-bodega.vercel.app`

### Opción 2: Deploy con Vercel CLI

```bash
npm i -g vercel
cd banva-bodega
vercel
```

## Instalar como App en el celular

Una vez deployado en Vercel:

### iPhone:
1. Abre la URL en Safari
2. Toca el ícono de compartir (cuadrado con flecha)
3. Selecciona "Agregar a pantalla de inicio"
4. Se instala como app nativa con ícono

### Android:
1. Abre la URL en Chrome
2. Toca los 3 puntos → "Agregar a pantalla de inicio"
3. Se instala como PWA

## Desarrollo local

```bash
npm install
npm run dev
```

Abre http://localhost:3000

## Estructura

```
src/
  app/
    page.tsx          → Selector de rol (Operador/Admin)
    layout.tsx        → Layout con PWA meta tags
    globals.css       → Estilos globales
    operador/
      page.tsx        → Interface del operador (escaneo, búsqueda, mapa)
    admin/
      page.tsx        → Interface del admin (dashboard, SKUs, movimientos, etc)
  lib/
    store.ts          → Estado central con persistencia en localStorage
```

## Datos

Los datos se persisten en localStorage del navegador. Para resetear:
- Abre DevTools → Application → Local Storage → eliminar `banva_store`
