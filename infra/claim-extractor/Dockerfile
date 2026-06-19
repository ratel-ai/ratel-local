# ClaimExtractor sidecar for Linux + NVIDIA GPU (vLLM backend).
#
# This is the Docker/cloud path. On macOS, Docker cannot reach the Apple GPU —
# use sidecar/run-apple-silicon.sh there instead.
#
# Build:  docker build -t ratel-claim-extractor infra/claim-extractor
# Run:    docker run --gpus all -p 8723:8723 ratel-claim-extractor
FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    CLAIM_EXTRACTOR_BACKEND=vllm \
    CLAIM_EXTRACTOR_MODEL=principled-intelligence/claim-extractor-4B-q-2605 \
    HF_HOME=/models

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY sidecar/requirements.txt ./requirements.txt
RUN pip3 install --upgrade pip \
    && pip3 install -r requirements.txt \
    && pip3 install "orbitals[claim-extractor-vllm]"
# (orbitals[claim-extractor-vllm] is a valid extra; the hf extra is the Apple-Silicon path.)

COPY sidecar/server.py ./server.py

EXPOSE 8723
# Bind 0.0.0.0 inside the container; publish to the host with -p.
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8723"]
