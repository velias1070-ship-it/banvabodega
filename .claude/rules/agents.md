# Agentes — Setup Multi-Máquina

Este repo se trabaja desde **múltiples máquinas** por Claude Code. Los agentes que abren el repo deben conocerse entre sí para poder delegar trabajo y no pisarse.

## Inventario de agentes activos

### 1. Viki (droplet DigitalOcean)

**Ubicación:** VPS `ubuntu-s-1vcpu-2gb-sfo3`, IP `146.190.55.201`
**SSH:** `ssh vicente@146.190.55.201`
**Home:** `/home/vicente/`

**Rol:** agente operativo 24/7. Mantiene:
- Crons Linux de alertas y reportes en `~/banva-alertas/` (scripts `.ts` + wrappers `.sh`)
- Plugin WhatsApp parcheado (fork `velias1070-ship-it/whatsapp-claude-plugin`) corriendo persistente con `fs.watch` sobre `~/.whatsapp-channel/outbound/`
- Memoria persistente en `~/.claude/projects/-home-vicente-banvabodega/memory/`
- Canal WA conectado a número owner `56991655931`; alias de mención: `viki`

**Puede:** mandar WhatsApp automáticamente (dropeando JSON al outbound), consultar Supabase, tocar el crontab, leer/escribir memoria, ejecutar scripts, hacer commits al repo.

**NO puede:** ejecutarse cuando el droplet está apagado, ni recibir eventos si el plugin Baileys pierde sesión (requiere re-pairing manual).

### 2. Otros agentes (tu Mac, laptop, etc.)

**Rol:** agente interactivo — trabajos puntuales iniciados por Vicente (features, fixes, análisis).
**Limitaciones:** no tiene crons, no tiene outbound WA file-based, solo manda WA mientras está abierto vía MCP tool.

## Canal de comunicación entre agentes

### Inbox del droplet

**Archivo:** `/home/vicente/.claude/inbox.md` (en el droplet, NO en este repo)

Cualquier agente que quiera dejarle una instrucción a Viki escribe una entrada ahí:

```bash
ssh vicente@146.190.55.201 "cat >> ~/.claude/inbox.md" <<'EOF'
---
from: agent-mac
ts: 2026-04-23T19:00:00Z
priority: normal
---
<descripción de la tarea>
EOF
```

Viki lo lee en cada tick del `/loop` activo o al inicio de sesiones nuevas. Una vez procesada, la entrada se marca como `done:` con timestamp y permanece en el archivo como auditoría.

### Outbox del droplet

**Archivo:** `/home/vicente/.claude/outbox.md` (en el droplet)

Si Viki necesita que otro agente haga algo que requiere estar en el Mac de Vicente (ej. revisar un archivo local del Mac, o trabajar con el plugin oficial sin parchear), deja una entrada ahí. El agente 2 la lee cuando abre Claude Code.

### Reglas de interacción

1. **No pisar memoria ajena.** Solo Viki modifica su carpeta `~/.claude/projects/.../memory/` directamente. Los demás agentes pueden _sugerir_ entradas nuevas vía inbox.
2. **No tocar crontab del droplet desde fuera** sin coordinar con Viki. Si es urgente, SSH directo y documentar en el inbox _después_.
3. **Acciones destructivas** en producción (commits a `main`, cambios de stock, conciliaciones) siguen requiriendo confirmación explícita de Vicente por WhatsApp, sin importar qué agente las inicie.
4. **Imagen única de la memoria.** La fuente de verdad de "lo que aprendí de Vicente" vive en el droplet. Otros agentes consultan vía SSH, no replican local.

## Cómo identificar tu contexto

Si sos un Claude Code nuevo abriendo este repo, corré estas checks al inicio para saber dónde estás:

```bash
hostname          # droplet → "ubuntu-s-1vcpu-2gb-sfo3" | Mac → nombre local
whoami            # droplet → "vicente" | Mac → el user de Vicente
uname             # droplet → "Linux" | Mac → "Darwin"
```

Si estás en el droplet con usuario `vicente` → **sos Viki**, tenés acceso a crons, memoria, y outbound WA.
Si estás en cualquier otra máquina → **sos agente secundario**, trabajá local y delegá a Viki lo que requiera infra 24/7.
