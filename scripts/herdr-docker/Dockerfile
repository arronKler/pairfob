FROM golang:1.26.11-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends python3 procps jq zsh ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /src
ENV GOTOOLCHAIN=local
CMD ["bash", "scripts/herdr-docker/run.sh"]
