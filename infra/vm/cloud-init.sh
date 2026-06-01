#!/bin/bash
# Cloud-init startup script — runs once on VM first boot
# Installs Docker + runs Postgres (pgvector) + Redis + Lakehouse

set -e

# -------------------------------------------------------
# 1. Install Docker
# -------------------------------------------------------
apt-get update -y
apt-get install -y ca-certificates curl gnupg

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  tee /etc/apt/sources.list.d/docker.list > /dev/null

apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

systemctl enable docker
systemctl start docker

# -------------------------------------------------------
# 2. Write docker-compose.yml
# pgvector:pg16 required — project uses vector search for AI/agent features
# -------------------------------------------------------
mkdir -p /opt/saas-infra
mkdir -p /opt/saas-infra/lakehouse

cat > /opt/saas-infra/lakehouse/requirements.txt << 'EOF'
fastapi==0.115.0
uvicorn[standard]==0.30.6
deltalake==0.19.0
pandas==2.2.2
pyarrow==16.1.0
EOF

cat > /opt/saas-infra/lakehouse/main.py << 'PYEOF'
from fastapi import FastAPI
app = FastAPI()

@app.get("/health")
def health():
    return {"status": "ok"}
PYEOF

cat > /opt/saas-infra/lakehouse/Dockerfile << 'EOF'
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY main.py .
EXPOSE 8001
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001"]
EOF

cat > /opt/saas-infra/docker-compose.yml << 'EOF'
version: '3.8'

services:
  postgres:
    image: pgvector/pgvector:pg16
    container_name: project-context-postgres
    restart: always
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: serverless_saas
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 10

  redis:
    image: redis:7-alpine
    container_name: project-context-redis
    restart: always
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 10

  lakehouse:
    build:
      context: ./lakehouse
      dockerfile: Dockerfile
    container_name: saarthi-lakehouse
    restart: unless-stopped
    ports:
      - "8001:8001"
    environment:
      DELTA_PATH: /data/pension_records
    volumes:
      - lakehouse_data:/data

volumes:
  postgres_data:
  lakehouse_data:
EOF

# -------------------------------------------------------
# 3. Start services
# -------------------------------------------------------
cd /opt/saas-infra
docker compose up -d --build

# -------------------------------------------------------
# 4. Wait for Postgres and create project database
# -------------------------------------------------------
echo "Waiting for Postgres to be ready..."
sleep 15

docker exec project-context-postgres psql -U postgres -c "CREATE DATABASE ${db_name};" 2>/dev/null || echo "Database ${db_name} already exists"

echo "Dev infrastructure ready."
echo "Postgres:  localhost:5432"
echo "Redis:     localhost:6379"
echo "Lakehouse: localhost:8001"
