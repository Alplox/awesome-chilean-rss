# Modos de Validación - Guía Rápida

## `validate_feeds.js`

### 🎯 Modo URL única: `--url <URL>`

Valida un feed o sitio específico sin modificar la BD.

```bash
# Validar un feed RSS directamente
node scripts/core/validate_feeds.js --url https://ejemplo.com/feed.xml

# Validar un sitio (intenta redescubrir feeds)
node scripts/core/validate_feeds.js --url https://ejemplo.com
```

**Salida:**

- Si es feed válido: muestra tipo, cantidad de items
- Si no es feed directo: intenta redescubrir desde el sitio base

---

### 🔭 Modo Watchlist: `--watchlist`

Retest rápido de todos los sitios en la watchlist sin modificar BD.

```bash
# Listar todos los sitios sin feed descubierto aún
node scripts/core/validate_feeds.js --watchlist

# (--update no hace nada en modo watchlist por seguridad)
```

**Salida:**

- Lista de sitios con/sin feed encontrado
- Categorización de errores: no responden, HTTP errors, feed vacío, sin feed RSS
- Al final: qué sitios ahora tienen feed disponible

---

### ✅ Modo sitio específico: `--id <site-id>`

Valida solo un sitio de la BD (sigue existiendo).

```bash
node scripts/core/validate_feeds.js --id ejemplo-cl --update
```

---

### 🔄 Modo completo: Sin opciones

Valida todos los feeds de 'sites' en feeds-database.json.

```bash
# Solo validación (sin cambios)
node scripts/core/validate_feeds.js

# Con actualización
node scripts/core/validate_feeds.js --update
```

---

## `verify-feeds.js`

### 📄 Archivo JSON (modo original)

```bash
node scripts/utils/verify-feeds.js feed-test.json
node scripts/utils/verify-feeds.js feeds-database.json --output resultados.json
```

### 🔗 URL directa (NUEVO)

Auto-detecta si es URL y valida directamente.

```bash
# Feed RSS directamente
node scripts/utils/verify-feeds.js https://ejemplo.com/feed.xml

# Sitio web (detecta hostname)
node scripts/utils/verify-feeds.js https://ejemplo.com
```

---

## Comparativa de modos

| Comando        | Valida       | Modifica BD | Velocidad | Caso de Uso         |
| -------------- | ------------ | ----------- | --------- | ------------------- |
| `--url <URL>`  | 1 feed/sitio | ❌ No       | ⚡ Rápido | Test individual     |
| `--watchlist`  | 101 sitios   | ❌ No       | 🐢 Lento  | Retest watchlist    |
| `--id <id>`    | 1 sitio BD   | ✅ Sí       | ⚡ Rápido | Fix individual      |
| Sin opciones   | Todos (BD)   | ✅ Sí       | 🐢 Lento  | Validación completa |
| `verify --url` | 1 URL        | ❌ No       | ⚡ Rápido | Test feed rápido    |

---

## Scripts Relacionados

- `npm run validate` → `validate_feeds.js` (sin opciones)
- `npm run verify` → `verify-feeds.js feed-test.json`
