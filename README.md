# claude-bridge-render

Адаптер: Anthropic Messages API -> OpenAI Chat Completions (`api.justwoker.icu`).
Готов к деплою на [Render](https://render.com).

## Локальный запуск

```bash
node server.js
```

Сервер слушает `http://0.0.0.0:8787`:
- `GET  /v1/models` — список моделей (Anthropic-формат)
- `POST /v1/messages` — основной эндпоинт (полный Anthropic-протокол: tools, images, streaming SSE)
- `GET  /health` — health-check для Render

## Переменные окружения

| Переменная | По умолчанию | Описание |
|---|---|---|
| `PORT` | `8787` | Порт (Render задаёт сам) |
| `UPSTREAM_HOST` | `api.justwoker.icu` | Хост провайдера |
| `UPSTREAM_KEY` | ключ из коробки | API-ключ провайдера |
| `UPSTREAM_COMPLETIONS_PATH` | `/v1/completions` | Путь OpenAI-эндпоинта |
| `UPSTREAM_MODELS_PATH` | `/v1/models` | Путь списка моделей |
| `TARGET_MODEL` | `replay-aigateway/claude-opus-4.8` | Модель по умолчанию |

## Деплой на Render

### Способ 1: Blueprint (render.yaml)

1. Запушить репозиторий на GitHub.
2. На Render: **New → Blueprint** → выбрать репозиторий.
3. Render сам создаст Web Service по `render.yaml`.

### Способ 2: Web Service вручную

1. **New → Web Service →** подключить GitHub-репозиторий.
2. **Build Command**: `npm install` (необязательно — зависимостей нет)
3. **Start Command**: `npm start`
4. **Environment Variables** (при необходимости переопределить):
   - `UPSTREAM_KEY`
   - `TARGET_MODEL`
   - `UPSTREAM_HOST`
5. **Health Check Path**: `/health`

Render автоматически задаст `PORT`, сервер слушает `0.0.0.0` — это всё, что нужно.

## Подключение клиента

- **Base URL**: `https://<your-service>.onrender.com`
- **API key**: любой (не проверяется)

Пример для Claude Code / Anthropic-совместимого клиента указывается как `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` (любой).