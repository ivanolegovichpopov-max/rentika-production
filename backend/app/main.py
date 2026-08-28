from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from app.api.routes import auth, businesses, clients, dashboard, employees, equipment, notes, positions, rentals, twofa
from app.config import settings
from app.core.rate_limit import limiter

app = FastAPI(title="RENTIKA CRM API", version="1.0.0")

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Security-заголовки (HSTS, X-Frame-Options и т.п.) выставляются на уровне
# reverse-proxy (Caddy — см. Caddyfile), не здесь: там же терминируется TLS,
# и заголовки применяются ко всем ответам единообразно, включая статику
# фронтенда, которую этот процесс вообще не обслуживает.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,  # нужно для refresh-cookie
    allow_methods=["*"],
    allow_headers=["*"],
)

# Общий префикс /api — так reverse-proxy (Caddy) может маршрутизировать по
# одному правилу "/api/* -> backend, всё остальное -> статика фронтенда",
# не перечисляя каждый роут отдельно (см. Caddyfile в корне проекта).
API_PREFIX = "/api"

app.include_router(auth.router, prefix=API_PREFIX)
app.include_router(twofa.router, prefix=API_PREFIX)
app.include_router(businesses.router, prefix=API_PREFIX)
app.include_router(positions.router, prefix=API_PREFIX)
app.include_router(employees.router, prefix=API_PREFIX)
app.include_router(equipment.router, prefix=API_PREFIX)
app.include_router(clients.router, prefix=API_PREFIX)
app.include_router(rentals.router, prefix=API_PREFIX)
app.include_router(dashboard.router, prefix=API_PREFIX)
app.include_router(notes.router, prefix=API_PREFIX)


@app.get("/health")
async def health():
    return {"status": "ok"}
