FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV MISE_INSTALL_PATH=/usr/local/bin/mise

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    openssh-client \
    procps \
    build-essential \
    pkg-config \
    libssl-dev \
    unzip \
    xz-utils \
    zip \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://mise.run | sh

RUN mkdir -p /root/.cache /root/.local /workspace

RUN echo 'eval "$(/usr/local/bin/mise activate bash)"' >> /root/.bashrc
RUN echo 'alias vim=nvim' >> /root/.bashrc

WORKDIR /workspace

CMD ["/bin/bash"]
