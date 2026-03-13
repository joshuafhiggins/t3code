FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    git \
    openssh-client \
    pkg-config \
    python3 \
    unzip \
    xz-utils \
    golang-go \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash
ENV BUN_INSTALL=/root/.bun
ENV PATH=${BUN_INSTALL}/bin:/root/.cargo/bin:${PATH}

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal

WORKDIR /workspace
COPY . .

RUN bun install --frozen-lockfile && bun run build

EXPOSE 3773
VOLUME ["/workspace/.t3code-state"]

CMD ["bash", "-lc", "bun run --cwd apps/server start -- --host 0.0.0.0 --port 3773 --state-dir /workspace/.t3code-state --no-browser"]
